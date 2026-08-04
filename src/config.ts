export type GatewayConfig = {
  arkApiKey: string;
  arkAgentId: string;
  arkEnvironmentId: string;
  arkBaseUrl: string;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuUserOpenId: string;
  feishuRefreshToken: string;
  feishuAccessTokenExpiresAt: number;
  arkVaultId: string;
  arkCredentialId: string;
  databasePath: string;
  sessionTimeoutMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const required = ["ARK_API_KEY", "ARK_AGENT_ID", "ARK_ENVIRONMENT_ID", "ARK_VAULT_ID", "ARK_CREDENTIAL_ID", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_USER_OPEN_ID", "FEISHU_REFRESH_TOKEN", "FEISHU_ACCESS_TOKEN_EXPIRES_AT"] as const;
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`缺少环境变量：${missing.join(", ")}`);
  const sessionTimeoutMs = Number(env.SESSION_TIMEOUT_MS || 600_000);
  if (!Number.isFinite(sessionTimeoutMs) || sessionTimeoutMs < 1_000) throw new Error("SESSION_TIMEOUT_MS 必须是不小于 1000 的数字");
  const feishuAccessTokenExpiresAt = Number(env.FEISHU_ACCESS_TOKEN_EXPIRES_AT);
  if (!Number.isFinite(feishuAccessTokenExpiresAt) || feishuAccessTokenExpiresAt <= 0) throw new Error("FEISHU_ACCESS_TOKEN_EXPIRES_AT 必须是有效的毫秒时间戳");
  return {
    arkApiKey: env.ARK_API_KEY!,
    arkAgentId: env.ARK_AGENT_ID!,
    arkEnvironmentId: env.ARK_ENVIRONMENT_ID!,
    arkBaseUrl: (env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, ""),
    feishuAppId: env.FEISHU_APP_ID!,
    feishuAppSecret: env.FEISHU_APP_SECRET!,
    feishuUserOpenId: env.FEISHU_USER_OPEN_ID!,
    feishuRefreshToken: env.FEISHU_REFRESH_TOKEN!,
    feishuAccessTokenExpiresAt,
    arkVaultId: env.ARK_VAULT_ID!,
    arkCredentialId: env.ARK_CREDENTIAL_ID!,
    databasePath: env.GATEWAY_DB_PATH || "./data/gateway.db",
    sessionTimeoutMs
  };
}

export function loadConfigFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  // process.loadEnvFile 不覆盖已存在的变量；login 后若终端仍残留旧 token，
  // Gateway 会继续使用旧值。保存的配置是 arkagent 的权威状态，必须显式覆盖。
  Object.assign(env, parseEnv(readFileSync(path, "utf8")));
}
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
