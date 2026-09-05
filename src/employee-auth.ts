import type { ArkClient, UserAuthorizationRequired } from "./ark.ts";
import type { IncomingMessage } from "./gateway.ts";
import type { FeishuOAuth } from "./oauth.ts";
import type { GatewayStore } from "./store.ts";

export const EMPLOYEE_CALENDAR_USER_SCOPES = ["offline_access", "auth:user.id:read", "calendar:calendar:read", "calendar:calendar.event:read", "calendar:calendar.free_busy:read"];

type EmployeeAuthArk = Pick<ArkClient, "listVaults" | "createVault" | "listCredentials" | "createEnvironmentVariableCredential" | "updateEnvironmentCredential">;

export class EmployeeAuthorizationManager {
  private pending = new Map<string, { messages: IncomingMessage[]; task?: Promise<void> }>();
  private provisioning = new Map<string, Promise<{ vaultId: string; credentialId: string }>>();
  private store: GatewayStore;
  private ark: EmployeeAuthArk;
  private oauth: FeishuOAuth;
  private sendCard: (message: IncomingMessage, url: string) => Promise<void>;
  private resume: (message: IncomingMessage, userVaultId: string) => void;
  constructor(store: GatewayStore, ark: EmployeeAuthArk, oauth: FeishuOAuth,
    sendCard: (message: IncomingMessage, url: string) => Promise<void>,
    resume: (message: IncomingMessage, userVaultId: string) => void) {
    this.store = store; this.ark = ark; this.oauth = oauth; this.sendCard = sendCard;
    this.resume = resume;
  }

  async vaultIds(message: IncomingMessage): Promise<string[]> {
    const current = this.store.getEmployeeOAuth(message.tenantId, message.senderId);
    if (!current) return [(await this.ensureUserCredential(message)).vaultId];
    if (current.expiresAt - Date.now() > 5 * 60_000) return [current.vaultId];
    try {
      const tokens = await this.oauth.refresh(current.refreshToken);
      await this.ark.updateEnvironmentCredential(current.vaultId, current.credentialId, tokens.accessToken);
      this.store.saveEmployeeOAuth({ ...current, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, scopes: current.scopes });
    } catch (error) {
      // Vault 已在 Session 创建时挂载。刷新失败时继续使用同一 Vault，让 lark-cli
      // 返回结构化 token_missing，再由 ensure 发起一次新的用户 OAuth。
      console.warn("刷新用户 Credential 失败，将通过原 Session 重新申请 OAuth：", error instanceof Error ? error.message : error);
    }
    return [current.vaultId];
  }

  async ensure(message: IncomingMessage, request: UserAuthorizationRequired): Promise<boolean> {
    if (request.domain !== "calendar") throw new Error(`尚未配置 ${request.domain || "未知"} 域的用户授权，无法自动发起 OAuth`);
    const key = `${message.tenantId}:${message.senderId}`;
    const existing = this.pending.get(key);
    if (existing) {
      existing.messages.push(message);
      return false;
    }
    const pending = { messages: [message] } as { messages: IncomingMessage[]; task?: Promise<void> };
    this.pending.set(key, pending);
    try {
      const device = await this.oauth.begin(EMPLOYEE_CALENDAR_USER_SCOPES);
      await this.sendCard(message, device.verificationUrl);
      pending.task = this.complete(key, pending, device).finally(() => this.pending.delete(key));
    } catch (error) {
      this.pending.delete(key);
      throw error;
    }
    return false;
  }

  private async complete(
    key: string,
    pending: { messages: IncomingMessage[] },
    device: Awaited<ReturnType<FeishuOAuth["begin"]>>
  ): Promise<void> {
    const message = pending.messages[0];
    try {
      const tokens = await this.oauth.poll(device);
      const openId = await this.oauth.getUserOpenId(tokens.accessToken);
      if (openId !== message.senderId) throw new Error("授权账号与消息发送者不一致，请使用发送消息的飞书账号授权");
      const credential = await this.ensureUserCredential(message);
      await this.ark.updateEnvironmentCredential(credential.vaultId, credential.credentialId, tokens.accessToken);
      this.store.saveEmployeeOAuth({
        tenantKey: message.tenantId, openId, vaultId: credential.vaultId, credentialId: credential.credentialId,
        refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, scopes: EMPLOYEE_CALENDAR_USER_SCOPES
      });
      for (const queued of pending.messages) {
        this.resume(queued, credential.vaultId);
      }
    } catch (error) {
      console.error(`用户授权失败（${key}）：`, error instanceof Error ? error.message : error);
    }
  }

  private ensureUserCredential(message: IncomingMessage): Promise<{ vaultId: string; credentialId: string }> {
    const key = `${message.tenantId}:${message.senderId}`;
    const existing = this.provisioning.get(key);
    if (existing) return existing;
    const provisioning = (async () => {
      const current = this.store.getEmployeeOAuth(message.tenantId, message.senderId);
      if (current) return { vaultId: current.vaultId, credentialId: current.credentialId };
      const name = `ark-employee-user-${safe(message.senderId)}`.slice(0, 100);
      let vault = (await this.ark.listVaults()).find(item => item.displayName === name);
      if (!vault) vault = { id: await this.ark.createVault(name), displayName: name };
      const found = (await this.ark.listCredentials(vault.id)).find(item => item.secretName === "LARKSUITE_CLI_USER_ACCESS_TOKEN");
      const credentialId = found?.id || await this.ark.createEnvironmentVariableCredential(
        vault.id,
        "lark-cli-user-access-token",
        "LARKSUITE_CLI_USER_ACCESS_TOKEN",
        "ARKAGENT_USER_AUTH_PENDING"
      );
      return { vaultId: vault.id, credentialId };
    })().catch(error => {
      this.provisioning.delete(key);
      throw error;
    });
    this.provisioning.set(key, provisioning);
    return provisioning;
  }
}

function safe(value: string): string { return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "user"; }
