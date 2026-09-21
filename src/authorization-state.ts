import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ChannelMessage } from "./channel.ts";
import { credentialIdentityKey, type CredentialIdentity, type CredentialStateStore } from "./credential-state.ts";
import type { DeviceAuthorization, OAuthTokens } from "./oauth.ts";

export type AuthorizationPhase = "starting" | "card_pending" | "waiting" | "polling" | "verifying" | "sync_pending" | "ready"
  | "completed" | "cancelled" | "expired" | "failed" | "uncertain";
export type AuthorizationFlow = {
  id: string; identity: CredentialIdentity; revision: number; phase: AuthorizationPhase; expiresAt: number;
  messages: ChannelMessage[]; device?: DeviceAuthorization; tokens?: OAuthTokens; nextPollAt?: number;
};
type FlowPatch = Partial<Pick<AuthorizationFlow, "phase" | "expiresAt" | "messages" | "device" | "tokens" | "nextPollAt">>;
const terminal = new Set<AuthorizationPhase>(["completed", "cancelled", "expired", "failed", "uncertain"]);
export function isAuthorizationTerminal(phase: AuthorizationPhase): boolean { return terminal.has(phase); }

// 一个完整身份最多一个活跃流程；消息、device_code和未校验Token均加密，元数据参与认证。
export class AuthorizationStateStore {
  private db: DatabaseSync;
  private credentials: CredentialStateStore;
  constructor(db: DatabaseSync, credentials: CredentialStateStore) {
    this.db = db; this.credentials = credentials;
    db.exec(`CREATE TABLE IF NOT EXISTS employee_authorization_flows (
      identity_key TEXT PRIMARY KEY, installation_id TEXT NOT NULL, flow_id TEXT NOT NULL,
      phase TEXT NOT NULL, expires_at INTEGER NOT NULL, revision INTEGER NOT NULL, secret TEXT NOT NULL
    )`);
  }

  create(identity: CredentialIdentity, messages: ChannelMessage[]): AuthorizationFlow {
    const flow: AuthorizationFlow = { id: randomUUID(), identity, phase: "starting", expiresAt: Date.now() + 30_000, revision: 1, messages };
    const key = credentialIdentityKey(identity), secret = this.encode(flow);
    const result = this.db.prepare(`INSERT INTO employee_authorization_flows VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_key) DO UPDATE SET flow_id=excluded.flow_id, phase=excluded.phase,
      expires_at=excluded.expires_at, revision=excluded.revision, secret=excluded.secret
      WHERE employee_authorization_flows.phase IN ('completed', 'cancelled', 'expired', 'failed', 'uncertain')`)
      .run(key, identity.installationId, flow.id, flow.phase, flow.expiresAt, flow.revision, secret);
    if (Number(result.changes) !== 1) throw new Error("已有活跃授权流程，请先恢复或取消，不能重复创建");
    return structuredClone(flow);
  }

  get(identity: CredentialIdentity): AuthorizationFlow | undefined {
    const row = this.db.prepare("SELECT * FROM employee_authorization_flows WHERE identity_key = ?").get(credentialIdentityKey(identity));
    return row ? this.decode(row) : undefined;
  }

  listActive(installationId: string): AuthorizationFlow[] {
    return this.db.prepare(`SELECT * FROM employee_authorization_flows WHERE installation_id = ?
      AND phase NOT IN ('completed', 'cancelled', 'expired', 'failed', 'uncertain')`).all(installationId).map(row => this.decode(row));
  }

  save(identity: CredentialIdentity, previous: AuthorizationFlow, patch: FlowPatch): AuthorizationFlow {
    if (credentialIdentityKey(identity) !== credentialIdentityKey(previous.identity)) throw new Error("授权流程身份不一致");
    if (isAuthorizationTerminal(previous.phase)) throw new Error("授权流程已结束，旧版本不能重新激活");
    const flow = { ...previous, ...patch, revision: previous.revision + 1 };
    if (isAuthorizationTerminal(flow.phase)) { delete flow.tokens; delete flow.device; delete flow.nextPollAt; }
    const secret = this.encode(flow);
    const result = this.db.prepare(`UPDATE employee_authorization_flows SET phase=?, expires_at=?, revision=?, secret=?
      WHERE identity_key=? AND flow_id=? AND revision=?`).run(flow.phase, flow.expiresAt, flow.revision, secret,
      credentialIdentityKey(identity), previous.id, previous.revision);
    if (Number(result.changes) !== 1) throw new Error("授权流程版本已变化，旧流程不能覆盖新状态");
    return structuredClone(flow);
  }

  private context(flow: Pick<AuthorizationFlow, "id" | "identity" | "phase" | "expiresAt" | "revision">): string {
    return JSON.stringify([credentialIdentityKey(flow.identity), flow.id, flow.phase, flow.expiresAt, flow.revision]);
  }

  private encode(flow: AuthorizationFlow): string {
    this.validateMessages(flow.identity, flow.messages);
    return this.credentials.sealAuthorization(JSON.stringify({ messages: flow.messages, device: flow.device,
      tokens: flow.tokens, nextPollAt: flow.nextPollAt }), this.context(flow));
  }

  private decode(row: Record<string, unknown>): AuthorizationFlow {
    const [channelType, installationId, tenantId, openId] = JSON.parse(String(row.identity_key));
    const identity = { channelType, installationId, tenantId, openId };
    const metadata = { id: String(row.flow_id), identity, phase: row.phase as AuthorizationPhase,
      expiresAt: Number(row.expires_at), revision: Number(row.revision) };
    const data = JSON.parse(this.credentials.openAuthorization(String(row.secret), this.context(metadata)));
    this.validateMessages(identity, data.messages);
    return { ...data, ...metadata };
  }

  private validateMessages(identity: CredentialIdentity, messages: ChannelMessage[]): void {
    const key = credentialIdentityKey(identity);
    if (!Array.isArray(messages) || !messages.length) throw new Error("授权流程缺少原始消息");
    for (const message of messages) {
      if (message.conversationType !== "direct") throw new Error("用户授权流程仅支持单聊");
      if (credentialIdentityKey({ channelType: message.channelType, installationId: message.installationId,
        tenantId: message.tenantId, openId: message.senderId }) !== key) throw new Error("授权消息身份与流程不一致");
    }
  }
}
