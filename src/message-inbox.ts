import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ChannelMessage } from "./channel.ts";
import type { CredentialStateStore } from "./credential-state.ts";
import type { RunInspection, RunResult } from "./ark.ts";

export type InboxState = "queued" | "preparing" | "dispatched" | "awaiting_authorization" | "completed" | "failed" | "uncertain";
export type InboxBinding = { scope: string; agentId: string; configFingerprint: string };
export type InboxTask = {
  id: string; sequence: number; revision: number; state: InboxState; owner: string;
  message: ChannelMessage; binding: InboxBinding; sessionId?: string; requestFingerprint?: string;
  interruptedAt?: "preparing" | "dispatched";
  replyConfirmed?: true;
  replyResultFingerprint?: string;
  inspection?: { checkedAt: number; observation: RunInspection };
};
type Row = Record<string, unknown>;
const states = new Set<InboxState>(["queued", "preparing", "dispatched", "awaiting_authorization", "completed", "failed", "uncertain"]);

// 接收日志与业务执行分离。只有queued可重新领取，preparing已可能产生外部副作用。
export class MessageInbox {
  private db: DatabaseSync;
  private credentials: CredentialStateStore;
  private runtimeOwner: () => string;
  constructor(db: DatabaseSync, credentials: CredentialStateStore, runtimeOwner: () => string) {
    this.db = db; this.credentials = credentials; this.runtimeOwner = runtimeOwner;
    db.exec(`CREATE TABLE IF NOT EXISTS gateway_message_inbox (
      sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, event_key TEXT NOT NULL UNIQUE,
      channel_type TEXT NOT NULL, installation_id TEXT NOT NULL,
      scope TEXT NOT NULL, agent_id TEXT NOT NULL, config_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL, owner TEXT NOT NULL, revision INTEGER NOT NULL,
      session_id TEXT, request_fingerprint TEXT, interrupted_at TEXT, secret TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gateway_inbox_pending ON gateway_message_inbox(installation_id, state, sequence);`);
  }

