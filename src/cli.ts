#!/usr/bin/env node
import { access, chmod, readFile, rename, writeFile } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { loadConfig } from "./config.ts";

const command = process.argv[2] || "help";

async function main(): Promise<void> {
  try {
    if (command === "run") await run();
    else if (command === "doctor") await doctor();
    else if (command === "init") await guidedInit();
    else printHelp();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.message.startsWith("缺少环境变量")) {
      console.error("请运行 npm run init 完成交互式配置。");
    }
    process.exitCode = 1;
  }
}

async function run(): Promise<void> {
  const config = loadConfig();
  const [{ ArkClient }, { startFeishuGateway }, { Gateway }, { GatewayStore }, { FeishuOAuth }] = await Promise.all([
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
      await persistOAuthState(".env", tokens.refreshToken, tokens.expiresAt);
    })().finally(() => { refreshing = undefined; });
    await refreshing;
  };
  let sendReply: (chatId: string, text: string) => Promise<void> = async () => {
    throw new Error("飞书客户端尚未就绪");
  };
  const gateway = new Gateway(store, ark, (chatId, text) => sendReply(chatId, text), {
    agentId: config.arkAgentId,
    environmentId: config.arkEnvironmentId,
    vaultId: config.arkVaultId,
    authorizedUserOpenId: config.feishuUserOpenId,
    beforeCreateSession: ensureCredentialFresh,
    timeoutMs: config.sessionTimeoutMs
  });
  const Lark = await import("@larksuiteoapi/node-sdk");
  const client = new Lark.Client({ appId: config.feishuAppId, appSecret: config.feishuAppSecret });
  sendReply = async (chatId, text) => {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) }
    });
  };
  await startFeishuGateway({ appId: config.feishuAppId, appSecret: config.feishuAppSecret, gateway });
  console.log("Gateway 已启动，正在通过飞书 WebSocket 接收消息。");
}

async function doctor(): Promise<void> {
  const config = loadConfig();
  const { ArkClient } = await import("./ark.ts");
  const ark = new ArkClient(config.arkApiKey, config.arkBaseUrl);
  const agent = await ark.getAgent(config.arkAgentId);
  console.log(`配置有效；已连接 Agent ${agent.id}${agent.version ? ` v${agent.version}` : ""}。`);
  console.log("飞书连接将在 run 命令启动时由官方 SDK 完成鉴权。");
}

async function guidedInit(): Promise<void> {
  if (!stdin.isTTY) throw new Error("交互式 init 需要在终端中运行");
  const output = new MutedOutput();
  const rl = createInterface({ input: stdin, output, terminal: true });
  const ask = async (label: string, defaultValue?: string): Promise<string> => {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = await rl.question(`${label}${suffix}: `);
    return answer.trim() || defaultValue || "";
  };
  const askSecret = async (label: string): Promise<string> => {
    stdout.write(`${label}（输入内容不会显示）: `);
    output.muted = true;
    const answer = await rl.question("");
    output.muted = false;
    stdout.write("\n");
    return answer;
  };
  try {
    if (await fileExists(".env")) {
      const overwrite = (await ask("检测到已有 .env，是否覆盖", "n")).toLowerCase();
      if (overwrite !== "y" && overwrite !== "yes") {
        console.log("已取消，没有修改 .env。");
        return;
      }
    }
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
            scopes: { tenant: ["im:message:send_as_bot"], user: userScopes },
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
      }
    });
    console.log(`已创建飞书办公助手 Agent：${result.agentId}`);
    console.log(`${result.environmentCreated ? "已创建" : "已复用"} Environment：${result.environmentId}`);
    console.log(`配置已安全写入 ${result.envPath}。下一步运行：npm run doctor`);
  } finally {
    output.muted = false;
    rl.close();
  }
}

async function persistOAuthState(path: string, refreshToken: string, expiresAt: number): Promise<void> {
  let content = await readFile(path, "utf8");
  const replace = (key: string, value: string): void => {
    const line = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    content = pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}\n${line}\n`;
  };
  replace("FEISHU_REFRESH_TOKEN", refreshToken);
  replace("FEISHU_ACCESS_TOKEN_EXPIRES_AT", String(expiresAt));
  const temp = `${path}.tmp`;
  await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

function printHelp(): void {
  console.log(`ark-feishu <command>\n\n  init    交互式配置并自动创建 Environment\n  doctor  检查配置并验证方舟 Agent\n  run     启动本地 Gateway`);
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

class MutedOutput extends Writable {
  muted = false;

  _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) stdout.write(chunk, encoding);
    callback();
  }
}

await main();
