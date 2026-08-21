#!/usr/bin/env node
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { createInterface, type Interface } from "node:readline/promises";
import { loadConfig, loadConfigFile } from "./config.ts";
import { persistOAuthState } from "./login.ts";
import { getArkagentPaths, getEmployeePaths } from "./paths.ts";
import type { ChannelAdapter, ChannelHistoryMessage, ChannelMessage, ChannelOutbound, ChannelResource } from "./channel.ts";

const command = process.argv[2] || "run";
const employeeCommand = process.argv[3] || "run";

async function main(): Promise<void> {
  try {
    if (command === "run") await run();
    else if (command === "doctor") await doctor();
    else if (command === "init") await guidedInit();
    else if (command === "login") await login();
    else if (command === "employee") {
      if (employeeCommand === "run") await runEmployee();
      else if (employeeCommand === "init") await guidedEmployeeInit();
      else if (employeeCommand === "doctor") await employeeDoctor();
      else if (employeeCommand === "repair-environment") await repairEmployeeEnvironment();
      else printHelp();
    }
    else printHelp();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.message.startsWith("缺少环境变量")) {
      console.error(command === "employee" ? "请运行 arkagent employee init 完成交互式配置。" : "请运行 arkagent init 完成交互式配置。");
    }
    process.exitCode = 1;
  }
}

async function repairEmployeeEnvironment(): Promise<void> {
  const paths = loadSavedEmployeeEnvironment();
  const [{ loadEmployeeConfig }, { ArkClient }] = await Promise.all([import("./config.ts"), import("./ark.ts")]);
  const config = loadEmployeeConfig();
  const ark = new ArkClient(config.arkApiKey, config.arkBaseUrl);
  const requestedId = process.argv[4]?.trim();
  const environment = requestedId
    ? (await ark.listEnvironments()).find(item => item.id === requestedId)
    : await ark.createEnvironment(`ark-employee-repaired-${Date.now()}`, config.feishuAppId);
  if (!environment) throw new Error(`Environment 不存在：${requestedId}`);
  const original = readFileSync(paths.configPath, "utf8");
  const updated = original.replace(/^ARK_ENVIRONMENT_ID=.*$/m, `ARK_ENVIRONMENT_ID=${JSON.stringify(environment.id)}`);
  if (updated === original) throw new Error("配置文件缺少 ARK_ENVIRONMENT_ID，未执行覆盖");
  writeFileSync(paths.configPath, updated, { encoding: "utf8", mode: 0o600 });
  chmodSync(paths.configPath, 0o600);
  console.log(`已创建并切换到新 Environment：${environment.id}`);
}

