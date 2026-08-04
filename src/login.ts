import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import type { ArkClient } from "./ark.ts";
import type { DeviceAuthorization, FeishuOAuth, OAuthTokens } from "./oauth.ts";

export async function runLoginFlow(options: {
  oauth: Pick<FeishuOAuth, "begin" | "poll" | "getUserOpenId">;
  ark: Pick<ArkClient, "updateEnvironmentCredential">;
  vaultId: string;
  credentialId: string;
  configPath: string;
  scopes: string[];
  onAuthorizationReady: (device: DeviceAuthorization) => void | Promise<void>;
  invalidateSessions: () => number | Promise<number>;
}): Promise<{ userOpenId: string; expiresAt: number; invalidatedSessions: number }> {
  const device = await options.oauth.begin(options.scopes);
  await options.onAuthorizationReady(device);
  const tokens = await options.oauth.poll(device);
  const userOpenId = await options.oauth.getUserOpenId(tokens.accessToken);

  // 先更新运行时 Credential，再原子更新本地可刷新的 OAuth 状态。
  await options.ark.updateEnvironmentCredential(options.vaultId, options.credentialId, tokens.accessToken);
  await persistOAuthState(options.configPath, tokens, userOpenId);
  // Credential 只在创建 Session 时注入；登录后必须废弃旧映射，避免复用旧 token 的 Session。
  const invalidatedSessions = await options.invalidateSessions();
  return { userOpenId, expiresAt: tokens.expiresAt, invalidatedSessions };
}

export async function persistOAuthState(path: string, tokens: Pick<OAuthTokens, "refreshToken" | "expiresAt">, userOpenId?: string): Promise<void> {
  let content = await readFile(path, "utf8");
  const replace = (key: string, value: string): void => {
    const line = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    content = pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}\n${line}\n`;
  };
  replace("FEISHU_REFRESH_TOKEN", tokens.refreshToken);
  replace("FEISHU_ACCESS_TOKEN_EXPIRES_AT", String(tokens.expiresAt));
  if (userOpenId) replace("FEISHU_USER_OPEN_ID", userOpenId);
  const temp = `${path}.tmp`;
  await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}
