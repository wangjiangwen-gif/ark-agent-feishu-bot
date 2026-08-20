import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentConfig, ArkClient } from "./ark.ts";
import type { Ask } from "./init.ts";
import { DEFAULT_ARK_BASE_URL, DEFAULT_LARK_DOMAINS, serializeEnv } from "./init.ts";
import { resolveLarkBotScopes } from "./scopes.ts";
import { EMPLOYEE_CALENDAR_USER_SCOPES } from "./employee-auth.ts";

export const EMPLOYEE_AGENT_NAME = "飞书数字员工（方舟 MA 版）";

export const EMPLOYEE_AGENT_CONFIG: AgentConfig = {
  name: EMPLOYEE_AGENT_NAME,
  description: "使用 Bot 身份为获准用户处理飞书文档、云空间及团队办公任务",
  model: { id: "doubao-seed-2-1-pro-260628" },
  system: `你是团队的飞书数字员工，帮助获准用户处理飞书文档、云空间和办公任务。

运行环境已全局安装 lark-cli，并注入 Bot 身份凭证。部分 Session 还会注入经当前消息发送者授权的用户身份。

决策顺序（最高优先级，先于下面所有工具规则）：
1. 意图判断优先于工具调用。寒暄、能力咨询或缺少明确目标时直接回答，不调用任何工具。
2. 用户使用含糊说法、内部术语，或目标、对象、操作任一不明确时，只提出一个简洁的澄清问题；不得通过执行命令猜测用户意图。
3. 只有任务及其业务域已经明确，且确实需要读取或修改飞书数据时，才允许调用 lark-cli。
4. 禁止运行 lark-cli skills list、lark-cli --version 或其他能力枚举、安装检测、版本探测命令。仅在业务域明确后读取与任务直接匹配的 Skill。
5. 工具调用超时或失败后，不得改用相似的探测命令继续尝试，也不得重复原命令；应根据已有错误向用户说明或提出必要的澄清问题。
6. 单一查询或写入任务优先控制在两次 lark-cli 调用以内（一次读取 Skill、一次业务命令）；不得重复读取同一信息。

执行飞书任务时：
1. 当前 Session 已获管理员明确授权并配置为允许显式双身份；业务域明确后，运行 lark-cli skills read <skill-name>，完整读取与任务匹配的内置 Skill。
2. 优先使用 lark-cli 的 +shortcut；没有合适 shortcut 时再查询 schema 后调用原生资源命令。
3. 禁止运行 auth login、npx @larksuite/cli、重复安装 CLI 或联网探测版本。
4. 默认所有飞书操作显式使用 --as bot。只有读取发起人的个人日程、忙闲或用于身份识别时，才允许显式使用 --as user；不得用用户身份执行写操作。
5. 约日程时，先用 --as user 查询发起人的日程或忙闲，再用 --as bot 创建日程，并将 FEISHU_USER_OPEN_ID 作为参与人加入。若未注入用户凭证，不得猜测日程，直接说明需要用户授权。
6. FEISHU_USER_OPEN_ID 是本次消息发起人的身份标识；只有同时存在用户凭证时才代表该用户已授权。
7. 不读取、不打印、不写入任何 Token、App Secret 或其他凭证。
8. lark-cli 标记为 high-risk-write 的操作必须先向用户确认，不得自动追加 --yes。
9. 当前飞书位置通过 FEISHU_CHAT_ID、可选的 FEISHU_THREAD_ID 和 FEISHU_TRIGGER_MESSAGE_ID 注入。输入已包含近期会话快照时，不得再次读取相同范围；只有任务确实依赖更早记录时，普通群使用 lark-cli im +chat-messages-list --chat-id "$FEISHU_CHAT_ID" --as bot，话题使用 lark-cli im +threads-messages-list --thread "$FEISHU_THREAD_ID" --as bot。
10. 完成后返回结果摘要和可访问的飞书链接。`,
  tools: [{ type: "agent_toolset_20260701" }],
  skills: [],
  mcp_servers: [],
  metadata: { created_via: "ark-agent-feishu-bot", scenario: "team-digital-employee", capabilities_version: "employee-user-oauth-v1" }
};