async function runEmployee(): Promise<void> {
  loadSavedEmployeeEnvironment();
  const [{ loadEmployeeConfig }, { ArkClient }, { Gateway }, { GatewayStore }, { startEmployeeWeb }, { FeishuOAuth }, { EmployeeAuthorizationManager, needsCalendarAuthorization }] = await Promise.all([
    import("./config.ts"), import("./ark.ts"), import("./gateway.ts"), import("./store.ts"), import("./web.ts"), import("./oauth.ts"), import("./employee-auth.ts")
  ]);
  const config = loadEmployeeConfig();
  const store = new GatewayStore(config.databasePath);
  const ark = new ArkClient(config.arkApiKey, config.arkBaseUrl);
  const channel = await createFeishuRuntime(config.feishuAppId, config.feishuAppSecret);
  let botTokenExpiresAt = 0;
  let botTokenRefreshing: Promise<void> | undefined;
  let botTokenCredential = (await ark.listCredentials(config.arkVaultId)).find(item => item.secretName === "LARKSUITE_CLI_TENANT_ACCESS_TOKEN");
  const ensureBotToken = async (): Promise<void> => {
    if (botTokenExpiresAt - Date.now() > 5 * 60_000) return;
    if (!botTokenRefreshing) botTokenRefreshing = (async () => {
      const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: config.feishuAppId, app_secret: config.feishuAppSecret }), signal: AbortSignal.timeout(30_000)
      });
      const payload = await response.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
      if (!response.ok || payload.code || !payload.tenant_access_token) throw new Error(`获取 Bot tenant_access_token 失败：${payload.msg || response.status}`);
      if (botTokenCredential) await ark.updateEnvironmentCredential(config.arkVaultId, botTokenCredential.id, payload.tenant_access_token);
      else botTokenCredential = { id: await ark.createEnvironmentVariableCredential(config.arkVaultId, "lark-cli-bot-tenant-access-token", "LARKSUITE_CLI_TENANT_ACCESS_TOKEN", payload.tenant_access_token), displayName: "lark-cli-bot-tenant-access-token", authType: "environment_variable", secretName: "LARKSUITE_CLI_TENANT_ACCESS_TOKEN" };
      botTokenExpiresAt = Date.now() + Number(payload.expire || 7200) * 1000;
    })().finally(() => { botTokenRefreshing = undefined; });
    await botTokenRefreshing;
  };
  const sendAuthorizationCard = async (message: ChannelMessage, url: string): Promise<void> => {
    const card = { schema: "2.0", config: { width_mode: "default" }, header: { title: { tag: "plain_text", content: "授权查看你的日程" }, subtitle: { tag: "plain_text", content: "仅用于本次数字员工协作" }, template: "blue", icon: { tag: "standard_icon", token: "calendar_outlined" } }, body: { elements: [{ tag: "markdown", content: "为了帮你避开冲突，数字员工需要读取你的日程和忙闲信息。创建日程仍使用数字员工的 Bot 身份，并会邀请你参加。" }, { tag: "button", text: { tag: "plain_text", content: "授权查看日程" }, type: "primary_filled", width: "fill", behaviors: [{ type: "open_url", default_url: url }] }] } };
    await channel.reply(message, { type: "card", card });
  };
  let gateway: InstanceType<typeof Gateway>;
  const auth = new EmployeeAuthorizationManager(
    store,
    ark,
    new FeishuOAuth(config.feishuAppId, config.feishuAppSecret),
    sendAuthorizationCard,
    message => gateway.resume(message),
    message => gateway.resumeWithHandoff(message)
  );
  gateway = new Gateway(store, ark, (message, outbound) => channel.reply(message, outbound), {
    agentId: config.arkAgentId, environmentId: config.arkEnvironmentId, vaultId: config.arkVaultId,
    timeoutMs: config.sessionTimeoutMs, platformAccess: true, downloadAttachment: (resource, message) => channel.download(resource, message),
    streamReply: channel.streamReply, addReaction: channel.addReaction, removeReaction: channel.removeReaction,
    requiresAuthorization: message => needsCalendarAuthorization(message.text), ensureAuthorization: message => auth.ensure(message),
    getUserVaultIds: message => auth.vaultIds(message), beforeCreateSession: ensureBotToken, dualIdentity: true,
    perMessageSessions: true, loadRecentHistory: message => channel.loadRecentHistory?.(message) || Promise.resolve([])
  });
  const web = await startEmployeeWeb({ store, config, botName: config.feishuBotName });
  console.log("数字员工配置：");
  console.log(`- 飞书 App ID：${config.feishuAppId}`);
  console.log(`- 方舟 Agent ID：${config.arkAgentId}`);
  console.log(`- 管理后台：${web.url}`);
  console.log("正在连接飞书 WebSocket；获准用户可私聊 Bot 或在群里 @Bot。");
  const syntheticText = process.env.ARKAGENT_SYNTHETIC_MESSAGE?.trim();
  if (syntheticText) {
    const recent = store.listAuditLogs(1)[0];
    if (!recent) throw new Error("没有可用于模拟输入的历史会话，请先给数字员工发送一条普通消息");
    console.log(`正在向最近会话注入 Gateway 测试消息：${syntheticText}`);
    gateway.accept({
      channelType: "lark", installationId: config.feishuAppId,
      eventId: `synthetic-${Date.now()}`, messageId: `synthetic-${Date.now()}`,
      conversationId: recent.chatId, conversationType: "direct", threadId: "", rootMessageId: "", parentMessageId: "",
      createTime: Date.now(), senderId: recent.openId,
      tenantId: recent.tenantKey, text: syntheticText, resources: [], mentionedBot: false
    });
  }
  try {
    await channel.start(message => gateway.accept(message));
  } catch (error) {
    web.server.close();
    store.close();
    throw error;
  }
}

