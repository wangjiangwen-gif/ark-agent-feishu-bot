import type { ArkClient } from "./ark.ts";
import type { IncomingMessage } from "./gateway.ts";
import type { FeishuOAuth } from "./oauth.ts";
import type { GatewayStore } from "./store.ts";

export const EMPLOYEE_CALENDAR_USER_SCOPES = ["offline_access", "auth:user.id:read", "calendar:calendar:read", "calendar:calendar.event:read", "calendar:calendar.free_busy:read"];

export function needsCalendarAuthorization(text: string): boolean {
  return /(?:日程|日历|会议|约个?时间|schedule|calendar)/i.test(text) && /(?:约|安排|创建|新建|查看|查询|空闲|冲突|有空|schedule|book)/i.test(text);
}

type EmployeeAuthArk = Pick<ArkClient, "listVaults" | "createVault" | "listCredentials" | "createEnvironmentVariableCredential" | "updateEnvironmentCredential">;

export class EmployeeAuthorizationManager {
  private pending = new Map<string, Promise<void>>();
  private store: GatewayStore;
  private ark: EmployeeAuthArk;
  private oauth: FeishuOAuth;
  private sendCard: (chatId: string, url: string) => Promise<void>;
  private resume: (message: IncomingMessage) => void;
  constructor(store: GatewayStore, ark: EmployeeAuthArk, oauth: FeishuOAuth,
    sendCard: (chatId: string, url: string) => Promise<void>, resume: (message: IncomingMessage) => void) {
    this.store = store; this.ark = ark; this.oauth = oauth; this.sendCard = sendCard; this.resume = resume;
  }

  async vaultIds(message: IncomingMessage): Promise<string[]> {
    const current = this.store.getEmployeeOAuth(message.tenantKey, message.userOpenId);
    if (!current) return [];
    if (current.expiresAt - Date.now() > 5 * 60_000) return [current.vaultId];
    const tokens = await this.oauth.refresh(current.refreshToken);
    await this.ark.updateEnvironmentCredential(current.vaultId, current.credentialId, tokens.accessToken);
    this.store.saveEmployeeOAuth({ ...current, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, scopes: current.scopes });
    return [current.vaultId];
  }

  async ensure(message: IncomingMessage): Promise<boolean> {
    if ((await this.vaultIds(message)).length) return true;
    const key = `${message.tenantKey}:${message.userOpenId}`;
    if (this.pending.has(key)) return false;
    const device = await this.oauth.begin(EMPLOYEE_CALENDAR_USER_SCOPES);
    await this.sendCard(message.chatId, device.verificationUrl);
    const task = this.complete(message, device).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return false;
  }

  private async complete(message: IncomingMessage, device: Awaited<ReturnType<FeishuOAuth["begin"]>>): Promise<void> {
    try {
      const tokens = await this.oauth.poll(device);
      const openId = await this.oauth.getUserOpenId(tokens.accessToken);
      if (openId !== message.userOpenId) throw new Error("授权账号与消息发送者不一致，请使用发送消息的飞书账号授权");
      const name = `ark-employee-user-${safe(message.userOpenId)}`.slice(0, 100);
      let vault = (await this.ark.listVaults()).find(item => item.displayName === name);
      if (!vault) vault = { id: await this.ark.createVault(name), displayName: name };
      let credential = (await this.ark.listCredentials(vault.id)).find(item => item.secretName === "LARKSUITE_CLI_USER_ACCESS_TOKEN");
      if (credential) await this.ark.updateEnvironmentCredential(vault.id, credential.id, tokens.accessToken);
      else credential = { id: await this.ark.createEnvironmentVariableCredential(vault.id, "lark-cli-user-access-token", "LARKSUITE_CLI_USER_ACCESS_TOKEN", tokens.accessToken), displayName: "lark-cli-user-access-token", authType: "environment_variable" };
      this.store.saveEmployeeOAuth({ tenantKey: message.tenantKey, openId, vaultId: vault.id, credentialId: credential.id, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, scopes: EMPLOYEE_CALENDAR_USER_SCOPES });
      this.store.resetSession({ tenantKey: message.tenantKey, chatId: message.chatId, threadId: message.threadId, userOpenId: message.userOpenId });
      this.resume(message);
    } catch (error) {
      console.error("用户授权失败：", error instanceof Error ? error.message : error);
    }
  }
}

function safe(value: string): string { return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "user"; }
