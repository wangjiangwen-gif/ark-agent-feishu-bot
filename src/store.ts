import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hostname } from "node:os";
import type { ChannelHistoryMessage, ChannelMessage } from "./channel.ts";
import { baselineCompaction, type CompactionCheckpoint } from "./session-compaction.ts";
import { CredentialStateStore, type CredentialIdentity, type CredentialState } from "./credential-state.ts";
import { AuthorizationStateStore, type AuthorizationFlow } from "./authorization-state.ts";
import type { OAuthTokens } from "./oauth.ts";
import type { RunEvidence } from "./run-evidence.ts";
import type { RunInspection, RunResult } from "./ark.ts";
import { MessageInbox, type InboxBinding, type InboxTask } from "./message-inbox.ts";
import { ReactionStateStore } from "./reaction-state.ts";
import { AttachmentTraceStore } from "./attachment-trace.ts";
import { SessionCreationStore, type SessionCreationInput, type SessionCreationRecord } from "./session-creation-state.ts";
import { configFingerprint, requestEnvironmentId } from "./session-config.ts";
import { sanitizeFailure, type FailureDiagnostic } from "./ark-errors.ts";
import { parseStoredFileObservation, sanitizeFileObservation, type RunFileObservation } from "./run-file-observation.ts";

export type StoredAttachment = { fileId?: string; inlineText?: string; name: string; mountPath: string; bytes: number; sha256?: string };

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
  fileObservation?: RunFileObservation;
  messageCreateTime?: number;
  createdAt: string;
};

export type EmployeeOAuth = {
  tenantKey: string; openId: string; vaultId: string; credentialId: string;
  refreshToken: string; expiresAt: number; scopes: string[]; updatedAt: string;
};

export type AuthorizationRecoveryState = "waiting" | "resuming" | "completed" | "failed" | "blocked" | "cancelled" | "expired";