async function employeeDoctor(): Promise<void> {
  loadSavedEmployeeEnvironment();
  const [{ loadEmployeeConfig }, { ArkClient }] = await Promise.all([import("./config.ts"), import("./ark.ts")]);
  const config = loadEmployeeConfig();
  const agent = await new ArkClient(config.arkApiKey, config.arkBaseUrl).getAgent(config.arkAgentId);
  console.log(`数字员工配置有效；已连接 Agent ${agent.id}${agent.version ? ` v${agent.version}` : ""}。`);
  console.log(`WebUI 将监听 http://${config.webHost}:${config.webPort}/。`);
}

async function run(): Promise<void> {
  const paths = loadSavedEnvironment();
  const config = loadConfig();
  const [{ ArkClient }, { Gateway }, { GatewayStore }, { FeishuOAuth }] = await Promise.all([
    import("./ark.ts"), import("./gateway.ts"), import("./store.ts"), import("./oauth.ts")
  ]);
  const store = new GatewayStore(config.databasePath);
  const ark = new ArkClient(config.arkApiKey, config.arkBaseUrl);
  const oauth = new FeishuOAuth(config.feishuAppId, config.feishuAppSecret);
  let tokens = { accessToken: "", refreshToken: config.feishuRefreshToken, expiresAt: config.feishuAccessTokenExpiresAt };
  let refreshing: Promise<void> | undefined;
  const ensureCredentialFresh = async (): Promise<void> => {
    if (tokens.expiresAt - Date.now() > 5 * 60_000) return;
    if (!refreshing) refreshing = (async () => {
      tokens = await oauth.refresh(tokens.refreshToken);
      await ark.updateEnvironmentCredential(config.arkVaultId, config.arkCredentialId, tokens.accessToken);
      await persistOAuthState(paths.configPath, tokens);
    })().finally(() => { refreshing = undefined; });
    await refreshing;
  };
  const channel = await createFeishuRuntime(config.feishuAppId, config.feishuAppSecret);
  const gateway = new Gateway(store, ark, (message, outbound) => channel.reply(message, outbound), {
    agentId: config.arkAgentId,
    environmentId: config.arkEnvironmentId,
    vaultId: config.arkVaultId,
    authorizedUserId: config.feishuUserOpenId,
    downloadAttachment: (resource, message) => channel.download(resource, message),
    streamReply: channel.streamReply,
    addReaction: channel.addReaction,
    removeReaction: channel.removeReaction,
    beforeCreateSession: ensureCredentialFresh,
    timeoutMs: config.sessionTimeoutMs
  });
  console.log("Gateway 配置：");
  console.log(`- 飞书 App ID：${config.feishuAppId}`);
  console.log(`- 方舟 Agent ID：${config.arkAgentId}`);
  console.log(`- 方舟 Environment ID：${config.arkEnvironmentId}`);
  console.log(`- 授权用户 open_id：${maskIdentity(config.feishuUserOpenId)}`);
  console.log("正在连接飞书 WebSocket；请在该 App 对应的 Bot 会话中发送消息。");
  await channel.start(message => gateway.accept(message));
}

type FeishuRuntime = {
  transport: "channel" | "legacy";
  start(handler: (message: ChannelMessage) => void): Promise<void>;
  stop(): Promise<void>;
  reply(message: ChannelMessage, outbound: ChannelOutbound): Promise<void>;
  streamReply?: (message: ChannelMessage, producer: (update: (snapshot: string) => Promise<void>) => Promise<void>) => Promise<void>;
  addReaction?: (message: ChannelMessage, emojiType: string) => Promise<string>;
  removeReaction?: (message: ChannelMessage, reactionId: string) => Promise<void>;
  loadRecentHistory?: (message: ChannelMessage) => Promise<ChannelHistoryMessage[]>;
  download(resource: ChannelResource, message: ChannelMessage): Promise<{ bytes: Uint8Array; mimeType: string }>;
};

