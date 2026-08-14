#!/usr/bin/env node
import { existsSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { createInterface, type Interface } from "node:readline/promises";
import { loadConfig, loadConfigFile } from "./config.ts";
import { persistOAuthState } from "./login.ts";
import { getArkagentPaths } from "./paths.ts";

const command = process.argv[2] || "run";

async function main(): Promise<void> {
  try {
    if (command === "run") await run();
    else if (command === "doctor") await doctor();
    else if (command === "init") await guidedInit();
    else if (command === "login") await login();
    else printHelp();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.message.startsWith("缺少环境变量")) {
      console.error("请运行 arkagent init 完成交互式配置。");
    }
    process.exitCode = 1;
  }
}

async function run(): Promise<void> {
  const paths = loadSavedEnvironment();
  const config = loadConfig();
  const [{ ArkClient }, { startFeishuGateway, createFeishuResourceDownloader }, { Gateway }, { GatewayStore }, { FeishuOAuth }] = await Promise.all([
    import("./ark.ts"), import("./feishu.ts"), import("./gateway.ts"), import("./store.ts"), import("./oauth.ts")
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
  const Lark = await import("@larksuiteoapi/node-sdk");
  const client = new Lark.Client({ appId: config.feishuAppId, appSecret: config.feishuAppSecret });
  const sendReply = async (chatId: string, text: string): Promise<void> => {
    const response = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) }
    });
    assertLarkResponse(response, "发送文本消息");
  };
  const gateway = new Gateway(store, ark, sendReply, {
    agentId: config.arkAgentId,
    environmentId: config.arkEnvironmentId,
    vaultId: config.arkVaultId,
    authorizedUserOpenId: config.feishuUserOpenId,
    downloadAttachment: createFeishuResourceDownloader(client),
    beforeCreateSession: ensureCredentialFresh,
    timeoutMs: config.sessionTimeoutMs
  });
  console.log("Gateway 配置：");
  console.log(`- 飞书 App ID：${config.feishuAppId}`);
  console.log(`- 方舟 Agent ID：${config.arkAgentId}`);
  console.log(`- 方舟 Environment ID：${config.arkEnvironmentId}`);
  console.log(`- 授权用户 open_id：${maskIdentity(config.feishuUserOpenId)}`);
  console.log("正在连接飞书 WebSocket；请在该 App 对应的 Bot 会话中发送消息。");
  await startFeishuGateway({ appId: config.feishuAppId, appSecret: config.feishuAppSecret, gateway });
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
    const [{ ArkClient }, { runGuidedInit }, { FeishuOAuth }, Lark, qrModule] = await Promise.all([
      import("./ark.ts"), import("./init.ts"), import("./oauth.ts"), import("@larksuiteoapi/node-sdk"), import("qrcode-terminal")
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
            scopes: { tenant: ["im:message:send_as_bot", "im:message:readonly"], user: userScopes },
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

function loadSavedEnvironment(): ReturnType<typeof getArkagentPaths> {
  const paths = getArkagentPaths();
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
  console.log(`arkagent [command]\n\n  init    交互式认领办公助手\n  login   复用当前 App 重新执行用户 OAuth\n  doctor  检查配置并验证方舟 Agent\n  run     启动本地 Gateway（默认）`);
}

await main();