export class GatewayStore {
  readonly credentials: CredentialStateStore;
  readonly authorizations: AuthorizationStateStore;
  readonly inbox: MessageInbox;
  readonly reactions: ReactionStateStore;
  readonly attachmentTrace: AttachmentTraceStore;
  readonly sessionCreations: SessionCreationStore;
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
      CREATE TABLE IF NOT EXISTS inline_restore_sources (
        session_id TEXT NOT NULL, attachment_key TEXT NOT NULL,
        PRIMARY KEY (session_id, attachment_key)
      );
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
      CREATE TABLE IF NOT EXISTS authorization_recoveries (
        request_key TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        state TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    this.credentials = new CredentialStateStore(this.db, path);
    this.authorizations = new AuthorizationStateStore(this.db, this.credentials);
    this.inbox = new MessageInbox(this.db, this.credentials, () => this.assertRuntimeLock());
    this.reactions = new ReactionStateStore(this.db, this.credentials, this.inbox, () => this.assertRuntimeLock());
    this.attachmentTrace = new AttachmentTraceStore(this.db);
    this.sessionCreations = new SessionCreationStore(this.db, this.credentials, this.attachmentTrace,
      (key, reusable, messageId) => this.sessionCreationScope(key, reusable, messageId));
    this.ensureColumn("authorization_recoveries", "evidence", "TEXT");
    this.ensureColumn("audit_logs", "channel_type", "TEXT NOT NULL DEFAULT 'lark'");
    this.ensureColumn("audit_logs", "installation_id", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("audit_logs", "response_summary", "TEXT");
    this.ensureColumn("audit_logs", "file_observation", "TEXT");
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

  sessionCreationScope(key: ConversationKey, reusable: boolean, messageId: string): string {
    if (typeof reusable !== "boolean" || typeof messageId !== "string" || !messageId.trim()) throw new Error("Session创建模式或消息标识无效");
    const conversation = this.conversationKey(key);
    // 独立消息各自持有创建回执；JSON数组边界避免消息标识与会话范围的拼接碰撞。
    return reusable ? conversation : JSON.stringify(["isolated-session", conversation, messageId]);
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

  beginSessionCreation(value: SessionCreationInput): SessionCreationRecord {
    return this.sessionCreations.begin(value);
  }

  confirmSessionCreation(expected: SessionCreationRecord, sessionId: string): SessionCreationRecord {
    // 与默认非持久化队列入口兼容；唯一pending范围和CAS由SQLite保证，不依赖进程运行锁。
    this.db.exec("SAVEPOINT gateway_session_creation_confirmation");
    try {
      const previous = this.sessionCreations.get(expected.operationId);
      const confirmed = this.sessionCreations.confirm(expected, sessionId);
      if (previous?.state !== "confirmed") {
        const { key, request } = confirmed;
        const agentVersion = typeof request.agent === "object" && request.agent.version !== undefined ? String(request.agent.version) : undefined;
        if (confirmed.reusable) {
          const existing = this.getSession(key);
          if (existing && existing !== sessionId) throw new Error("当前会话已绑定其他Session，不能覆盖原会话");
          this.assertSessionAgent(key, confirmed.agentId);
          this.saveSession(key, sessionId, confirmed.agentId, agentVersion, request.vault_ids);
        }
        const metadata = { requestFingerprint: configFingerprint(request), environmentId: requestEnvironmentId(request),
          agentVersion, vaultIds: request.vault_ids || [],
          hasSystemOverride: typeof request.agent === "object" && Object.hasOwn(request.agent, "system") };
        const configuration = this.getSessionConfiguration(sessionId);
        if (configuration && (configuration.fingerprint !== confirmed.configFingerprint
          || configFingerprint(configuration.metadata) !== configFingerprint(metadata))) throw new Error("Session创建配置与已有回执冲突");
        this.saveSessionConfiguration(sessionId, confirmed.configFingerprint, metadata);
        if (!this.getCompactionCheckpoint(sessionId)) this.saveCompactionCheckpoint(sessionId, baselineCompaction({ eventCount: 0 }));
        for (const mount of confirmed.mounts) {
          if (mount.intentId) {
            this.assertPendingCreationMount(confirmed, mount);
            this.attachmentTrace.finish(mount.intentId, "succeeded", { sessionId });
            this.markAttachmentMounted(sessionId, mount.key);
          }
          // inline正文还没有发送给模型，创建成功不能充当“已提供原文”的回执。
        }
      }
      this.db.exec("RELEASE gateway_session_creation_confirmation");
      return confirmed;
    } catch (error) {
      this.db.exec("ROLLBACK TO gateway_session_creation_confirmation; RELEASE gateway_session_creation_confirmation");
      throw error;
    }
  }

  rejectSessionCreation(expected: SessionCreationRecord, diagnostic: FailureDiagnostic): SessionCreationRecord {
    this.db.exec("SAVEPOINT gateway_session_creation_rejection");
    try {
      const previous = this.sessionCreations.get(expected.operationId);
      const rejected = this.sessionCreations.reject(expected, diagnostic);
      if (previous?.state !== "rejected") for (const mount of rejected.mounts) {
        if (!mount.intentId) continue;
        this.assertPendingCreationMount(rejected, mount);
        this.attachmentTrace.finish(mount.intentId, "error", { rejected: true, failure: rejected.failure });
      }
      this.db.exec("RELEASE gateway_session_creation_rejection");
      return rejected;
    } catch (error) {
      this.db.exec("ROLLBACK TO gateway_session_creation_rejection; RELEASE gateway_session_creation_rejection");
      throw error;
    }
  }

  private assertPendingCreationMount(record: SessionCreationRecord, mount: SessionCreationRecord["mounts"][number]): void {
    const trace = this.db.prepare("SELECT scope, attachment_key, stage, status, details FROM attachment_stage_receipts WHERE id=?").get(mount.intentId!);
    const message = record.message;
    const expectedScope = JSON.stringify([message.channelType, message.installationId, message.tenantId,
      message.conversationId, message.threadId, message.messageId]);
    const expectedDetails = { bytes: mount.details.bytes, sha256: mount.details.sha256,
      fileId: mount.details.fileId, mountPath: mount.details.mountPath };
    let traceDetails: unknown;
    try { traceDetails = trace ? JSON.parse(String(trace.details)) : undefined; }
    catch { throw new Error("Session创建附件阶段回执损坏，不能确认挂载"); }
    if (traceDetails && typeof traceDetails === "object" && !Array.isArray(traceDetails) && Object.hasOwn(traceDetails, "failure")) {
      const { failure, ...bindingDetails } = traceDetails as Record<string, unknown>;
      if (configFingerprint(failure) !== configFingerprint(sanitizeFailure(failure))) {
        throw new Error("Session创建附件意图包含未净化的诊断，不能确认挂载");
      }
      // 未决请求的安全诊断不是绑定字段；保留在原阶段回执中，但不能放过其他额外字段。
      traceDetails = bindingDetails;
    }
    if (!trace || trace.scope !== expectedScope || trace.attachment_key !== mount.key || trace.stage !== "mount"
      || trace.status !== "pending" || configFingerprint(traceDetails) !== configFingerprint(expectedDetails)) {
      throw new Error("Session创建附件意图与阶段回执不一致，不能确认挂载");
    }
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

  receiveMessage(message: ChannelMessage, binding: InboxBinding): InboxTask | undefined {
    return this.messageTransaction(() => {
      const existing = this.inbox.findMessage(message);
      const eventKey = this.eventKey(message.channelType, message.installationId, message.messageId);
      const event = this.db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").get(eventKey);
      if (existing) {
        if (!event) throw new Error("持久化消息缺少对应接收记录，不能自动重建或重放");
        return undefined;
      }
      // 老版本缺少执行阶段证据，即使记录过期或failed也不能推断可以安全重放。
      if (event || (message.channelType === "lark" && this.db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").get(message.messageId))) return undefined;
      this.db.prepare("INSERT INTO processed_events (event_id, status, updated_at) VALUES (?, 'processing', ?)")
        .run(eventKey, new Date().toISOString());
      return this.inbox.enqueue(message, binding);
    });
  }

  dispatchMessage(id: string, sessionId: string, requestFingerprint: string): InboxTask {
    return this.messageTransaction(() => {
      const task = this.inbox.dispatched(id, sessionId, requestFingerprint);
      this.updateMessageEvent(task, "processing", true);
      return task;
    });
  }

  claimPreparedMessage(expected: InboxTask, binding: InboxBinding): InboxTask {
    return this.messageTransaction(() => {
      const task = this.inbox.claimPreparation(expected, binding);
      this.updateMessageEvent(task, "processing", false, "uncertain");
      return task;
    });
  }

  finishMessage(id: string, outcome: "completed" | "failed" | "awaiting_authorization"): InboxTask {
    return this.messageTransaction(() => {
      const task = this.inbox.finish(id, outcome);
      this.updateMessageEvent(task, task.state, Boolean(task.sessionId));
      return task;
    });
  }

  confirmMessageReply(id: string, result: RunResult, dispatchId?: string): InboxTask {
    return this.messageTransaction(() => {
      const task = this.inbox.confirmReply(id, result, dispatchId);
      this.updateMessageEvent(task, "processing", true);
      return task;
    });
  }

  recordMessageInspection(expected: InboxTask, observation: RunInspection): InboxTask {
    return this.messageTransaction(() => {
      const task = this.inbox.recordInspection(expected, observation);
      this.updateMessageEvent(task, "uncertain", true, "uncertain");
      return task;
    });
  }

  settleInspectedMessage(expected: InboxTask): InboxTask {
    return this.messageTransaction(() => {
      const task = this.inbox.settleInspection(expected);
      this.updateMessageEvent(task, "completed", true, "uncertain");
      return task;
    });
  }

  discardInspectedMessage(expected: InboxTask): InboxTask {
    return this.messageTransaction(() => {
      const task = this.inbox.discardInspection(expected), message = task.message;
      this.updateMessageEvent(task, "failed", true, "uncertain");
      this.addAuditLog({ channelType: message.channelType, installationId: message.installationId,
        tenantKey: message.tenantId, openId: message.senderId, chatId: message.conversationId, messageId: message.messageId,
        sessionId: task.sessionId, action: "queue_task_discarded", status: "failed",
        summary: "本地管理员确认放弃任务；原MA运行已结束，未重跑任务或撤销外部操作", messageCreateTime: message.createTime });
      return task;
    });
  }

  recoverMessages(channelType: string, installationId: string): ReturnType<MessageInbox["recover"]> {
    return this.messageTransaction(() => {
      const recovered = this.inbox.recover(channelType, installationId);
      for (const task of [...recovered.queued, ...recovered.interrupted, ...recovered.awaitingAuthorization]) {
        const message = task.message;
        const key = this.eventKey(message.channelType, message.installationId, message.messageId);
        const event = this.db.prepare("SELECT status, dispatched FROM processed_events WHERE event_id=?").get(key);
        const expected = task.state === "queued" ? "processing" : task.state;
        // 旧owner刚从preparing/dispatched转为uncertain时，同步另一份日志；整批校验失败则全部回滚。
        if (task.state === "uncertain" && event?.status === "processing") {
          this.updateMessageEvent(task, "uncertain", Boolean(task.sessionId));
        } else if (event?.status !== expected || Boolean(event.dispatched) !== Boolean(task.sessionId)) {
          throw new Error("持久化消息与接收记录不一致，未恢复该批任务");
        }
      }
      return recovered;
    });
  }

  resumeAuthorizationMessage(message: ChannelMessage): InboxTask | undefined {
    return this.messageTransaction(() => {
      const task = this.inbox.findMessage(message);
      if (!task) return undefined;
      const recovery = this.getAuthorizationRecovery(message);
      if (recovery?.state !== "resuming" || recovery.sessionId !== task.sessionId) throw new Error("授权续跑与持久化任务绑定不一致");
      const resumed = this.inbox.transitionAuthorization(task.id, "preparing");
      this.updateMessageEvent(resumed, "processing", true, "awaiting_authorization");
      return resumed;
    });
  }

  settleAuthorizationMessage(message: ChannelMessage): boolean {
    return this.messageTransaction(() => {
      const task = this.inbox.findMessage(message);
      if (!task || task.state !== "awaiting_authorization") return false;
      const recovery = this.getAuthorizationRecovery(message);
      if (!recovery || recovery.sessionId !== task.sessionId || ["waiting", "resuming", "completed"].includes(recovery.state)) return false;
      const settled = this.inbox.transitionAuthorization(task.id, "failed");
      this.updateMessageEvent(settled, "failed", true, "awaiting_authorization");
      return true;
    });
  }

  private updateMessageEvent(task: InboxTask, status: string, dispatched: boolean, previous = "processing"): void {
    const message = task.message;
    const result = this.db.prepare(`UPDATE processed_events SET status = ?, dispatched = MAX(dispatched, ?), updated_at = ?
      WHERE event_id = ? AND status = ?`)
      .run(status, dispatched ? 1 : 0, new Date().toISOString(), this.eventKey(message.channelType, message.installationId, message.messageId), previous);
    if (Number(result.changes) !== 1) throw new Error("消息接收记录缺失或状态已变化，不能更新执行检查点");
  }

  private messageTransaction<T>(operation: () => T): T {
    this.assertRuntimeLock();
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  claimEvent(channelType: string, installationId: string, eventId: string, now = Date.now()): boolean {
    // 持久化任务只能经Inbox领取；旧入口的超时重试不能绕过队列和未知结果保护。
    if (this.db.prepare("SELECT 1 FROM gateway_message_inbox WHERE event_key = ?")
      .get(JSON.stringify([channelType, installationId, eventId]))) return false;
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

  pendingInlineSources(sessionId: string): Array<StoredAttachment & { key: string }> {
    // 将整轮恢复请求展开为逐文件待办；本轮预算未容纳的原文留给下一轮。
    if (this.db.prepare("SELECT 1 FROM inline_restore_pending WHERE session_id = ?").get(sessionId)) {
      this.db.exec("SAVEPOINT inline_restore_expand");
      try {
        this.db.prepare(`INSERT OR IGNORE INTO inline_restore_sources (session_id, attachment_key)
          SELECT m.session_id, m.attachment_key FROM attachment_mounts m JOIN attachments a ON a.attachment_key=m.attachment_key
          WHERE m.session_id=? AND json_type(a.payload, '$.inlineText')='text'`).run(sessionId);
        this.db.prepare("DELETE FROM inline_restore_pending WHERE session_id = ?").run(sessionId);
        this.db.exec("RELEASE inline_restore_expand");
      } catch (error) {
        this.db.exec("ROLLBACK TO inline_restore_expand; RELEASE inline_restore_expand"); throw error;
      }
    }
    const rows = this.db.prepare(`SELECT a.attachment_key, a.payload FROM attachments a JOIN inline_restore_sources r
      ON a.attachment_key=r.attachment_key WHERE r.session_id=? ORDER BY a.created_at DESC, a.attachment_key`).all(sessionId) as { attachment_key: string; payload: string }[];
    return rows.map(row => ({ ...JSON.parse(row.payload) as StoredAttachment, key: row.attachment_key })).filter(item => item.inlineText !== undefined);
  }

  completeInlineRestore(sessionId: string, deliveredKeys: readonly string[] = []): void {
    const remove = this.db.prepare("DELETE FROM inline_restore_sources WHERE session_id=? AND attachment_key=?");
    for (const key of new Set(deliveredKeys)) remove.run(sessionId, key);
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
    const log: AuditLog = { channelType: "lark", installationId: "legacy", ...input,
      ...(input.fileObservation ? { fileObservation: sanitizeFileObservation(input.fileObservation) } : {}), id: randomUUID(), createdAt: new Date().toISOString() };
    this.db.prepare(`INSERT INTO audit_logs
      (id, channel_type, installation_id, tenant_key, open_id, chat_id, message_id, session_id, action, status, duration_ms, request_id, summary, response_summary, message_create_time, created_at, file_observation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(log.id, log.channelType, log.installationId, log.tenantKey, log.openId, log.chatId, log.messageId, log.sessionId || null, log.action, log.status, log.durationMs ?? null, log.requestId || null, log.summary || null, log.responseSummary || null, log.messageCreateTime ?? null, log.createdAt,
      log.fileObservation ? JSON.stringify(log.fileObservation) : null);
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
      ...(row.file_observation ? { fileObservation: parseStoredFileObservation(String(row.file_observation)) } : {}),
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

  private authorizationRequestKey(message: ChannelMessage): string {
    return JSON.stringify([message.channelType, message.installationId, message.tenantId, message.conversationId,
      message.threadId || "", message.senderId, message.messageId]);
  }

  startAuthorizationRecovery(message: ChannelMessage, sessionId: string, evidence?: RunEvidence): boolean {
    const key = this.authorizationRequestKey(message);
    const sealed = evidence ? this.credentials.sealAuthorization(JSON.stringify(evidence), `recovery:${key}:${sessionId}`) : null;
    return Number(this.db.prepare("INSERT OR IGNORE INTO authorization_recoveries (request_key, session_id, state, updated_at, evidence) VALUES (?, ?, 'waiting', ?, ?)")
      .run(key, sessionId, new Date().toISOString(), sealed).changes) === 1;
  }

  getAuthorizationRecovery(message: ChannelMessage): { sessionId: string; state: AuthorizationRecoveryState; evidence?: RunEvidence } | undefined {
    const key = this.authorizationRequestKey(message);
    const row = this.db.prepare("SELECT session_id, state, evidence FROM authorization_recoveries WHERE request_key = ?")
      .get(key) as { session_id: string; state: AuthorizationRecoveryState; evidence: string | null } | undefined;
    return row ? { sessionId: row.session_id, state: row.state, ...(row.evidence ? {
      evidence: JSON.parse(this.credentials.openAuthorization(row.evidence, `recovery:${key}:${row.session_id}`)) as RunEvidence
    } : {}) } : undefined;
  }

  claimAuthorizationRecovery(message: ChannelMessage): boolean {
    return Number(this.db.prepare("UPDATE authorization_recoveries SET state = 'resuming', updated_at = ? WHERE request_key = ? AND state = 'waiting'")
      .run(new Date().toISOString(), this.authorizationRequestKey(message)).changes) === 1;
  }

  finishAuthorizationRecovery(message: ChannelMessage, state: Exclude<AuthorizationRecoveryState, "waiting" | "resuming">): void {
    this.db.prepare("UPDATE authorization_recoveries SET state = ?, updated_at = ? WHERE request_key = ? AND state IN ('waiting', 'resuming')")
      .run(state, new Date().toISOString(), this.authorizationRequestKey(message));
  }

  finishAuthorizationFlow(flow: AuthorizationFlow, phase: "cancelled" | "expired" | "failed" | "uncertain"): AuthorizationFlow {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.authorizations.save(flow.identity, flow, { phase });
      for (const message of flow.messages) this.finishAuthorizationRecovery(message, phase === "uncertain" ? "blocked" : phase);
      this.db.exec("COMMIT");
      return updated;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  stageAuthorizationCredential(flow: AuthorizationFlow, tokens: OAuthTokens, defaultScopes: string[]): AuthorizationFlow {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.credentials.get(flow.identity);
      if (!current || flow.phase !== "verifying") throw new Error("授权凭证绑定或身份校验阶段不正确");
      this.credentials.save(flow.identity, { ...current, status: "sync_pending", retryAfter: undefined,
        refreshToken: tokens.refreshToken, pendingAccessToken: tokens.accessToken, expiresAt: tokens.expiresAt,
        scopes: tokens.scopes ?? defaultScopes }, current.revision);
      const updated = this.authorizations.save(flow.identity, flow, { phase: "sync_pending", tokens: undefined });
      this.db.exec("COMMIT");
      return updated;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
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

  assertRuntimeLock(): string {
    const owner = this.db.prepare("SELECT token FROM gateway_runtime_lock WHERE id = 1").get() as { token: string } | undefined;
    if (!this.runtimeToken || owner?.token !== this.runtimeToken) throw new Error("恢复授权前必须持有Gateway数据库运行锁");
    return this.runtimeToken;
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
