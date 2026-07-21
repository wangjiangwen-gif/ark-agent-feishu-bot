import { chmod, writeFile } from "node:fs/promises";
import type { AgentConfig, ArkClient } from "./ark.ts";
import type { OAuthTokens } from "./oauth.ts";
import { resolveLarkUserScopes } from "./scopes.ts";

export type Ask = (label: string, defaultValue?: string) => Promise<string>;

export const OFFICE_AGENT_NAME = "飞书办公助手（方舟 MA 版）";

export const OFFICE_AGENT_CONFIG: AgentConfig = {
  name: OFFICE_AGENT_NAME,
  description: "以用户身份使用 lark-cli 处理飞书文档、云空间及常见办公任务",
  model: { id: "doubao-seed-2-1-pro-260628" },
  system: `你是飞书办公助手，帮助用户处理飞书文档、云空间和日常办公任务。

运行环境已全局安装 lark-cli，并通过 LARKSUITE_CLI_APP_ID 与 LARKSUITE_CLI_USER_ACCESS_TOKEN 注入用户身份凭证。所有飞书操作默认使用 user 身份。

执行飞书任务时：
1. 先运行 lark-cli skills read <skill-name>，完整读取与任务匹配的内置 Skill，并遵循其中工作流。
2. 优先使用 lark-cli 的 +shortcut；没有合适 shortcut 时再查询 schema 后调用原生资源命令。
3. 禁止运行 npx @larksuite/cli、重复安装 CLI 或联网探测版本；如需确认安装，只运行 command -v lark-cli 和 lark-cli --version。
4. 外部 Credential 模式不支持交互式 auth 管理；不要运行 auth login 或用 auth status 判断凭证不可用。权限不足时，向用户返回 missing_scopes 与需要重新授权的业务域。
5. 不读取、不打印、不写入任何 token、App Secret 或其他凭证。不要在回复中暴露 shell 命令和敏感环境变量。
6. 用户明确要求的普通办公写操作可以直接执行；lark-cli 标记为 high-risk-write 的操作必须先向用户确认。
7. 命令超时后先分析原因，不得原样重试。完成后返回结果摘要和可访问的飞书链接。`,
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
}): Promise<{ agentId: string; environmentId: string; environmentCreated: boolean; envPath: string }> {
  const arkApiKey = await requiredSecret(options.askSecret, "方舟 API Key");
  const arkBaseUrl = await options.ask("方舟 API Base URL", "https://ark.cn-beijing.volces.com/api/v3");
  const ark = options.createArk(arkApiKey, arkBaseUrl.replace(/\/$/, ""));
  // 个人级初始化每次都创建新的办公助手；创建是非幂等操作，失败后不自动重试。
  const agent = await ark.createAgent(OFFICE_AGENT_CONFIG);
  const larkDomains = await options.ask("lark-cli 用户权限域（逗号分隔）", "docs,drive");
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
  const environmentName = await options.ask("自动创建的 Environment 名称", suggestedName);

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
    GATEWAY_DB_PATH: "./data/gateway.db",
    SESSION_TIMEOUT_MS: "600000"
  });
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
