import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ConversationKey = {
  channelType: string;
  installationId: string;
  tenantId: string;
  conversationId: string;
  threadId: string;
  senderId: string;
};

export type EmployeeUser = {
  tenantKey: string;
  openId: string;
  firstUsedAt: string;
  lastUsedAt: string;
  usageCount: number;
};

export type AuditLog = {
  id: string;
  channelType: string;
  installationId: string;
  tenantKey: string;
  openId: string;
  chatId: string;
  messageId: string;
  sessionId?: string;
  action: string;
  status: "succeeded" | "failed";
  durationMs?: number;
  requestId?: string;
  summary?: string;
  createdAt: string;
};

export type EmployeeOAuth = {
  tenantKey: string; openId: string; vaultId: string; credentialId: string;
  refreshToken: string; expiresAt: number; scopes: string[]; updatedAt: string;
};

export class GatewayStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_version TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS employee_users (
        tenant_key TEXT NOT NULL,
        open_id TEXT NOT NULL,
        first_used_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        usage_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (tenant_key, open_id)
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL DEFAULT 'lark',
        installation_id TEXT NOT NULL DEFAULT 'legacy',
        tenant_key TEXT NOT NULL,
        open_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        session_id TEXT,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        request_id TEXT,
        summary TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS employee_oauth (
        tenant_key TEXT NOT NULL, open_id TEXT NOT NULL, vault_id TEXT NOT NULL,
        credential_id TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
        scopes TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_key, open_id)
      );
      CREATE INDEX IF NOT EXISTS idx_employee_users_last_used ON employee_users (last_used_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC);
    `);
    this.ensureColumn("audit_logs", "channel_type", "TEXT NOT NULL DEFAULT 'lark'");
    this.ensureColumn("audit_logs", "installation_id", "TEXT NOT NULL DEFAULT 'legacy'");
    if (path !== ":memory:") try { chmodSync(path, 0o600); } catch { /* directory permissions remain the outer boundary */ }
  }

  conversationKey(key: ConversationKey): string {
    return [key.channelType, key.installationId, key.tenantId, key.conversationId, key.threadId || "-", key.senderId || "-"].map(escapeKeyPart).join(":");
  }

  getSession(key: ConversationKey): string | undefined {
    const row = this.db.prepare("SELECT session_id FROM conversations WHERE conversation_key = ?").get(this.conversationKey(key)) as { session_id: string } | undefined;
    if (row?.session_id) return row.session_id;
    // v0.2.1 以前的键没有 channel / installation 命名空间。首次读取后迁移，
    // 让升级用户延续当前会话，同时避免后续 Channel 之间互相串会话。
    if (key.channelType === "lark") {
      const legacyKey = this.legacyConversationKey(key);
      const legacy = this.db.prepare("SELECT session_id, agent_id, agent_version FROM conversations WHERE conversation_key = ?").get(legacyKey) as { session_id: string; agent_id: string; agent_version?: string } | undefined;
      if (legacy) {
        this.saveSession(key, legacy.session_id, legacy.agent_id, legacy.agent_version);
        this.db.prepare("DELETE FROM conversations WHERE conversation_key = ?").run(legacyKey);
        return legacy.session_id;
      }
    }
    return undefined;
  }

  saveSession(key: ConversationKey, sessionId: string, agentId: string, agentVersion?: string): void {
    this.db.prepare(`
      INSERT INTO conversations (conversation_key, session_id, agent_id, agent_version, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_key) DO UPDATE SET
        session_id = excluded.session_id,
        agent_id = excluded.agent_id,
        agent_version = excluded.agent_version,
        updated_at = excluded.updated_at
    `).run(this.conversationKey(key), sessionId, agentId, agentVersion || null, new Date().toISOString());
  }

  resetSession(key: ConversationKey): void {
    this.db.prepare("DELETE FROM conversations WHERE conversation_key = ?").run(this.conversationKey(key));
    if (key.channelType === "lark") this.db.prepare("DELETE FROM conversations WHERE conversation_key = ?").run(this.legacyConversationKey(key));
  }

  resetAllSessions(): number {
    const result = this.db.prepare("DELETE FROM conversations").run();
    return Number(result.changes);
  }

  eventKey(channelType: string, installationId: string, eventId: string): string {
    return [channelType, installationId, eventId].map(escapeKeyPart).join(":");
  }

  claimEvent(channelType: string, installationId: string, eventId: string): boolean {
    if (channelType === "lark") {
      const legacy = this.db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").get(eventId);
      if (legacy) return false;
    }
    const result = this.db.prepare("INSERT OR IGNORE INTO processed_events (event_id, status, updated_at) VALUES (?, 'processing', ?)").run(this.eventKey(channelType, installationId, eventId), new Date().toISOString());
    return Number(result.changes) === 1;
  }

  completeEvent(channelType: string, installationId: string, eventId: string, status: "completed" | "failed"): void {
    this.db.prepare("UPDATE processed_events SET status = ?, updated_at = ? WHERE event_id = ?").run(status, new Date().toISOString(), this.eventKey(channelType, installationId, eventId));
  }

  observeEmployeeUser(tenantKey: string, openId: string): EmployeeUser {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO employee_users (tenant_key, open_id, first_used_at, last_used_at, usage_count)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(tenant_key, open_id) DO UPDATE SET
        last_used_at = excluded.last_used_at,
        usage_count = employee_users.usage_count + 1
    `).run(tenantKey, openId, now, now);
    return this.getEmployeeUser(tenantKey, openId)!;
  }

  getEmployeeUser(tenantKey: string, openId: string): EmployeeUser | undefined {
    const row = this.db.prepare("SELECT * FROM employee_users WHERE tenant_key = ? AND open_id = ?").get(tenantKey, openId) as Record<string, unknown> | undefined;
    return row ? mapEmployeeUser(row) : undefined;
  }

  listEmployeeUsers(limit = 200): EmployeeUser[] {
    const rows = this.db.prepare("SELECT * FROM employee_users ORDER BY last_used_at DESC, rowid DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map(mapEmployeeUser);
  }

  addAuditLog(input: Omit<AuditLog, "id" | "createdAt" | "channelType" | "installationId"> & Partial<Pick<AuditLog, "channelType" | "installationId">>): AuditLog {
    const log: AuditLog = { channelType: "lark", installationId: "legacy", ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db.prepare(`INSERT INTO audit_logs
      (id, channel_type, installation_id, tenant_key, open_id, chat_id, message_id, session_id, action, status, duration_ms, request_id, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(log.id, log.channelType, log.installationId, log.tenantKey, log.openId, log.chatId, log.messageId, log.sessionId || null, log.action, log.status, log.durationMs ?? null, log.requestId || null, log.summary || null, log.createdAt);
    return log;
  }

  listAuditLogs(limit = 200): AuditLog[] {
    const rows = this.db.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map(row => ({
      id: String(row.id), tenantKey: String(row.tenant_key), openId: String(row.open_id), chatId: String(row.chat_id),
      channelType: String(row.channel_type || "lark"), installationId: String(row.installation_id || "legacy"),
      messageId: String(row.message_id), sessionId: row.session_id ? String(row.session_id) : undefined,
      action: String(row.action), status: row.status as AuditLog["status"],
      durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
      requestId: row.request_id ? String(row.request_id) : undefined,
      summary: row.summary ? String(row.summary) : undefined, createdAt: String(row.created_at)
    }));
  }

  getEmployeeOAuth(tenantKey: string, openId: string): EmployeeOAuth | undefined {
    const row = this.db.prepare("SELECT * FROM employee_oauth WHERE tenant_key = ? AND open_id = ?").get(tenantKey, openId) as Record<string, unknown> | undefined;
    return row ? { tenantKey: String(row.tenant_key), openId: String(row.open_id), vaultId: String(row.vault_id), credentialId: String(row.credential_id), refreshToken: String(row.refresh_token), expiresAt: Number(row.expires_at), scopes: JSON.parse(String(row.scopes)), updatedAt: String(row.updated_at) } : undefined;
  }

  saveEmployeeOAuth(value: Omit<EmployeeOAuth, "updatedAt">): EmployeeOAuth {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO employee_oauth (tenant_key, open_id, vault_id, credential_id, refresh_token, expires_at, scopes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_key, open_id) DO UPDATE SET vault_id=excluded.vault_id, credential_id=excluded.credential_id,
      refresh_token=excluded.refresh_token, expires_at=excluded.expires_at, scopes=excluded.scopes, updated_at=excluded.updated_at`
    ).run(value.tenantKey, value.openId, value.vaultId, value.credentialId, value.refreshToken, value.expiresAt, JSON.stringify(value.scopes), updatedAt);
    return { ...value, updatedAt };
  }

  close(): void {
    this.db.close();
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some(item => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private legacyConversationKey(key: ConversationKey): string {
    return [key.tenantId, key.conversationId, key.threadId || "-", key.senderId || "-"].join(":");
  }
}


function mapEmployeeUser(row: Record<string, unknown>): EmployeeUser {
  return {
    tenantKey: String(row.tenant_key), openId: String(row.open_id), firstUsedAt: String(row.first_used_at),
    lastUsedAt: String(row.last_used_at), usageCount: Number(row.usage_count)
  };
}

function escapeKeyPart(value: string): string {
  return encodeURIComponent(value || "-");
}
