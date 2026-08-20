import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentConfig, ArkClient } from "./ark.ts";
import type { OAuthTokens } from "./oauth.ts";
import { resolveLarkUserScopes } from "./scopes.ts";

export type Ask = (label: string, defaultValue?: string) => Promise<string>;

export const OFFICE_AGENT_NAME = "飞书办公助手（方舟 MA 版）";
export const DEFAULT_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const DEFAULT_LARK_DOMAINS = "docs,drive";

export const OFFICE_AGENT_CONFIG: AgentConfig = {
  name: OFFICE_AGENT_NAME,
  description: "以用户身份使用 lark-cli 处理飞书文档、云空间及常见办公任务",
  model: { id: "doubao-seed-2-1-pro-260628" },
  system: `你是飞书办公助手，帮助用户处理飞书文档、云空间和日常办公任务。

运行环境已全局安装 lark-cli，并通过 LARKSUITE_CLI_APP_ID 与 LARKSUITE_CLI_USER_ACCESS_TOKEN 注入用户身份凭证。所有飞书操作默认使用 user 身份。

决策顺序（最高优先级，先于下面所有工具规则）：
1. 意图判断优先于工具调用。寒暄、能力咨询或缺少明确目标时直接回答，不调用任何工具。
2. 用户使用含糊说法、内部术语，或目标、对象、操作任一不明确时，只提出一个简洁的澄清问题；不得通过执行命令猜测用户意图。
3. 只有任务及其业务域已经明确，且确实需要读取或修改飞书数据时，才允许调用 lark-cli。
4. 禁止运行 lark-cli skills list、lark-cli --version 或其他能力枚举、安装检测、版本探测命令。仅在业务域明确后读取与任务直接匹配的 Skill。
5. 工具调用超时或失败后，不得改用相似的探测命令继续尝试，也不得重复原命令；应根据已有错误向用户说明或提出必要的澄清问题。
6. 单一查询或写入任务优先控制在两次 lark-cli 调用以内（一次读取 Skill、一次业务命令）；不得重复读取同一信息。

执行飞书任务时：
1. 首次处理某业务域且本提示词未给出确定命令时，运行 lark-cli skills read <skill-name>，完整读取匹配的内置 Skill并遵循其工作流；同一 Session 已读取过该 Skill，或本提示词已经给出可直接使用的确定命令时，跳过重复读取。
2. 优先使用 lark-cli 的 +shortcut；没有合适 shortcut 时再查询 schema 后调用原生资源命令。
3. 禁止运行 npx @larksuite/cli、重复安装 CLI 或联网探测版本。
4. 外部 Credential 模式不支持交互式 auth 管理；不要运行 auth login 或用 auth status 判断凭证不可用。权限不足时，向用户返回 missing_scopes 与需要重新授权的业务域。
5. 不读取、不打印、不写入任何 token、App Secret 或其他凭证。不要在回复中暴露 shell 命令和敏感环境变量。
6. 用户明确要求的普通办公写操作可以直接执行；lark-cli 标记为 high-risk-write 的操作必须先向用户确认。
7. 完成后返回结果摘要和可访问的飞书链接。`,
  tools: [{ type: "agent_toolset_20260701" }],
  skills: [],
  mcp_servers: [],
  metadata: { created_via: "ark-agent-feishu-bot", scenario: "personal-feishu-office" }
};