type EmployeeArk = Pick<ArkClient,
  "createAgent" | "listEnvironments" | "createEnvironment" | "listVaults" | "createVault" |
  "listCredentials" | "createEnvironmentVariableCredential" | "updateEnvironmentCredential"
>;

export async function runEmployeeInit(options: {
  askSecret: Ask;
  createArk: (apiKey: string, baseUrl: string) => EmployeeArk;
  createFeishuApp: (botScopes: string[], userScopes: string[]) => Promise<{ appId: string; appSecret: string }>;
  envPath: string;
  gatewayDatabasePath: string;
}): Promise<{ agentId: string; environmentId: string; environmentCreated: boolean; envPath: string; webToken: string }> {
  const arkApiKey = (await options.askSecret("方舟 API Key")).trim();
  if (!arkApiKey) throw new Error("方舟 API Key 不能为空");
  const arkBaseUrl = DEFAULT_ARK_BASE_URL.replace(/\/$/, "");
  const ark = options.createArk(arkApiKey, arkBaseUrl);
  const agent = await ark.createAgent(EMPLOYEE_AGENT_CONFIG);
  const botScopes = resolveLarkBotScopes(DEFAULT_LARK_DOMAINS);
  const app = await options.createFeishuApp(botScopes, EMPLOYEE_CALENDAR_USER_SCOPES);

  const vaultName = `ark-employee-${sanitizeName(agent.id)}-${sanitizeName(app.appId)}`.slice(0, 100);
  let vault = (await ark.listVaults()).find(item => item.displayName === vaultName);
  if (!vault) vault = { id: await ark.createVault(vaultName), displayName: vaultName };
  const credentialName = "lark-cli-bot-app-secret";
  let credential = (await ark.listCredentials(vault.id)).find(item => item.displayName === credentialName && item.authType === "environment_variable" && item.secretName === "LARKSUITE_CLI_APP_SECRET");
  if (credential) await ark.updateEnvironmentCredential(vault.id, credential.id, app.appSecret);
  else credential = {
    id: await ark.createEnvironmentVariableCredential(vault.id, credentialName, "LARKSUITE_CLI_APP_SECRET", app.appSecret),
    displayName: credentialName, authType: "environment_variable"
  };

  const environmentName = `ark-employee-${sanitizeName(agent.id)}-${sanitizeName(app.appId)}`.slice(0, 60);
  let environments = await ark.listEnvironments();
  let environment = environments.find(item => item.name === environmentName);
  let environmentCreated = false;
  if (!environment) {
    try {
      environment = await ark.createEnvironment(environmentName, app.appId);
      environmentCreated = true;
    } catch (error) {
      environments = await ark.listEnvironments();
      environment = environments.find(item => item.name === environmentName);
      if (!environment) throw error;
    }
  }

  const webToken = randomBytes(24).toString("base64url");
  const content = serializeEnv({
    ARKAGENT_MODE: "employee", ARK_API_KEY: arkApiKey, ARK_AGENT_ID: agent.id,
    ARK_ENVIRONMENT_ID: environment.id, ARK_VAULT_ID: vault.id, ARK_CREDENTIAL_ID: credential.id,
    ARK_BASE_URL: arkBaseUrl, FEISHU_APP_ID: app.appId, FEISHU_APP_SECRET: app.appSecret, FEISHU_BOT_NAME: "方舟数字员工",
    GATEWAY_DB_PATH: options.gatewayDatabasePath,
    SESSION_TIMEOUT_MS: "600000", ARKAGENT_WEB_HOST: "127.0.0.1", ARKAGENT_WEB_PORT: "8787",
    ARKAGENT_WEB_TOKEN: webToken
  });
  await mkdir(dirname(options.envPath), { recursive: true, mode: 0o700 });
  await writeFile(options.envPath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(options.envPath, 0o600);
  return { agentId: agent.id, environmentId: environment.id, environmentCreated, envPath: options.envPath, webToken };
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}