  enqueue(message: ChannelMessage, binding: InboxBinding): InboxTask | undefined {
    this.runtimeOwner();
    this.validate(message, binding);
    return this.transaction(() => {
      const eventKey = this.eventKey(message);
      if (this.findMessage(message)) return undefined;
      const sequence = Number(this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM gateway_message_inbox").get()!.next);
      const task: InboxTask = { id: randomUUID(), sequence, revision: 1, state: "queued", owner: "",
        message: structuredClone(message), binding: structuredClone(binding) };
      const secret = this.encode(task);
      this.db.prepare(`INSERT INTO gateway_message_inbox
        (sequence, id, event_key, channel_type, installation_id, scope, agent_id, config_fingerprint, state, owner, revision, secret)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(sequence, task.id, eventKey, message.channelType, message.installationId, binding.scope, binding.agentId,
          binding.configFingerprint, task.state, task.owner, task.revision, secret);
      return task;
    });
  }

  findMessage(message: ChannelMessage): InboxTask | undefined {
    this.runtimeOwner();
    const row = this.db.prepare("SELECT * FROM gateway_message_inbox WHERE event_key = ?").get(this.eventKey(message));
    if (!row) return undefined;
    const original = this.decode(row);
    // 重复投递可以带新的eventId，不能借相同messageId切换到别的用户或会话。
    if (original.message.tenantId !== message.tenantId || original.message.senderId !== message.senderId
      || original.message.conversationId !== message.conversationId || original.message.threadId !== message.threadId) {
      throw new Error("重复消息的身份或会话与原记录不一致");
    }
    return original;
  }

  claim(id: string, expectedBinding: InboxBinding, resetControl = false): InboxTask | undefined {
    const owner = this.runtimeOwner();
    return this.transaction(() => {
      const task = this.get(id);
      if (!task || task.state !== "queued") return undefined;
      if (!expectedBinding || task.binding.scope !== expectedBinding.scope || task.binding.agentId !== expectedBinding.agentId
        || task.binding.configFingerprint !== expectedBinding.configFingerprint) throw new Error("排队任务配置已变化，请明确处理原配置任务，不能隐式换Agent或身份范围");
      if (resetControl && (task.message.conversationType !== "direct" || task.message.text.trim() !== "/new")) throw new Error("只有单聊显式重置可走控制领取");
      const blocker = this.db.prepare(`SELECT 1 FROM gateway_message_inbox WHERE channel_type=? AND installation_id=? AND scope=?
        AND id<>? AND (state IN ('preparing', 'dispatched', 'uncertain', 'awaiting_authorization') OR (state='queued' AND sequence<? AND ?=0)) LIMIT 1`)
        .get(task.message.channelType, task.message.installationId, task.binding.scope, task.id, task.sequence, resetControl ? 1 : 0);
      if (blocker) return undefined;
      return this.save(task, { ...task, state: "preparing", owner });
    });
  }

  transitionAuthorization(id: string, state: "preparing" | "failed"): InboxTask {
    const owner = this.runtimeOwner(), task = this.get(id);
    if (!task || task.state !== "awaiting_authorization") throw new Error("任务不在授权等待状态");
    return this.save(task, { ...task, owner, state });
  }

  dispatched(id: string, sessionId: string, requestFingerprint: string): InboxTask {
    const task = this.owned(id);
    if (task.state !== "preparing" || !sessionId || !requestFingerprint) throw new Error("任务状态不允许记录派发");
    return this.save(task, { ...task, state: "dispatched", sessionId, requestFingerprint, replyConfirmed: undefined, replyResultFingerprint: undefined, inspection: undefined });
  }

  confirmReply(id: string, result: RunResult): InboxTask {
    const task = this.owned(id);
    if (task.state !== "dispatched") throw new Error("当前任务状态不能确认回复");
    if (result?.authorizationRequired) throw new Error("授权等待提示不是最终回复");
    return this.save(task, { ...task, replyConfirmed: true, replyResultFingerprint: this.resultFingerprint(result) });
  }

  recordInspection(expected: InboxTask, observation: RunInspection): InboxTask {
    const task = this.expectedUncertain(expected);
    if (task.interruptedAt !== "dispatched" || !task.sessionId || !task.requestFingerprint) throw new Error("任务没有可核查的派发绑定");
    if (!["unknown", "running", "ended"].includes(observation?.status) || JSON.stringify(observation).length > 2 * 1024 * 1024) throw new Error("运行核查结果无效或超过大小上限");
    return this.save(task, { ...task, owner: this.runtimeOwner(), inspection: { checkedAt: Date.now(), observation: structuredClone(observation) } });
  }

  settleInspection(expected: InboxTask): InboxTask {
    const task = this.expectedUncertain(expected), inspection = task.inspection;
    if (!inspection || inspection.observation.status !== "ended" || !task.replyConfirmed
      || inspection.observation.result.authorizationRequired || Date.now() - inspection.checkedAt > 30_000
      || task.replyResultFingerprint !== this.resultFingerprint(inspection.observation.result)) throw new Error("原运行核查、回复确认或授权状态不足以结束任务");
    return this.save(task, { ...task, owner: this.runtimeOwner(), state: "completed" });
  }

  hasBlockingTasks(message: ChannelMessage, binding: InboxBinding): boolean {
    this.runtimeOwner();
    return Boolean(this.db.prepare(`SELECT 1 FROM gateway_message_inbox WHERE channel_type=? AND installation_id=? AND scope=?
      AND state IN ('preparing', 'dispatched', 'uncertain', 'awaiting_authorization') LIMIT 1`).get(message.channelType, message.installationId, binding.scope));
  }

  private expectedUncertain(expected: InboxTask): InboxTask {
    this.runtimeOwner();
    const current = this.get(expected.id);
    if (!current || current.state !== "uncertain" || current.revision !== expected.revision
      || current.sessionId !== expected.sessionId || current.requestFingerprint !== expected.requestFingerprint
      || current.binding.scope !== expected.binding.scope || current.binding.agentId !== expected.binding.agentId
      || current.binding.configFingerprint !== expected.binding.configFingerprint) throw new Error("待核查任务版本或绑定已变化");
    return current;
  }

  private resultFingerprint(result: RunResult): string {
    if (!result || !["idle", "failed"].includes(result.terminal) || !Array.isArray(result.messages) || result.messages.some(text => typeof text !== "string")) throw new Error("回复运行结果结构无效");
    return createHash("sha256").update(JSON.stringify({ terminal: result.terminal, messages: result.messages })).digest("hex");
  }

  finish(id: string, outcome: "completed" | "failed" | "awaiting_authorization"): InboxTask {
    const task = this.owned(id);
    if (!["preparing", "dispatched"].includes(task.state)
      || (outcome === "awaiting_authorization" && task.state !== "dispatched")) throw new Error("任务状态不允许结束执行");
    // 准备阶段也可能创建过Session或上传文件；不能因尚未调用模型就假定无副作用。
    const uncertain = outcome === "failed";
    return this.save(task, { ...task, state: uncertain ? "uncertain" : outcome,
      ...(uncertain ? { interruptedAt: task.state as "preparing" | "dispatched" } : {}) });
  }

  // 调用方必须先恢复授权暂停，再按sequence调度queued；interrupted对应范围须先核查，不能越过它派发后续任务。
  recover(channelType: string, installationId: string): { queued: InboxTask[]; interrupted: InboxTask[]; awaitingAuthorization: InboxTask[] } {
    const owner = this.runtimeOwner();
    return this.transaction(() => {
      const result: { queued: InboxTask[]; interrupted: InboxTask[]; awaitingAuthorization: InboxTask[] } = {
        queued: [], interrupted: [], awaitingAuthorization: []
      };
      const rows = this.db.prepare(`SELECT * FROM gateway_message_inbox WHERE channel_type = ? AND installation_id = ?
        AND state NOT IN ('completed', 'failed') ORDER BY sequence`).all(channelType, installationId);
      // 先验证整批密文；损坏时整个恢复事务回滚，不启动一部分任务。
      const tasks = rows.map(row => this.decode(row));
      for (let task of tasks) {
        if ((task.state === "preparing" || task.state === "dispatched") && task.owner !== owner) {
          task = this.save(task, { ...task, state: "uncertain", interruptedAt: task.state });
        }
        if (task.state === "queued") result.queued.push(task);
        else if (task.state === "uncertain") result.interrupted.push(task);
        else if (task.state === "awaiting_authorization") result.awaitingAuthorization.push(task);
      }
      return result;
    });
  }

  private get(id: string): InboxTask | undefined {
    const row = this.db.prepare("SELECT * FROM gateway_message_inbox WHERE id = ?").get(id);
    return row ? this.decode(row) : undefined;
  }

  private owned(id: string): InboxTask {
    const owner = this.runtimeOwner(), task = this.get(id);
    if (!task || task.owner !== owner) throw new Error("任务状态不属于当前网关，不能覆盖旧执行结果");
    return task;
  }

  private save(previous: InboxTask, update: InboxTask): InboxTask {
    const task = { ...update, revision: previous.revision + 1 }, secret = this.encode(task);
    const result = this.db.prepare(`UPDATE gateway_message_inbox SET state=?, owner=?, revision=?,
      session_id=?, request_fingerprint=?, interrupted_at=?, secret=? WHERE id=? AND revision=?`)
      .run(task.state, task.owner, task.revision, task.sessionId ?? null, task.requestFingerprint ?? null,
        task.interruptedAt ?? null, secret, previous.id, previous.revision);
    if (Number(result.changes) !== 1) throw new Error("任务状态版本已变化，不能重复领取或覆盖");
    return task;
  }

  private eventKey(message: ChannelMessage): string {
    return JSON.stringify([message.channelType, message.installationId, message.messageId]);
  }

  private context(task: Omit<InboxTask, "message"> & { eventKey: string; channelType: string; installationId: string }): string {
    return JSON.stringify(["message-inbox", task.sequence, task.id, task.eventKey, task.channelType, task.installationId,
      task.binding.scope, task.binding.agentId, task.binding.configFingerprint, task.state, task.owner, task.revision,
      task.sessionId ?? null, task.requestFingerprint ?? null, task.interruptedAt ?? null]);
  }

  private encode(task: InboxTask): string {
    const payload = { version: 2, message: task.message, replyConfirmed: task.replyConfirmed, replyResultFingerprint: task.replyResultFingerprint, inspection: task.inspection };
    return this.credentials.sealAuthorization(JSON.stringify(payload), this.context({ ...task,
      eventKey: this.eventKey(task.message), channelType: task.message.channelType, installationId: task.message.installationId }));
  }

  private decode(row: Row): InboxTask {
    const metadata = { id: String(row.id), sequence: Number(row.sequence), revision: Number(row.revision),
      state: row.state as InboxState, owner: String(row.owner),
      binding: { scope: String(row.scope), agentId: String(row.agent_id), configFingerprint: String(row.config_fingerprint) },
      ...(row.session_id !== null ? { sessionId: String(row.session_id) } : {}),
      ...(row.request_fingerprint !== null ? { requestFingerprint: String(row.request_fingerprint) } : {}),
      ...(row.interrupted_at !== null ? { interruptedAt: row.interrupted_at as "preparing" | "dispatched" } : {}) };
    const cleartext = this.credentials.openAuthorization(String(row.secret), this.context({ ...metadata,
      eventKey: String(row.event_key), channelType: String(row.channel_type), installationId: String(row.installation_id) }));
    let message: ChannelMessage;
    let checkpoint: Pick<InboxTask, "replyConfirmed" | "replyResultFingerprint" | "inspection"> = {};
    try {
      const payload = JSON.parse(cleartext);
      // 旧密文仅包含ChannelMessage，首次状态更新时升级；不补造旧回复的送达证明。
      if (payload.version === 2 && payload.message) {
        message = payload.message;
        if (payload.replyConfirmed !== undefined && payload.replyConfirmed !== true) throw new Error("invalid receipt");
        if (payload.replyConfirmed && !/^[a-f0-9]{64}$/.test(payload.replyResultFingerprint)) throw new Error("invalid receipt fingerprint");
        checkpoint = { ...(payload.replyConfirmed ? { replyConfirmed: true, replyResultFingerprint: payload.replyResultFingerprint } : {}), ...(payload.inspection ? { inspection: payload.inspection } : {}) };
      } else message = payload;
    }
    catch { throw new Error("持久化消息结构损坏，未恢复任务"); }
    this.validate(message, metadata.binding);
    if (!states.has(metadata.state) || this.eventKey(message) !== row.event_key || message.channelType !== row.channel_type
      || message.installationId !== row.installation_id) throw new Error("持久化消息身份或状态不一致");
    return { ...metadata, message, ...checkpoint };
  }

  private validate(message: ChannelMessage, binding: InboxBinding): void {
    if (!message || !binding || [message.channelType, message.installationId, message.tenantId, message.senderId,
      message.conversationId, message.messageId, binding.scope, binding.agentId, binding.configFingerprint]
      .some(value => typeof value !== "string" || !value.trim()) || typeof message.text !== "string"
      || !["direct", "group"].includes(message.conversationType) || typeof message.threadId !== "string"
      || !Number.isFinite(message.createTime) || !Array.isArray(message.resources)) throw new Error("持久化消息缺少有效身份、内容或配置绑定");
  }

  private transaction<T>(operation: () => T): T {
    // Store原子接收的外层事务与独立Inbox操作共用此边界；释放savepoint不提交外层事务。
    this.db.exec("SAVEPOINT message_inbox");
    try { const result = operation(); this.db.exec("RELEASE message_inbox"); return result; }
    catch (error) { this.db.exec("ROLLBACK TO message_inbox; RELEASE message_inbox"); throw error; }
  }
}