export async function runGuidedInit(options: {
  ask: Ask;
  askSecret: Ask;
  createArk: (apiKey: string, baseUrl: string) => Pick<ArkClient, "createAgent" | "listEnvironments" | "createEnvironment" | "listVaults" | "createVault" | "listCredentials" | "createEnvironmentCredential" | "updateEnvironmentCredential">;
  createFeishuApp: (userScopes: string[]) => Promise<{ appId: string; appSecret: string; userOpenId?: string }>;
  authorizeUser: (app: { appId: string; appSecret: string }, userScopes: string[]) => Promise<{ tokens: OAuthTokens; userOpenId: string }>;
  envPath?: string;
  gatewayDatabasePath?: string;
}): Promise<{ agentId: string; environmentId: string; environmentCreated: boolean; envPath: string }> {
  const arkApiKey = await requiredSecret(options.askSecret, "方舟 API Key");
  const arkBaseUrl = DEFAULT_ARK_BASE_URL;
  const ark = options.createArk(arkApiKey, arkBaseUrl.replace(/\/$/, ""));
  // 个人级初始化每次都创建新的办公助手；创建是非幂等操作，失败后不自动重试。
  const agent = await ark.createAgent(OFFICE_AGENT_CONFIG);
  const larkDomains = DEFAULT_LARK_DOMAINS;
  const userScopes = resolveLarkUserScopes(larkDomains);
  const feishuApp = await options.createFeishuApp(userScopes);
  const authorization = await options.authorizeUser(feishuApp, userScopes);
  if (feishuApp.userOpenId && feishuApp.userOpenId !== authorization.userOpenId) {
    throw new Error("创建应用和用户授权使用了不同的飞书账号，请重新运行 init 并使用同一账号扫码");
  }

  const vaultName = `ark-feishu-${sanitizeName(agent.id)}-${sanitizeName(authorization.userOpenId)}`.slice(0, 100);
  let vault = (await ark.listVaults()).find(item => item.displayName === vaultName);
  if (!vault) vault = { id: await ark.createVault(vaultName), displayName: vaultName };
  const credentialName = "lark-cli-user-access-token";
  let credential = (await ark.listCredentials(vault.id)).find(item => item.displayName === credentialName && item.authType === "environment_variable");
  if (credential) await ark.updateEnvironmentCredential(vault.id, credential.id, authorization.tokens.accessToken);
  else credential = { id: await ark.createEnvironmentCredential(vault.id, credentialName, authorization.tokens.accessToken), displayName: credentialName, authType: "environment_variable" };

  // App ID 是 Environment 配置的一部分，因此名称也包含 App ID，避免重跑 init 时误复用旧应用的 Environment。
  const suggestedName = `ark-feishu-${sanitizeName(agent.id)}-${sanitizeName(feishuApp.appId)}`.slice(0, 60);
  const environmentName = suggestedName;

  let environments = await ark.listEnvironments();
  let environment = environments.find(item => item.name === environmentName);
  let environmentCreated = false;
  if (!environment) {
    try {
      environment = await ark.createEnvironment(environmentName, feishuApp.appId);
      environmentCreated = true;
    } catch (error) {
      // 创建是非幂等操作。结果不确定时按稳定名称查询，不直接重试创建。
      environments = await ark.listEnvironments();
      environment = environments.find(item => item.name === environmentName);
      if (!environment) throw error;
    }
  }
  const envPath = options.envPath || ".env";
  const content = serializeEnv({
    ARK_API_KEY: arkApiKey,
    ARK_AGENT_ID: agent.id,
    ARK_ENVIRONMENT_ID: environment.id,
    ARK_VAULT_ID: vault.id,
    ARK_CREDENTIAL_ID: credential.id,
    ARK_BASE_URL: arkBaseUrl.replace(/\/$/, ""),
    FEISHU_APP_ID: feishuApp.appId,
    FEISHU_APP_SECRET: feishuApp.appSecret,
    FEISHU_USER_OPEN_ID: authorization.userOpenId,
    FEISHU_REFRESH_TOKEN: authorization.tokens.refreshToken,
    FEISHU_ACCESS_TOKEN_EXPIRES_AT: String(authorization.tokens.expiresAt),
    LARK_CLI_DOMAINS: larkDomains.split(/[\s,]+/).filter(Boolean).join(","),
    GATEWAY_DB_PATH: options.gatewayDatabasePath || "./data/gateway.db",
    SESSION_TIMEOUT_MS: "600000"
  });
  await mkdir(dirname(envPath), { recursive: true, mode: 0o700 });
  await writeFile(envPath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(envPath, 0o600);
  return { agentId: agent.id, environmentId: environment.id, environmentCreated, envPath };
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

async function required(ask: Ask, label: string): Promise<string> {
  const value = (await ask(label)).trim();
  if (!value) throw new Error(`${label} 不能为空`);
  return value;
}

async function requiredSecret(ask: Ask, label: string): Promise<string> {
  const value = await required(ask, label);
  return value;
}

export function serializeEnv(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n";
}
