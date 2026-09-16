import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hostname } from "node:os";
import type { ChannelHistoryMessage, ChannelMessage } from "./channel.ts";
import type { CompactionCheckpoint } from "./session-compaction.ts";
import { CredentialStateStore, type CredentialIdentity, type CredentialState } from "./credential-state.ts";

export type StoredAttachment = { fileId?: string; inlineText?: string; name: string; mountPath: string; bytes: number };

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
  responseSummary?: string;
  messageCreateTime?: number;
  createdAt: string;
};

export type EmployeeOAuth = {
  tenantKey: string; openId: string; vaultId: string; credentialId: string;
  refreshToken: string; expiresAt: number; scopes: string[]; updatedAt: string;
};

export class GatewayStore {
  readonly credentials: CredentialStateStore;
  private db: DatabaseSync;
  private runtimeToken?: string;
  private closed = false;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_version TEXT,
        vault_ids TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_context_cursors (
        conversation_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_create_time INTEGER NOT NULL
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
        response_summary TEXT,
        message_create_time INTEGER,
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
      CREATE TABLE IF NOT EXISTS channel_history (
        scope TEXT NOT NULL, message_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        create_time INTEGER NOT NULL, payload TEXT NOT NULL, saved_at INTEGER NOT NULL,
        PRIMARY KEY (scope, message_id)
      );
      CREATE TABLE IF NOT EXISTS context_receipts (
        session_id TEXT NOT NULL, message_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS outgoing_messages (
        scope TEXT NOT NULL, message_id TEXT NOT NULL, trigger_id TEXT NOT NULL,
        PRIMARY KEY (scope, message_id)
      );
      CREATE TABLE IF NOT EXISTS attachments (
        attachment_key TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachment_mounts (
        session_id TEXT NOT NULL, attachment_key TEXT NOT NULL,
        PRIMARY KEY (session_id, attachment_key)
      );
      CREATE TABLE IF NOT EXISTS inline_restore_pending (session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS session_configuration (
        session_id TEXT PRIMARY KEY, config_fingerprint TEXT NOT NULL,
        metadata TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gateway_runtime_lock (
        id INTEGER PRIMARY KEY CHECK(id = 1), pid INTEGER NOT NULL,
        host TEXT NOT NULL, token TEXT NOT NULL, acquired_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_compaction (
        session_id TEXT PRIMARY KEY, checkpoint TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    this.credentials = new CredentialStateStore(this.db, path);
    this.ensureColumn("audit_logs", "channel_type", "TEXT NOT NULL DEFAULT 'lark'");
    this.ensureColumn("audit_logs", "installation_id", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("audit_logs", "response_summary", "TEXT");
    this.ensureColumn("audit_logs", "message_create_time", "INTEGER");
    this.ensureColumn("conversations", "vault_ids", "TEXT");
    const hadDispatchMetadata = (this.db.prepare("PRAGMA table_info(processed_events)").all() as { name: string }[]).some(column => column.name === "dispatched");
    this.ensureColumn("processed_events", "dispatched", "INTEGER NOT NULL DEFAULT 0");
    // 旧版没有执行边界记录，不能把旧失败误判为尚未提交的安全重试。
    if (!hadDispatchMetadata) this.db.prepare("UPDATE processed_events SET dispatched = 1 WHERE status IN ('processing', 'failed')").run();
    this.ensureColumn("processed_events", "attempts", "INTEGER NOT NULL DEFAULT 1");
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

  getSessionVaultIds(key: ConversationKey): string[] | undefined {
    const row = this.db.prepare("SELECT vault_ids FROM conversations WHERE conversation_key = ?").get(this.conversationKey(key)) as { vault_ids: string | null } | undefined;
    if (!row?.vault_ids) return undefined;
    try {
      const value = JSON.parse(row.vault_ids) as unknown;
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
    } catch {
      return undefined;
    }
  }

  knownUserVaultIds(): string[] {
    return (this.db.prepare("SELECT vault_id FROM employee_oauth UNION SELECT vault_id FROM employee_credentials").all() as { vault_id: string }[]).map(row => row.vault_id);
  }

  getCompactionCheckpoint(sessionId: string): CompactionCheckpoint | undefined {
    const row = this.db.prepare("SELECT checkpoint FROM session_compaction WHERE session_id = ?").get(sessionId) as { checkpoint: string } | undefined;
    return row ? JSON.parse(row.checkpoint) : undefined;
  }

  saveCompactionCheckpoint(sessionId: string, checkpoint: CompactionCheckpoint): void {
    this.db.prepare(`INSERT INTO session_compaction VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET checkpoint = excluded.checkpoint, updated_at = excluded.updated_at`
    ).run(sessionId, JSON.stringify(checkpoint), new Date().toISOString());
  }

  saveSessionConfiguration(sessionId: string, fingerprint: string, metadata: { requestFingerprint: string; environmentId?: string; agentVersion?: string; vaultIds: string[]; hasSystemOverride: boolean }): void {
    this.db.prepare("INSERT OR IGNORE INTO session_configuration VALUES (?, ?, ?, ?)").run(sessionId, fingerprint, JSON.stringify(metadata), new Date().toISOString());
  }

  getSessionConfiguration(sessionId: string): { fingerprint: string; metadata: { requestFingerprint: string; environmentId?: string; agentVersion?: string; vaultIds: string[]; hasSystemOverride: boolean } } | undefined {
    const row = this.db.prepare("SELECT config_fingerprint, metadata FROM session_configuration WHERE session_id = ?").get(sessionId) as { config_fingerprint: string; metadata: string } | undefined;
    return row ? { fingerprint: row.config_fingerprint, metadata: JSON.parse(row.metadata) } : undefined;
  }

  assertSessionAgent(key: ConversationKey, agentId: string): void {
    const row = this.db.prepare("SELECT agent_id FROM conversations WHERE conversation_key = ?").get(this.conversationKey(key)) as { agent_id: string } | undefined;
    if (row && row.agent_id !== agentId) throw new Error("当前会话绑定的 Agent 与配置不一致。请先恢复原 Agent 配置；如确定切换，请发送 /new（新会话不会继承旧沙箱文件）。");
  }

  saveSession(key: ConversationKey, sessionId: string, agentId: string, agentVersion?: string, vaultIds?: string[]): void {
    this.db.prepare(`
      INSERT INTO conversations (conversation_key, session_id, agent_id, agent_version, vault_ids, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_key) DO UPDATE SET
        session_id = excluded.session_id,
        agent_id = excluded.agent_id,
        agent_version = excluded.agent_version,
        vault_ids = excluded.vault_ids,
        updated_at = excluded.updated_at
    `).run(this.conversationKey(key), sessionId, agentId, agentVersion || null, vaultIds ? JSON.stringify(vaultIds) : null, new Date().toISOString());
  }

  getConversationContextCursor(key: ConversationKey, sessionId: string): number | undefined {
    const row = this.db.prepare(`
      SELECT message_create_time FROM conversation_context_cursors
      WHERE conversation_key = ? AND session_id = ?
    `).get(this.conversationKey(key), sessionId) as { message_create_time: number } | undefined;
    return row ? Number(row.message_create_time) : undefined;
  }

  saveConversationContextCursor(key: ConversationKey, sessionId: string, messageCreateTime: number): void {
    this.db.prepare(`
      INSERT INTO conversation_context_cursors (conversation_key, session_id, message_create_time)
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_key) DO UPDATE SET
        session_id = excluded.session_id,
        message_create_time = CASE
          WHEN conversation_context_cursors.session_id = excluded.session_id
          THEN MAX(conversation_context_cursors.message_create_time, excluded.message_create_time)
          ELSE excluded.message_create_time
        END
    `).run(this.conversationKey(key), sessionId, messageCreateTime);
  }

  resetSession(key: ConversationKey): void {
    const conversationKey = this.conversationKey(key);
    this.db.prepare("DELETE FROM conversations WHERE conversation_key = ?").run(conversationKey);
    this.db.prepare("DELETE FROM conversation_context_cursors WHERE conversation_key = ?").run(conversationKey);
    if (key.channelType === "lark") {
      const legacyKey = this.legacyConversationKey(key);
      this.db.prepare("DELETE FROM conversations WHERE conversation_key = ?").run(legacyKey);
      this.db.prepare("DELETE FROM conversation_context_cursors WHERE conversation_key = ?").run(legacyKey);
    }
  }

  resetAllSessions(): number {
    const result = this.db.prepare("DELETE FROM conversations").run();
    this.db.prepare("DELETE FROM conversation_context_cursors").run();
    return Number(result.changes);
  }

  eventKey(channelType: string, installationId: string, eventId: string): string {
    return [channelType, installationId, eventId].map(escapeKeyPart).join(":");
  }

  claimEvent(channelType: string, installationId: string, eventId: string, now = Date.now()): boolean {
    if (channelType === "lark") {
      const legacy = this.db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").get(eventId);
      if (legacy) return false;
    }
    const result = this.db.prepare(`INSERT INTO processed_events (event_id, status, updated_at) VALUES (?, 'processing', ?)
      ON CONFLICT(event_id) DO UPDATE SET status = 'processing', updated_at = excluded.updated_at, attempts = attempts + 1
      WHERE dispatched = 0 AND attempts < 3 AND
        ((status = 'failed' AND updated_at <= ?) OR (status = 'processing' AND updated_at <= ?))
    `).run(this.eventKey(channelType, installationId, eventId), new Date(now).toISOString(), new Date(now - 2_000).toISOString(), new Date(now - 15 * 60_000).toISOString());
    return Number(result.changes) === 1;
  }

  completeEvent(channelType: string, installationId: string, eventId: string, status: "completed" | "failed"): void {
    this.db.prepare("UPDATE processed_events SET status = CASE WHEN ? = 'failed' AND dispatched = 1 THEN 'uncertain' ELSE ? END, updated_at = ? WHERE event_id = ?").run(status, status, new Date().toISOString(), this.eventKey(channelType, installationId, eventId));
  }

  touchEvent(message: ChannelMessage, dispatched = false): void {
    this.db.prepare("UPDATE processed_events SET updated_at = ?, dispatched = MAX(dispatched, ?) WHERE event_id = ? AND status = 'processing'")
      .run(new Date().toISOString(), dispatched ? 1 : 0, this.eventKey(message.channelType, message.installationId, message.messageId));
  }

  private historyScope(message: ChannelMessage): string {
    return JSON.stringify([message.channelType, message.installationId, message.tenantId, message.conversationId]);
  }

  cacheHistory(message: ChannelMessage, items: ChannelHistoryMessage[]): void {
    const scope = this.historyScope(message);
    const insert = this.db.prepare(`INSERT INTO channel_history VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scope, message_id) DO UPDATE SET payload = excluded.payload, saved_at = excluded.saved_at
      WHERE COALESCE(json_extract(excluded.payload, '$.updateTime'), excluded.create_time) >= COALESCE(json_extract(channel_history.payload, '$.updateTime'), channel_history.create_time)`);
    for (const item of items) insert.run(scope, item.messageId, item.threadId || (item.source === "thread" ? message.threadId : ""), item.createTime, JSON.stringify(item), Date.now());
    this.db.prepare("DELETE FROM channel_history WHERE scope = ? AND message_id NOT IN (SELECT message_id FROM channel_history WHERE scope = ? ORDER BY create_time DESC LIMIT 2000)").run(scope, scope);
  }

  cachedHistory(message: ChannelMessage): ChannelHistoryMessage[] {
    const rows = this.db.prepare(`SELECT payload FROM channel_history WHERE scope = ? AND create_time <= ? AND message_id != ?
      AND (thread_id = '' OR thread_id = ?) ORDER BY create_time DESC LIMIT 100`)
      .all(this.historyScope(message), message.createTime, message.messageId, message.threadId) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload) as ChannelHistoryMessage).reverse();
  }

  cachedMessage(message: ChannelMessage, messageId: string): ChannelHistoryMessage | undefined {
    // 引用可在窗口外，但不能跨应用、租户、群或其他话题取缓存。
    const row = this.db.prepare(`SELECT payload FROM channel_history WHERE scope = ? AND message_id = ? AND create_time <= ?
      AND (thread_id = '' OR thread_id = ?)`).get(this.historyScope(message), messageId, message.createTime, message.threadId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as ChannelHistoryMessage : undefined;
  }

  contextFingerprint(sessionId: string, messageId: string): string | undefined {
    return (this.db.prepare("SELECT fingerprint FROM context_receipts WHERE session_id = ? AND message_id = ?").get(sessionId, messageId) as { fingerprint: string } | undefined)?.fingerprint;
  }

  saveContextFingerprint(sessionId: string, messageId: string, fingerprint: string): void {
    this.db.prepare("INSERT INTO context_receipts VALUES (?, ?, ?) ON CONFLICT(session_id, message_id) DO UPDATE SET fingerprint = excluded.fingerprint").run(sessionId, messageId, fingerprint);
  }

  recordOutgoing(message: ChannelMessage, messageId: string): void {
    this.db.prepare("INSERT OR REPLACE INTO outgoing_messages VALUES (?, ?, ?)").run(this.historyScope(message), messageId, message.messageId);
  }

  isOwnSessionReply(message: ChannelMessage, sessionId: string, messageId: string): boolean {
    if (messageId.endsWith(":gateway-response")) return Boolean(this.db.prepare("SELECT 1 FROM audit_logs WHERE message_id = ? AND session_id = ? AND installation_id = ? LIMIT 1")
      .get(messageId.slice(0, -":gateway-response".length), sessionId, message.installationId));
    return Boolean(this.db.prepare(`SELECT 1 FROM outgoing_messages o JOIN audit_logs a ON a.message_id = o.trigger_id
      WHERE o.scope = ? AND o.message_id = ? AND a.session_id = ? AND a.installation_id = ? LIMIT 1`)
      .get(this.historyScope(message), messageId, sessionId, message.installationId));
  }

  getAttachment(key: string): StoredAttachment | undefined {
    const row = this.db.prepare("SELECT payload FROM attachments WHERE attachment_key = ?").get(key) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as StoredAttachment : undefined;
  }

  saveAttachment(key: string, value: StoredAttachment): void {
    this.db.prepare("INSERT OR REPLACE INTO attachments VALUES (?, ?, ?)").run(key, JSON.stringify(value), new Date().toISOString());
  }

  isAttachmentMounted(sessionId: string, key: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM attachment_mounts WHERE session_id = ? AND attachment_key = ?").get(sessionId, key));
  }

  markAttachmentMounted(sessionId: string, key: string): void {
    this.db.prepare("INSERT OR IGNORE INTO attachment_mounts VALUES (?, ?)").run(sessionId, key);
  }

  requestInlineRestore(sessionId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO inline_restore_pending VALUES (?)").run(sessionId);
  }

  pendingInlineSources(sessionId: string): StoredAttachment[] {
    if (!this.db.prepare("SELECT 1 FROM inline_restore_pending WHERE session_id = ?").get(sessionId)) return [];
    const rows = this.db.prepare("SELECT a.payload FROM attachments a JOIN attachment_mounts m ON a.attachment_key = m.attachment_key WHERE m.session_id = ? ORDER BY a.created_at DESC").all(sessionId) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload) as StoredAttachment).filter(item => item.inlineText !== undefined);
  }

  completeInlineRestore(sessionId: string): void {
    this.db.prepare("DELETE FROM inline_restore_pending WHERE session_id = ?").run(sessionId);
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
      (id, channel_type, installation_id, tenant_key, open_id, chat_id, message_id, session_id, action, status, duration_ms, request_id, summary, response_summary, message_create_time, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(log.id, log.channelType, log.installationId, log.tenantKey, log.openId, log.chatId, log.messageId, log.sessionId || null, log.action, log.status, log.durationMs ?? null, log.requestId || null, log.summary || null, log.responseSummary || null, log.messageCreateTime ?? null, log.createdAt);
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
      summary: row.summary ? String(row.summary) : undefined,
      responseSummary: row.response_summary ? String(row.response_summary) : undefined,
      messageCreateTime: row.message_create_time === null ? undefined : Number(row.message_create_time),
      createdAt: String(row.created_at)
    }));
  }

  listSessionAudit(sessionId: string, limit = 12): AuditLog[] {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM audit_logs
        WHERE session_id = ? AND status = 'succeeded' AND action IN ('message', 'file_message')
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      ) ORDER BY created_at ASC
    `).all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(row => ({
      id: String(row.id), tenantKey: String(row.tenant_key), openId: String(row.open_id), chatId: String(row.chat_id),
      channelType: String(row.channel_type || "lark"), installationId: String(row.installation_id || "legacy"),
      messageId: String(row.message_id), sessionId: row.session_id ? String(row.session_id) : undefined,
      action: String(row.action), status: row.status as AuditLog["status"],
      durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
      requestId: row.request_id ? String(row.request_id) : undefined,
      summary: row.summary ? String(row.summary) : undefined,
      responseSummary: row.response_summary ? String(row.response_summary) : undefined,
      messageCreateTime: row.message_create_time === null ? undefined : Number(row.message_create_time),
      createdAt: String(row.created_at)
    }));
  }

  listConversationAudit(input: {
    channelType: string; installationId: string; tenantKey: string; chatId: string; beforeCreateTime?: number; limit?: number;
  }): AuditLog[] {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM audit_logs
        WHERE channel_type = ? AND installation_id = ? AND tenant_key = ? AND chat_id = ?
          AND status = 'succeeded' AND action IN ('message', 'file_message')
          AND (message_create_time IS NULL OR message_create_time < ?)
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      ) ORDER BY created_at ASC
    `).all(input.channelType, input.installationId, input.tenantKey, input.chatId, input.beforeCreateTime ?? Number.MAX_SAFE_INTEGER, input.limit ?? 12) as Record<string, unknown>[];
    return rows.map(row => ({
      id: String(row.id), tenantKey: String(row.tenant_key), openId: String(row.open_id), chatId: String(row.chat_id),
      channelType: String(row.channel_type || "lark"), installationId: String(row.installation_id || "legacy"),
      messageId: String(row.message_id), sessionId: row.session_id ? String(row.session_id) : undefined,
      action: String(row.action), status: row.status as AuditLog["status"],
      durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
      requestId: row.request_id ? String(row.request_id) : undefined,
      summary: row.summary ? String(row.summary) : undefined,
      responseSummary: row.response_summary ? String(row.response_summary) : undefined,
      messageCreateTime: row.message_create_time === null ? undefined : Number(row.message_create_time),
      createdAt: String(row.created_at)
    }));
  }

  getEmployeeOAuth(tenantKey: string, openId: string): EmployeeOAuth | undefined {
    const row = this.db.prepare("SELECT * FROM employee_oauth WHERE tenant_key = ? AND open_id = ?").get(tenantKey, openId) as Record<string, unknown> | undefined;
    return row ? { tenantKey: String(row.tenant_key), openId: String(row.open_id), vaultId: String(row.vault_id), credentialId: String(row.credential_id), refreshToken: this.credentials.openLegacy(String(row.refresh_token), tenantKey, openId), expiresAt: Number(row.expires_at), scopes: JSON.parse(String(row.scopes)), updatedAt: String(row.updated_at) } : undefined;
  }

  saveEmployeeOAuth(value: Omit<EmployeeOAuth, "updatedAt">): EmployeeOAuth {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO employee_oauth (tenant_key, open_id, vault_id, credential_id, refresh_token, expires_at, scopes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_key, open_id) DO UPDATE SET vault_id=excluded.vault_id, credential_id=excluded.credential_id,
      refresh_token=excluded.refresh_token, expires_at=excluded.expires_at, scopes=excluded.scopes, updated_at=excluded.updated_at`
    ).run(value.tenantKey, value.openId, value.vaultId, value.credentialId, this.credentials.sealLegacy(value.refreshToken, value.tenantKey, value.openId), value.expiresAt, JSON.stringify(value.scopes), updatedAt);
    return { ...value, updatedAt };
  }

  migrateEmployeeCredential(identity: CredentialIdentity): CredentialState | undefined {
    const current = this.credentials.get(identity);
    if (current) return current;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const migrate = (): CredentialState | undefined => {
        const found = this.credentials.get(identity);
        if (found) return found;
        const legacy = this.getEmployeeOAuth(identity.tenantId, identity.openId);
        if (!legacy) return undefined;
        // 同一旧Vault被多个身份引用时不能按先到先得认领；保留记录供管理员核查。
        const prefix = [identity.channelType, identity.installationId, identity.tenantId].map(escapeKeyPart).join(":") + ":";
        const suffix = `:${escapeKeyPart(identity.openId)}`;
        const rows = this.db.prepare("SELECT conversation_key, vault_ids FROM conversations WHERE vault_ids IS NOT NULL").all() as { conversation_key: string; vault_ids: string }[];
        const owners = rows.filter(row => {
          let vaultIds: unknown;
          try { vaultIds = JSON.parse(row.vault_ids); } catch { throw new Error("旧Session挂载记录损坏，无法安全确认用户凭证归属"); }
          if (!Array.isArray(vaultIds)) throw new Error("旧Session挂载记录格式错误，无法安全确认用户凭证归属");
          return vaultIds.includes(legacy.vaultId);
        });
        const matches = (row: typeof rows[number]) => row.conversation_key.split(":").length === 6
          && row.conversation_key.startsWith(prefix) && row.conversation_key.endsWith(suffix);
        if (!owners.some(matches)) return undefined;
        if (!owners.every(matches)) throw new Error("旧用户凭证的应用或用户归属不唯一，已停止自动迁移，请管理员核查");
        const state = this.credentials.save(identity, { vaultId: legacy.vaultId, credentialId: legacy.credentialId,
          refreshToken: legacy.refreshToken, expiresAt: legacy.expiresAt, scopes: legacy.scopes, status: "ready" }, 0);
        this.db.prepare("DELETE FROM employee_oauth WHERE tenant_key = ? AND open_id = ?").run(identity.tenantId, identity.openId);
        return state;
      };
      const state = migrate();
      this.db.exec("COMMIT");
      return state;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  close(): void {
    if (this.closed) return;
    this.credentials.close();
    if (this.runtimeToken) this.db.prepare("DELETE FROM gateway_runtime_lock WHERE id = 1 AND token = ?").run(this.runtimeToken);
    this.db.close();
    this.closed = true;
  }

  acquireRuntimeLock(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owner = this.db.prepare("SELECT pid, host FROM gateway_runtime_lock WHERE id = 1").get() as { pid: number; host: string } | undefined;
      if (owner) {
        if (owner.host !== hostname()) throw new Error("数据库由另一主机的Gateway占用；不支持共享数据库上的多主机运行");
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (alive) throw new Error(`同一数据库已有Gateway运行（PID ${owner.pid}），请先停止原进程`);
      }
      const token = randomUUID();
      this.db.prepare("INSERT OR REPLACE INTO gateway_runtime_lock VALUES (1, ?, ?, ?, ?)").run(process.pid, hostname(), token, new Date().toISOString());
      this.db.exec("COMMIT");
      this.runtimeToken = token;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
