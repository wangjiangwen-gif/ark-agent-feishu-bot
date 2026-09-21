import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SessionCreateRequest } from "./ark.ts";
import type { AttachmentTraceStore } from "./attachment-trace.ts";
import type { ChannelMessage } from "./channel.ts";
import type { CredentialStateStore } from "./credential-state.ts";
import { configFingerprint } from "./session-config.ts";
import { sanitizeFailure, type FailureDiagnostic } from "./ark-errors.ts";
import type { ConversationKey, StoredAttachment } from "./store.ts";

export const SESSION_CREATION_OPERATION_TAG = "arkagent_create_operation";
export const SESSION_CREATION_REQUEST_TAG = "arkagent_create_request";

export type SessionCreationInput = {
  message: ChannelMessage; key: ConversationKey; agentId: string; configFingerprint: string;
  request: SessionCreateRequest; reusable: boolean;
  mounts: Array<{ key: string; details: StoredAttachment }>;
};
export type SessionCreationRecord = Omit<SessionCreationInput, "mounts"> & {
  operationId: string; revision: number; state: "pending" | "confirmed" | "rejected";
  scope: string; requestFingerprint: string; createdAt: number; sessionId?: string; failure?: FailureDiagnostic;
  mounts: Array<{ key: string; details: StoredAttachment; intentId?: string }>;
};
type Row = Record<string, unknown>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;

// pending仅表示尚未确认创建结果，不表示请求尚未发出；重启、换配置或/new都不能删除它。
// 使用会话范围唯一约束阻止重复创建，而不是以Agent或配置为键另开一条未知操作。
export class SessionCreationStore {
  private db: DatabaseSync;
  private credentials: CredentialStateStore;
  private traces: AttachmentTraceStore;
  private scopeKey: (key: ConversationKey, reusable: boolean, messageId: string) => string;

  constructor(db: DatabaseSync, credentials: CredentialStateStore, traces: AttachmentTraceStore,
    scopeKey: (key: ConversationKey, reusable: boolean, messageId: string) => string) {
    this.db = db; this.credentials = credentials; this.traces = traces; this.scopeKey = scopeKey;
    const schema = `CREATE TABLE IF NOT EXISTS gateway_session_creations (
      operation_id TEXT PRIMARY KEY, scope TEXT NOT NULL, agent_id TEXT NOT NULL,
      config_fingerprint TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'confirmed', 'rejected')), revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL, session_id TEXT, secret TEXT NOT NULL
    );`;
    const indexes = `CREATE UNIQUE INDEX IF NOT EXISTS gateway_session_creation_pending ON gateway_session_creations(scope) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS gateway_session_creation_latest ON gateway_session_creations(scope, created_at DESC);`;
    db.exec(schema);
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='gateway_session_creations'").get();
    if (!String(table?.sql).includes("'rejected'")) {
      const columns = ["operation_id", "scope", "agent_id", "config_fingerprint", "request_fingerprint", "state", "revision", "created_at", "session_id", "secret"];
      const actual = db.prepare("PRAGMA table_info(gateway_session_creations)").all().map(row => row.name);
      if (JSON.stringify(actual) !== JSON.stringify(columns)
        || !/CHECK\s*\(state IN \('pending', 'confirmed'\)\)/.test(String(table?.sql))) throw new Error("Session创建日志结构未知，未迁移原记录");
      this.transaction(() => {
        // 旧两态表仅扩展CHECK约束，逐字保留密文、rowid与元数据；迁移失败全部回滚。
        db.exec("ALTER TABLE gateway_session_creations RENAME TO gateway_session_creations_legacy");
        db.exec(schema);
        db.exec(`INSERT INTO gateway_session_creations (rowid, ${columns.join(",")})
          SELECT rowid, ${columns.join(",")} FROM gateway_session_creations_legacy`);
        db.exec("DROP TABLE gateway_session_creations_legacy");
        db.exec(indexes);
      });
    }
    db.exec(indexes);
  }

  pending(scope: string): SessionCreationRecord | undefined {
    if (!identifier(scope, 8192)) throw new Error("Session创建范围无效");
    const row = this.db.prepare("SELECT * FROM gateway_session_creations WHERE scope=? AND state='pending'").get(scope);
    return row ? this.decode(row) : undefined;
  }