async function createFeishuRuntime(appId: string, appSecret: string): Promise<FeishuRuntime> {
  const transport = process.env.ARKAGENT_FEISHU_TRANSPORT === "legacy" ? "legacy" : "channel";
  if (transport === "channel") {
    const { LarkChannelAdapter } = await import("./lark-channel.ts");
    const adapter: ChannelAdapter = new LarkChannelAdapter({ appId, appSecret });
    console.log("飞书接入层：Channel SDK（设置 ARKAGENT_FEISHU_TRANSPORT=legacy 可临时回退）");
    return {
      transport,
      start: handler => adapter.start(handler),
      stop: () => adapter.stop(),
      reply: (message, outbound) => adapter.reply(message, outbound),
      streamReply: (message, producer) => adapter.streamReply(message, producer),
      addReaction: (message, emojiType) => adapter.addReaction(message, emojiType),
      removeReaction: (message, reactionId) => adapter.removeReaction(message, reactionId),
      loadRecentHistory: message => adapter.loadRecentHistory?.(message) || Promise.resolve([]),
      download: (resource, message) => adapter.download(resource, message)
    };
  }
  const [{ startLegacyFeishuChannel, createFeishuResourceDownloader }, { loadLarkRecentHistory }, Lark] = await Promise.all([
    import("./feishu.ts"), import("./lark-channel.ts"), import("@larksuiteoapi/node-sdk")
  ]);
  const client = new Lark.Client({ appId, appSecret });
  const download = createFeishuResourceDownloader(client);
  console.warn("飞书接入层：旧版 node-sdk；建议仅在 Channel SDK 异常时临时使用。");
  return {
    transport,
    start: handler => startLegacyFeishuChannel({ appId, appSecret, onMessage: handler }),
    stop: async () => undefined,
    reply: async (message, outbound) => {
      const msgType = outbound.type === "card" ? "interactive" : "text";
      const content = outbound.type === "card" ? JSON.stringify(outbound.card) : JSON.stringify({ text: outbound.type === "markdown" ? outbound.markdown : outbound.text });
      const response = await client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: message.conversationId, msg_type: msgType, content } });
      assertLarkResponse(response, outbound.type === "card" ? "发送授权卡片" : "发送文本消息");
    },
    loadRecentHistory: message => loadLarkRecentHistory(client, message),
    download
  };
}