  latest(scope: string): SessionCreationRecord | undefined {
    if (!identifier(scope, 8192)) throw new Error("Session创建范围无效");
    const row = this.db.prepare("SELECT * FROM gateway_session_creations WHERE scope=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(scope);
    return row ? this.decode(row) : undefined;
  }

  get(operationId: string): SessionCreationRecord | undefined {
    if (!uuid.test(operationId)) throw new Error("Session创建操作标识无效");
    const row = this.db.prepare("SELECT * FROM gateway_session_creations WHERE operation_id=?").get(operationId);
    return row ? this.decode(row) : undefined;
  }

  begin(input: SessionCreationInput): SessionCreationRecord {
    return this.transaction(() => {
      const value = jsonSnapshot(input);
      validateInput(value);
      const scope = this.scopeKey(value.key, value.reusable, value.message.messageId);
      if (this.pending(scope)) throw new Error("Session创建结果待核实，未重复提交创建请求");
      const operationId = randomUUID(), requestFingerprint = configFingerprint(value.request);
      if ((value.request.tags || []).some(tag => [SESSION_CREATION_OPERATION_TAG, SESSION_CREATION_REQUEST_TAG].includes(tag.key))) {
        throw new Error("Session创建请求包含保留的关联标签，不能覆盖原标签");
      }
      const request = { ...value.request, tags: [...(value.request.tags || []),
        { key: SESSION_CREATION_OPERATION_TAG, value: operationId },
        { key: SESSION_CREATION_REQUEST_TAG, value: requestFingerprint }] };
      const record: SessionCreationRecord = { ...value, request, scope, operationId, requestFingerprint,
        state: "pending", revision: 1, createdAt: Date.now(), mounts: value.mounts.map(mount => ({ ...mount,
          ...(mount.details.fileId ? { intentId: this.traces.begin(value.message, mount.key, "mount", mount.details) } : {}) })) };
      this.validateRecord(record);
      this.db.prepare(`INSERT INTO gateway_session_creations
        (operation_id, scope, agent_id, config_fingerprint, request_fingerprint, state, revision, created_at, session_id, secret)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
        .run(record.operationId, record.scope, record.agentId, record.configFingerprint, record.requestFingerprint,
          record.state, record.revision, record.createdAt, this.encode(record));
      return structuredClone(record);
    });
  }

  // 仅供GatewayStore的原子确认事务使用；不触发任何远端请求或模型派发。
  confirm(expected: SessionCreationRecord, sessionId: string): SessionCreationRecord {
    return this.transaction(() => {
      if (!identifier(sessionId, 256)) throw new Error("Session创建回执缺少有效Session标识");
      this.validateRecord(expected);
      const current = this.get(expected.operationId);
      if (!current || configFingerprint(immutableSnapshot(current)) !== configFingerprint(immutableSnapshot(expected))) {
        throw new Error("Session创建绑定或请求快照已变化，不能确认其他操作");
      }
      if (current.state === "confirmed") {
        const sameRevision = expected.state === "confirmed" && expected.revision === current.revision && expected.sessionId === sessionId;
        const originalRevision = expected.state === "pending" && expected.revision + 1 === current.revision;
        if (current.sessionId !== sessionId || !(sameRevision || originalRevision)) throw new Error("Session创建回执或版本已变化");
        return current;
      }
      if (current.state !== "pending" || expected.state !== "pending" || expected.revision !== current.revision) throw new Error("Session创建状态版本已变化");
      const confirmed: SessionCreationRecord = { ...current, state: "confirmed", revision: current.revision + 1, sessionId };
      const result = this.db.prepare(`UPDATE gateway_session_creations SET state='confirmed', revision=?, session_id=?, secret=?
        WHERE operation_id=? AND revision=? AND state='pending'`)
        .run(confirmed.revision, sessionId, this.encode(confirmed), current.operationId, current.revision);
      if (Number(result.changes) !== 1) throw new Error("Session创建状态版本已变化，不能覆盖回执");
      return confirmed;
    });
  }

  reject(expected: SessionCreationRecord, diagnostic: FailureDiagnostic): SessionCreationRecord {
    return this.transaction(() => {
      const failure = sanitizeFailure(diagnostic);
      if (!definiteRejection(failure)) throw new Error("只有明确400 InvalidParameter回执可以确认Session创建被拒绝");
      this.validateRecord(expected);
      const current = this.get(expected.operationId);
      if (!current || configFingerprint(immutableSnapshot(current)) !== configFingerprint(immutableSnapshot(expected))) {
        throw new Error("Session创建绑定或请求快照已变化，不能确认拒绝其他操作");
      }
      if (current.state === "rejected") {
        const sameRevision = expected.state === "rejected" && expected.revision === current.revision
          && configFingerprint(expected.failure) === configFingerprint(failure);
        const originalRevision = expected.state === "pending" && expected.revision + 1 === current.revision;
        if (configFingerprint(current.failure) !== configFingerprint(failure) || !(sameRevision || originalRevision)) {
          throw new Error("Session创建拒绝回执或版本已变化");
        }
        return current;
      }
      if (current.state !== "pending" || expected.state !== "pending" || current.revision !== expected.revision) {
        throw new Error("Session创建状态已变化，不能标记拒绝");
      }
      const rejected: SessionCreationRecord = { ...current, state: "rejected", revision: current.revision + 1, failure };
      const result = this.db.prepare(`UPDATE gateway_session_creations SET state='rejected', revision=?, secret=?
        WHERE operation_id=? AND revision=? AND state='pending'`)
        .run(rejected.revision, this.encode(rejected), current.operationId, current.revision);
      if (Number(result.changes) !== 1) throw new Error("Session创建状态版本已变化，不能覆盖拒绝回执");
      return rejected;
    });
  }

  private context(record: Pick<SessionCreationRecord, "operationId" | "scope" | "agentId" | "configFingerprint" | "requestFingerprint" | "state" | "revision" | "createdAt" | "sessionId">): string {
    return JSON.stringify(["session-creation", record.operationId, record.scope, record.agentId, record.configFingerprint,
      record.requestFingerprint, record.state, record.revision, record.createdAt, record.sessionId ?? null]);
  }

  private encode(record: SessionCreationRecord): string {
    return this.credentials.sealAuthorization(JSON.stringify({ version: 1, request: record.request, message: record.message,
      key: record.key, reusable: record.reusable, mounts: record.mounts, failure: record.failure }), this.context(record));
  }

  private decode(row: Row): SessionCreationRecord {
    const metadata = { operationId: String(row.operation_id), scope: String(row.scope), agentId: String(row.agent_id),
      configFingerprint: String(row.config_fingerprint), requestFingerprint: String(row.request_fingerprint),
      state: row.state as SessionCreationRecord["state"], revision: Number(row.revision), createdAt: Number(row.created_at),
      ...(row.session_id === null ? {} : { sessionId: String(row.session_id) }) };
    const plaintext = this.credentials.openAuthorization(String(row.secret), this.context(metadata));
    try {
      const payload = JSON.parse(plaintext);
      if (!object(payload) || payload.version !== 1 || !exactKeys(payload, ["version", "request", "message", "key", "reusable", "mounts",
        ...(Object.hasOwn(payload, "failure") ? ["failure"] : [])])) {
        throw new Error("invalid payload");
      }
      const record = { ...metadata, request: payload.request, message: payload.message,
        key: payload.key, reusable: payload.reusable, mounts: payload.mounts,
        ...(Object.hasOwn(payload, "failure") ? { failure: payload.failure } : {}) } as SessionCreationRecord;
      this.validateRecord(record);
      return record;
    } catch { throw new Error("Session创建记录结构损坏，未恢复该创建操作"); }
  }

  private validateRecord(record: SessionCreationRecord): void {
    validateInput(record);
    if (!uuid.test(record.operationId) || !digest.test(record.requestFingerprint) || !identifier(record.scope, 8192)
      || record.scope !== this.scopeKey(record.key, record.reusable, record.message.messageId) || !Number.isSafeInteger(record.createdAt) || record.createdAt <= 0
      || record.createdAt > Date.now() || !["pending", "confirmed", "rejected"].includes(record.state)
      || (record.state === "pending" ? record.revision !== 1 || record.sessionId !== undefined || record.failure !== undefined
        : record.state === "confirmed" ? record.revision !== 2 || !identifier(record.sessionId, 256) || record.failure !== undefined
          : record.revision !== 2 || record.sessionId !== undefined || !definiteRejection(record.failure)
            || configFingerprint(record.failure) !== configFingerprint(sanitizeFailure(record.failure)))) throw new Error("Session创建记录状态、范围或版本无效");
    const tags = record.request.tags || [];
    const operationTags = tags.filter(tag => tag.key === SESSION_CREATION_OPERATION_TAG);
    const requestTags = tags.filter(tag => tag.key === SESSION_CREATION_REQUEST_TAG);
    if (operationTags.length !== 1 || operationTags[0].value !== record.operationId
      || requestTags.length !== 1 || requestTags[0].value !== record.requestFingerprint) throw new Error("Session创建关联标签与绑定不一致");
    const original = { ...record.request, tags: tags.filter(tag => ![SESSION_CREATION_OPERATION_TAG, SESSION_CREATION_REQUEST_TAG].includes(tag.key)) };
    // 原始请求可能没有tags字段，也可能显式传空数组；两种都保留各自原请求指纹。
    const withTags = configFingerprint(original);
    if (!original.tags.length) delete (original as SessionCreateRequest).tags;
    if (withTags !== record.requestFingerprint && configFingerprint(original) !== record.requestFingerprint) throw new Error("Session创建请求指纹不一致");
    if (record.mounts.some(mount => mount.details.fileId ? !mount.intentId || !uuid.test(mount.intentId) : mount.intentId !== undefined)
      || new Set(record.mounts.filter(mount => mount.intentId).map(mount => mount.intentId)).size !== record.mounts.filter(mount => mount.intentId).length) {
      throw new Error("Session创建附件意图无效");
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("SAVEPOINT session_creation_state");
    try { const result = operation(); this.db.exec("RELEASE session_creation_state"); return result; }
    catch (error) { this.db.exec("ROLLBACK TO session_creation_state; RELEASE session_creation_state"); throw error; }
  }
}

function immutableSnapshot(record: SessionCreationRecord): Omit<SessionCreationRecord, "state" | "revision" | "sessionId" | "failure"> {
  const { state, revision, sessionId, failure, ...snapshot } = record;
  return snapshot;
}

function definiteRejection(value: unknown): value is FailureDiagnostic {
  return object(value) && value.kind === "invalid_request" && value.status === 400 && value.code === "InvalidParameter";
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key));
}

function identifier(value: unknown, maxBytes = 512, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || Boolean(value.trim())) && !/[\u0000-\u0020\u007f]/.test(value)
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function jsonSnapshot<T>(value: T): T {
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > 4 * 1024 * 1024) throw new Error("oversize");
    return JSON.parse(serialized);
  } catch { throw new Error("Session创建数据无法保存或超过大小上限"); }
}

function validateInput(value: SessionCreationInput): void {
  const message = value?.message, key = value?.key, request = value?.request;
  if (!object(value) || !object(message) || !object(key) || !object(request)
    || !identifier(value.agentId, 256) || !identifier(value.configFingerprint, 256) || typeof value.reusable !== "boolean"
    || !Array.isArray(value.mounts) || value.mounts.length > 128) throw new Error("Session创建数据缺少有效绑定或结构");
  for (const field of ["channelType", "installationId", "tenantId", "conversationId", "threadId"] as const) {
    if (!identifier(key[field], 512, field === "threadId") || key[field] !== message[field]) throw new Error("Session创建会话范围与消息不一致");
  }
  if (!identifier(message.senderId) || !identifier(key.senderId, 512, true)
    || (key.senderId !== message.senderId && !(message.conversationType === "group" && key.senderId === ""))
    || !identifier(message.messageId) || !["direct", "group"].includes(message.conversationType)
    || typeof message.text !== "string" || !Number.isFinite(message.createTime) || !Array.isArray(message.resources)) {
    throw new Error("Session创建消息身份或内容无效");
  }
  if ((typeof request.agent === "string" ? request.agent : request.agent?.id) !== value.agentId
    || (request.vault_ids !== undefined && (!Array.isArray(request.vault_ids) || request.vault_ids.some(id => !identifier(id))))
    || (request.resources !== undefined && (!Array.isArray(request.resources) || request.resources.some(resource => !object(resource) || !identifier(resource.type))))
    || (request.tags !== undefined && (!Array.isArray(request.tags)
      || request.tags.some(tag => !object(tag) || !identifier(tag.key, 256) || (tag.value !== undefined && typeof tag.value !== "string"))))) {
    throw new Error("Session创建请求与Agent绑定不一致或结构无效");
  }
  const seen = new Set<string>();
  for (const mount of value.mounts) {
    const details = mount?.details;
    if (!object(mount) || !digest.test(mount.key) || seen.has(mount.key) || !object(details)
      || typeof details.name !== "string" || !details.name || Buffer.byteLength(details.name) > 4096
      || typeof details.mountPath !== "string" || !details.mountPath || Buffer.byteLength(details.mountPath) > 4096
      || !Number.isSafeInteger(details.bytes) || details.bytes < 0 || (details.sha256 !== undefined && !digest.test(details.sha256))
      || (details.fileId !== undefined ? !identifier(details.fileId, 256) || details.inlineText !== undefined
        : typeof details.inlineText !== "string")
      || (details.fileId && !(request.resources || []).some(resource => resource.type === "file"
        && resource.file_id === details.fileId && resource.mount_path === details.mountPath))) throw new Error("Session创建附件绑定无效");
    seen.add(mount.key);
  }
  jsonSnapshot(value);
}