function maskIdentity(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 5)}***${value.slice(-3)}`;
}

function assertLarkResponse(response: { code?: number; msg?: string }, action: string): void {
  if (response.code && response.code !== 0) throw new Error(`${action}失败：${response.msg || `code ${response.code}`}`);
}

async function doctor(): Promise<void> {
  loadSavedEnvironment();
  const config = loadConfig();
  const { ArkClient } = await import("./ark.ts");
  const ark = new ArkClient(config.arkApiKey, config.arkBaseUrl);
  const agent = await ark.getAgent(config.arkAgentId);
  console.log(`配置有效；已连接 Agent ${agent.id}${agent.version ? ` v${agent.version}` : ""}。`);
  console.log("飞书连接将在 run 命令启动时由官方 SDK 完成鉴权。");
}

async function login(): Promise<void> {
  const paths = loadSavedEnvironment();
  const config = loadConfig();
  const [{ ArkClient }, { FeishuOAuth }, { runLoginFlow }, { resolveLarkUserScopes }, { DEFAULT_LARK_DOMAINS }, { GatewayStore }, qrModule] = await Promise.all([
    import("./ark.ts"), import("./oauth.ts"), import("./login.ts"), import("./scopes.ts"), import("./init.ts"), import("./store.ts"), import("qrcode-terminal")
  ]);
  const qr = qrModule.default || qrModule;
  const oauth = new FeishuOAuth(config.feishuAppId, config.feishuAppSecret);
  const ark = new ArkClient(config.arkApiKey, config.arkBaseUrl);
  const domains = process.env.LARK_CLI_DOMAINS || DEFAULT_LARK_DOMAINS;
  const scopes = resolveLarkUserScopes(domains);
  console.log(`正在复用飞书 App ${config.feishuAppId} 重新授权，不会创建新的 App、Agent 或 Environment。`);
  const result = await runLoginFlow({
    oauth,
    ark,
    vaultId: config.arkVaultId,
    credentialId: config.arkCredentialId,
    configPath: paths.configPath,
    scopes,
    onAuthorizationReady: device => {
      console.log("请使用飞书扫码，重新授权 lark-cli 以你的用户身份访问飞书：");
      qr.generate(device.verificationUrl, { small: true });
      console.log(`如果二维码无法扫描，请打开：${device.verificationUrl}`);
      const expiresIn = Math.max(0, Math.ceil((device.expiresAt - Date.now()) / 1000));
      console.log(`链接将在约 ${expiresIn} 秒后失效。`);
    },
    invalidateSessions: () => {
      const store = new GatewayStore(config.databasePath);
      try { return store.resetAllSessions(); }
      finally { store.close(); }
    }
  });
  console.log(`登录完成；授权用户 open_id：${maskIdentity(result.userOpenId)}`);
  console.log(`本地 OAuth 状态和方舟 Vault Credential 已更新；已废弃 ${result.invalidatedSessions} 个旧 Session 映射。`);
  console.log("请重启正在运行的 Gateway，或运行 arkagent 启动；下一条消息会创建新 Session。");
}

async function guidedInit(): Promise<void> {
  if (!stdin.isTTY) throw new Error("交互式 init 需要在终端中运行");
  let rl: Interface | undefined;
  const getReadline = (): Interface => {
    if (!rl) rl = createInterface({ input: stdin, output: stdout, terminal: true });
    return rl;
  };
  const ask = async (label: string, defaultValue?: string): Promise<string> => {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = await getReadline().question(`${label}${suffix}: `);
    return answer.trim() || defaultValue || "";
  };
  const askSecret = async (label: string): Promise<string> => {
    return readMaskedInput(`${label}（输入内容以 • 显示）: `);
  };
  try {
    const paths = getArkagentPaths();
    const [{ ArkClient }, { runGuidedInit }, { FeishuOAuth }, { resolveLarkBotScopes }, Lark, qrModule] = await Promise.all([
      import("./ark.ts"), import("./init.ts"), import("./oauth.ts"), import("./scopes.ts"), import("@larksuiteoapi/node-sdk"), import("qrcode-terminal")
    ]);
    const qr = qrModule.default || qrModule;
    const result = await runGuidedInit({
      ask,
      askSecret,
      createArk: (apiKey, baseUrl) => new ArkClient(apiKey, baseUrl),
      createFeishuApp: async userScopes => {
        console.log("即将创建或选择飞书智能体应用，请使用飞书扫码确认。");
        const credentials = await Lark.registerApp({
          source: "ark-agent-feishu-bot",
          appPreset: { name: "方舟 Agent Bot", desc: "由方舟 Managed Agents 驱动的飞书机器人" },
          addons: {
            scopes: { tenant: resolveLarkBotScopes(""), user: userScopes },
            events: { items: { tenant: ["im.message.receive_v1"] } }
          },
          onQRCodeReady(info) {
            qr.generate(info.url, { small: true });
            console.log(`如果二维码无法扫描，请打开：${info.url}`);
            console.log(`链接将在 ${info.expireIn} 秒后失效。`);
          }
        });
        return { appId: credentials.client_id, appSecret: credentials.client_secret, userOpenId: credentials.user_info?.open_id };
      },
      authorizeUser: async (app, userScopes) => {
        const oauth = new FeishuOAuth(app.appId, app.appSecret);
        const device = await oauth.begin(userScopes);
        console.log("请再次扫码，授权 lark-cli 以你的用户身份访问飞书：");
        qr.generate(device.verificationUrl, { small: true });
        console.log(`如果二维码无法扫描，请打开：${device.verificationUrl}`);
        const tokens = await oauth.poll(device);
        const userOpenId = await oauth.getUserOpenId(tokens.accessToken);
        return { tokens, userOpenId };
      },
      envPath: paths.configPath,
      gatewayDatabasePath: paths.databasePath
    });
    console.log(`已创建飞书办公助手 Agent：${result.agentId}`);
    console.log(`${result.environmentCreated ? "已创建" : "已复用"} Environment：${result.environmentId}`);
    console.log(`配置已安全写入 ${result.envPath}。`);
    console.log("初始化完成，正在启动 Gateway…");
    await run();
  } finally {
    rl?.close();
  }
}

async function guidedEmployeeInit(): Promise<void> {
  if (!stdin.isTTY) throw new Error("交互式 employee init 需要在终端中运行");
  const paths = getEmployeePaths();
  const [{ ArkClient }, { runEmployeeInit }, Lark, qrModule] = await Promise.all([
    import("./ark.ts"), import("./employee-init.ts"), import("@larksuiteoapi/node-sdk"), import("qrcode-terminal")
  ]);
  const qr = qrModule.default || qrModule;
  const result = await runEmployeeInit({
    askSecret: async label => readMaskedInput(`${label}（输入内容以 • 显示）: `),
    createArk: (apiKey, baseUrl) => new ArkClient(apiKey, baseUrl),
    createFeishuApp: async (botScopes, userScopes) => {
      console.log("即将创建飞书数字员工应用，请使用飞书扫码确认。");
      const credentials = await Lark.registerApp({
        source: "arkagent-employee",
        appPreset: { name: "方舟数字员工", desc: "使用 Bot 身份工作的方舟 Managed Agents 数字员工" },
        addons: {
          scopes: { tenant: botScopes, user: userScopes },
          events: { items: { tenant: ["im.message.receive_v1"] } }
        },
        onQRCodeReady(info) {
          qr.generate(info.url, { small: true });
          console.log(`如果二维码无法扫描，请打开：${info.url}`);
          console.log(`链接将在 ${info.expireIn} 秒后失效。`);
        }
      });
      return { appId: credentials.client_id, appSecret: credentials.client_secret };
    },
    envPath: paths.configPath,
    gatewayDatabasePath: paths.databasePath
  });
  console.log(`已创建数字员工 Agent：${result.agentId}`);
  console.log(`${result.environmentCreated ? "已创建" : "已复用"} Environment：${result.environmentId}`);
  console.log(`配置已安全写入 ${result.envPath}。`);
  console.log("权限管理复用飞书应用可用范围。");
  console.log("建议企业管理员前往：飞书管理后台 > 工作台 > 应用管理 > 方舟数字员工 > 应用可用范围，开启“允许不在可用范围内的成员申请使用应用”。");
  console.log("初始化完成，正在启动数字员工…");
  await runEmployee();
}

function loadSavedEnvironment(): ReturnType<typeof getArkagentPaths> {
  const paths = getArkagentPaths();
  if (existsSync(paths.configPath)) loadConfigFile(paths.configPath);
  return paths;
}

function loadSavedEmployeeEnvironment(): ReturnType<typeof getEmployeePaths> {
  const paths = getEmployeePaths();
  if (existsSync(paths.configPath)) loadConfigFile(paths.configPath);
  return paths;
}

async function readMaskedInput(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") throw new Error("安全输入需要在终端中运行");
  stdout.write(prompt);
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    const chars: string[] = [];
    const finish = (error?: Error): void => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(chars.join(""));
    };
    const onKeypress = (value: string, key: { name?: string; ctrl?: boolean; meta?: boolean }): void => {
      if (key.ctrl && key.name === "c") return finish(new Error("初始化已取消"));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") {
        if (chars.length > 0) {
          chars.pop();
          stdout.write("\b \b");
        }
        return;
      }
      if (key.ctrl || key.meta || !value) return;
      const input = Array.from(value).filter(char => char >= " " && char !== "\u007f");
      chars.push(...input);
      stdout.write("•".repeat(input.length));
    };
    stdin.on("keypress", onKeypress);
  });
}

function printHelp(): void {
  console.log(`arkagent [command]\n\n个人助手：\n  init             交互式认领办公助手\n  login            复用当前 App 重新执行用户 OAuth\n  doctor           检查配置并验证方舟 Agent\n  run              启动个人助手 Gateway（默认）\n\n数字员工：\n  employee init                创建 Bot 身份数字员工\n  employee                     启动数字员工 Gateway 与 WebUI\n  employee doctor              检查数字员工配置\n  employee repair-environment  重建并切换数字员工运行环境`);
}

await main();
