import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ChannelMessage, ReplyDeliveryEvent, ReplyObservation } from "./channel.ts";
import { advanceReplyDelivery, replyContentFingerprint, replyInspectionQuery, replyProofMatches, validateReplyDelivery, validReplyFingerprint, type ReplyDeliveryState } from "./reply-delivery.ts";
import type { CredentialStateStore } from "./credential-state.ts";
import type { RunInspection, RunResult } from "./ark.ts";

export type InboxState = "queued" | "preparing" | "dispatched" | "awaiting_authorization" | "completed" | "failed" | "uncertain";
export type InboxBinding = { scope: string; agentId: string; configFingerprint: string };
export type InboxPreparation = {
  sessionId: string; input: string; fingerprint: string; notices: string[];
  contextReceipts: Array<{ id: string; fingerprint: string }>; preparedAt: number;
};
export type InboxTask = {
  id: string; sequence: number; revision: number; state: InboxState; owner: string;
  message: ChannelMessage; binding: InboxBinding; sessionId?: string; requestFingerprint?: string;
  interruptedAt?: "preparing" | "dispatched";
  preparation?: InboxPreparation;
  replyConfirmed?: true;
  replyResultFingerprint?: string;
  dispatchId?: string;
  replyIntent?: { resultFingerprint: string; contentFingerprint: string };
  delivery?: ReplyDeliveryState;
  replyInspection?: ReplyObservation;
  inspection?: { checkedAt: number; observation: RunInspection };
  resolution?: { action: "discard"; actor: "local_admin"; at: number; runCheckedAt: number };
};
type Row = Record<string, unknown>;
const states = new Set<InboxState>(["queued", "preparing", "dispatched", "awaiting_authorization", "completed", "failed", "uncertain"]);

// 接收日志与业务执行分离。只有queued或完整准备且未派发的检查点可领取，其他preparing不得重跑。
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

  prepare(id: string, value: Omit<InboxPreparation, "fingerprint" | "preparedAt">): InboxTask {
    const task = this.owned(id);
    if (task.state !== "preparing" || hasDispatchEvidence(task) || task.message.text.trim().startsWith("/")) {
      throw new Error("当前任务状态或派发证据不允许保存准备检查点");
    }
    if (!hasExactKeys(value, ["sessionId", "input", "notices", "contextReceipts"]) || typeof value.input !== "string") {
      throw new Error("准备检查点结构无效");
    }
    const preparation: InboxPreparation = { sessionId: value.sessionId, input: value.input,
      fingerprint: createHash("sha256").update(value.input).digest("hex"), notices: value.notices,
      contextReceipts: value.contextReceipts, preparedAt: task.preparation?.preparedAt ?? Date.now() };
    validatePreparation(preparation);
    if (task.preparation) {
      if (JSON.stringify(task.preparation) !== JSON.stringify(preparation)) throw new Error("已保存的准备检查点不能被替换");
      return task;
    }
    return this.save(task, { ...task, preparation: structuredClone(preparation) });
  }

  claimPreparation(expected: InboxTask, expectedBinding: InboxBinding): InboxTask {
    const owner = this.runtimeOwner();
    return this.transaction(() => {
      const task = this.expectedUncertain(expected);
      if (expected.state !== "uncertain" || expected.interruptedAt !== "preparing" || task.interruptedAt !== "preparing"
        || !task.preparation || hasDispatchEvidence(task) || task.message.text.trim().startsWith("/")
        || JSON.stringify(task.preparation) !== JSON.stringify(expected.preparation)) throw new Error("任务缺少可领取的完整准备检查点");
      validatePreparation(task.preparation);
      if (!expectedBinding || task.binding.scope !== expectedBinding.scope || task.binding.agentId !== expectedBinding.agentId
        || task.binding.configFingerprint !== expectedBinding.configFingerprint) throw new Error("准备任务配置绑定已变化");
      const blocker = this.db.prepare(`SELECT 1 FROM gateway_message_inbox WHERE channel_type=? AND installation_id=? AND scope=?
        AND id<>? AND (state IN ('preparing', 'dispatched', 'uncertain', 'awaiting_authorization') OR (state='queued' AND sequence<?)) LIMIT 1`)
        .get(task.message.channelType, task.message.installationId, task.binding.scope, task.id, task.sequence);
      if (blocker) throw new Error("此会话前序任务尚未完成，不能领取准备检查点");
      // prepared Session只属于准备证据，不提前把接收日志标成已经派发模型。
      return this.save(task, { ...task, state: "preparing", owner, interruptedAt: undefined });
    });
  }

  transitionAuthorization(id: string, state: "preparing" | "failed"): InboxTask {
    const owner = this.runtimeOwner(), task = this.get(id);
    if (!task || task.state !== "awaiting_authorization") throw new Error("任务不在授权等待状态");
    return this.save(task, { ...task, owner, state, preparation: undefined });
  }

  dispatched(id: string, sessionId: string, requestFingerprint: string): InboxTask {
    const task = this.owned(id);
    if (task.state !== "preparing" || !sessionId || !requestFingerprint) throw new Error("任务状态不允许记录派发");
    if (task.preparation && (task.preparation.sessionId !== sessionId || task.preparation.fingerprint !== requestFingerprint)) {
      throw new Error("派发的Session或输入指纹与准备检查点不一致");
    }
    return this.save(task, { ...task, state: "dispatched", sessionId, requestFingerprint, preparation: undefined, dispatchId: randomUUID(), replyConfirmed: undefined, replyResultFingerprint: undefined, replyIntent: undefined, delivery: undefined, replyInspection: undefined, inspection: undefined });
  }

  planReply(id: string, result: RunResult, text: string, dispatchId?: string): InboxTask {
    const task = this.owned(id);
    this.assertDispatch(task, dispatchId);
    if (task.state !== "dispatched" || task.delivery?.phase === "completed") throw new Error("当前任务不能设置回复意图");
    if (result?.authorizationRequired) throw new Error("授权提示不能作为最终回复意图");
    if (typeof text !== "string") throw new Error("回复正文无效");
    const replyIntent = { resultFingerprint: this.resultFingerprint(result), contentFingerprint: replyContentFingerprint(text) };
    if (task.replyIntent && JSON.stringify(task.replyIntent) !== JSON.stringify(replyIntent)) throw new Error("最终回复意图不能被替换");
    return this.save(task, { ...task, replyIntent });
  }

  recordReplyDelivery(id: string, event: ReplyDeliveryEvent, dispatchId?: string): InboxTask {
    const task = this.owned(id);
    this.assertDispatch(task, dispatchId);
    if (task.state !== "dispatched") throw new Error("当前任务不能记录回复投递");
    const delivery = advanceReplyDelivery(task.delivery, event);
    const confirmed = delivery.phase === "completed" && task.replyIntent;
    if (confirmed && task.replyIntent!.contentFingerprint !== delivery.contentFingerprint) throw new Error("实际投递正文与最终回复不一致");
    return this.save(task, { ...task, delivery, ...(confirmed ? { replyConfirmed: true, replyResultFingerprint: task.replyIntent!.resultFingerprint } : {}) });
  }

  confirmReply(id: string, result: RunResult, dispatchId?: string): InboxTask {
    const task = this.owned(id);
    this.assertDispatch(task, dispatchId);
    if (task.state !== "dispatched") throw new Error("当前任务状态不能确认回复");
    if (result?.authorizationRequired) throw new Error("授权等待提示不是最终回复");
    if (task.delivery && (task.delivery.phase !== "completed" || !task.replyIntent || task.delivery.contentFingerprint !== task.replyIntent.contentFingerprint
      || this.resultFingerprint(result) !== task.replyIntent.resultFingerprint)) throw new Error("回复投递尚未完成或正文不一致");
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

  discardInspection(expected: InboxTask): InboxTask {
    const task = this.expectedUncertain(expected), inspection = task.inspection, now = Date.now();
    if (task.interruptedAt !== "dispatched" || !task.sessionId || !task.requestFingerprint || !inspection
      || inspection.observation.status !== "ended" || inspection.observation.result.authorizationRequired
      || typeof inspection.observation.anchorEventId !== "string" || !inspection.observation.anchorEventId.trim()
      || typeof inspection.observation.terminalEventId !== "string" || !inspection.observation.terminalEventId.trim()
      || !Number.isSafeInteger(inspection.checkedAt) || inspection.checkedAt > now || now - inspection.checkedAt > 30_000) {
      throw new Error("尚未确认原运行已结束，或仍需处理授权，不能放弃任务");
    }
    this.resultFingerprint(inspection.observation.result);
    // 放弃不补造回复确认，不撤销已经发生的外部业务操作。
    return this.save(task, { ...task, owner: this.runtimeOwner(), state: "failed",
      resolution: { action: "discard", actor: "local_admin", at: now, runCheckedAt: inspection.checkedAt } });
  }

  listPending(channelType: string, installationId: string, agentId: string, after = 0): { tasks: InboxTask[]; next?: number } {
    this.runtimeOwner();
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("任务分页游标无效");
    const rows = this.db.prepare(`SELECT * FROM gateway_message_inbox WHERE channel_type=? AND installation_id=? AND agent_id=?
      AND state NOT IN ('completed', 'failed') AND sequence>? ORDER BY sequence LIMIT 101`).all(channelType, installationId, agentId, after);
    const tasks = rows.slice(0, 100).map(row => this.decode(row));
    return { tasks, ...(rows.length > 100 ? { next: tasks.at(-1)!.sequence } : {}) };
  }

  recordReplyInspection(expected: InboxTask, observation: ReplyObservation): InboxTask {
    const task = this.expectedUncertain(expected), run = task.inspection, now = Date.now();
    const query = replyInspectionQuery(task.delivery, task.replyIntent?.contentFingerprint);
    if (!task.dispatchId || !query || !run || run.observation.status !== "ended" || run.observation.result.authorizationRequired
      || now - run.checkedAt > 30_000 || task.replyIntent!.resultFingerprint !== this.resultFingerprint(run.observation.result)) throw new Error("原运行核查或回复意图不足以确认投递");
    if (observation.status === "unknown") {
      if (!["unsupported", "unavailable", "invalid_response", "identity_mismatch", "content_mismatch", "streaming", "cancelled"].includes(observation.reason)) throw new Error("回复核查原因无效");
      return this.save(task, { ...task, replyInspection: { status: "unknown", reason: observation.reason } });
    }
    if (observation.status !== "confirmed" || !replyProofMatches(query, observation) || !Number.isSafeInteger(observation.observedAt)
      || observation.observedAt < run.checkedAt || observation.observedAt > now || now - observation.observedAt > 30_000) throw new Error("回复核查证明过期或不匹配");
    const proof: ReplyObservation = query.mode === "text_messages"
      ? { status: "confirmed", mode: "text_messages", messageIds: [...query.messageIds], contentFingerprint: query.contentFingerprint, observedAt: observation.observedAt }
      : { status: "confirmed", messageId: query.messageId, elementId: query.elementId, contentFingerprint: query.contentFingerprint, observedAt: observation.observedAt };
    return this.save(task, { ...task, replyInspection: proof, replyConfirmed: true, replyResultFingerprint: task.replyIntent!.resultFingerprint,
      delivery: { ...task.delivery!, phase: "completed", contentFingerprint: query.contentFingerprint, pendingContentFingerprint: undefined } });
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
      || current.sessionId !== expected.sessionId || current.requestFingerprint !== expected.requestFingerprint || current.dispatchId !== expected.dispatchId
      || current.binding.scope !== expected.binding.scope || current.binding.agentId !== expected.binding.agentId
      || current.binding.configFingerprint !== expected.binding.configFingerprint) throw new Error("待核查任务版本或绑定已变化");
    return current;
  }

  private resultFingerprint(result: RunResult): string {
    if (!result || !["idle", "failed"].includes(result.terminal) || !Array.isArray(result.messages) || result.messages.some(text => typeof text !== "string")) throw new Error("回复运行结果结构无效");
    return createHash("sha256").update(JSON.stringify({ terminal: result.terminal, messages: result.messages })).digest("hex");
  }

  private assertDispatch(task: InboxTask, expected?: string): void {
    // 异步Channel回调必须绑定本次派发；授权恢复即使复用taskId和Session也属于下一次派发。
    if (expected !== undefined && expected !== task.dispatchId) throw new Error("回复所属派发已变化，不能写入下一轮任务");
  }

  finish(id: string, outcome: "completed" | "failed" | "awaiting_authorization"): InboxTask {
    const task = this.owned(id);
    if (!["preparing", "dispatched"].includes(task.state)
      || (outcome === "awaiting_authorization" && task.state !== "dispatched")) throw new Error("任务状态不允许结束执行");
    // 准备阶段也可能创建过Session或上传文件；不能因尚未调用模型就假定无副作用。
    const uncertain = outcome === "failed";
    return this.save(task, { ...task, state: uncertain ? "uncertain" : outcome,
      ...(!uncertain ? { preparation: undefined } : {}),
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

  findTask(id: string): InboxTask | undefined {
    this.runtimeOwner();
    return this.get(id);
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
    const payload = { version: 2, message: task.message, replyConfirmed: task.replyConfirmed, replyResultFingerprint: task.replyResultFingerprint,
      preparation: task.preparation, dispatchId: task.dispatchId, replyIntent: task.replyIntent, delivery: task.delivery, replyInspection: task.replyInspection, inspection: task.inspection, resolution: task.resolution };
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
    let checkpoint: Pick<InboxTask, "preparation" | "replyConfirmed" | "replyResultFingerprint" | "dispatchId" | "replyIntent" | "delivery" | "replyInspection" | "inspection" | "resolution"> = {};
    try {
      const payload = JSON.parse(cleartext);
      // 旧密文仅包含ChannelMessage，首次状态更新时升级；不补造旧回复的送达证明。
      if (payload.version === 2 && payload.message) {
        message = payload.message;
        if (payload.preparation !== undefined) {
          validatePreparation(payload.preparation);
          if (!((metadata.state === "preparing" && metadata.interruptedAt === undefined)
              || (metadata.state === "uncertain" && metadata.interruptedAt === "preparing"))
            || hasDispatchEvidence({ ...payload, ...metadata }) || typeof message.text !== "string" || message.text.trim().startsWith("/")) {
            throw new Error("invalid preparation state");
          }
        }
        if (payload.replyConfirmed !== undefined && payload.replyConfirmed !== true) throw new Error("invalid receipt");
        if (payload.replyConfirmed && !/^[a-f0-9]{64}$/.test(payload.replyResultFingerprint)) throw new Error("invalid receipt fingerprint");
        if (payload.delivery) validateReplyDelivery(payload.delivery);
        if (payload.dispatchId !== undefined && (typeof payload.dispatchId !== "string" || !/^[a-f0-9-]{36}$/.test(payload.dispatchId))) throw new Error("invalid dispatch");
        if (payload.replyIntent && (!validReplyFingerprint(payload.replyIntent.resultFingerprint) || !validReplyFingerprint(payload.replyIntent.contentFingerprint))) throw new Error("invalid intent");
        if (payload.delivery && payload.replyConfirmed && (payload.delivery.phase !== "completed" || !payload.replyIntent
          || payload.replyIntent.resultFingerprint !== payload.replyResultFingerprint || payload.delivery.contentFingerprint !== payload.replyIntent.contentFingerprint)) throw new Error("invalid delivery confirmation");
        if (payload.replyInspection) {
          const proof = payload.replyInspection;
          if (proof.status === "confirmed") {
            const delivered = payload.delivery;
            const query = delivered ? replyInspectionQuery({ ...delivered, phase: delivered.mode === "message" ? "sent" : "finalized" }, payload.replyIntent?.contentFingerprint) : undefined;
            if (!payload.replyConfirmed || proof.contentFingerprint !== payload.replyIntent?.contentFingerprint
              || !query || !replyProofMatches(query, proof) || !Number.isSafeInteger(proof.observedAt) || proof.observedAt <= 0) throw new Error("invalid remote receipt");
          } else if (proof.status !== "unknown" || !["unsupported", "unavailable", "invalid_response", "identity_mismatch", "content_mismatch", "streaming", "cancelled"].includes(proof.reason)) throw new Error("invalid remote inspection");
        }
        if (payload.resolution) {
          const value = payload.resolution;
          if (metadata.state !== "failed" || value.action !== "discard" || value.actor !== "local_admin"
            || !Number.isSafeInteger(value.at) || !Number.isSafeInteger(value.runCheckedAt) || value.runCheckedAt <= 0
            || value.at < value.runCheckedAt || value.at - value.runCheckedAt > 30_000
            || payload.inspection?.checkedAt !== value.runCheckedAt || payload.inspection?.observation?.status !== "ended"
            || payload.inspection.observation.result?.authorizationRequired) throw new Error("invalid resolution");
        }
        checkpoint = { ...(payload.preparation ? { preparation: payload.preparation } : {}),
          ...(payload.replyConfirmed ? { replyConfirmed: true, replyResultFingerprint: payload.replyResultFingerprint } : {}),
          ...(payload.dispatchId ? { dispatchId: payload.dispatchId } : {}), ...(payload.replyIntent ? { replyIntent: payload.replyIntent } : {}),
          ...(payload.delivery ? { delivery: payload.delivery } : {}), ...(payload.replyInspection ? { replyInspection: payload.replyInspection } : {}), ...(payload.inspection ? { inspection: payload.inspection } : {}),
          ...(payload.resolution ? { resolution: payload.resolution } : {}) };
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

function hasDispatchEvidence(task: Partial<InboxTask>): boolean {
  return [task.sessionId, task.requestFingerprint, task.dispatchId, task.replyConfirmed, task.replyResultFingerprint,
    task.replyIntent, task.delivery, task.replyInspection, task.inspection, task.resolution].some(value => value !== undefined);
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)));
}

function boundedIdentifier(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && Boolean(value) && !/\s|[\u0000-\u001f\u007f]/.test(value) && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validatePreparation(value: unknown): asserts value is InboxPreparation {
  if (!hasExactKeys(value, ["sessionId", "input", "fingerprint", "notices", "contextReceipts", "preparedAt"])
    || !boundedIdentifier(value.sessionId, 256) || typeof value.input !== "string" || Buffer.byteLength(value.input, "utf8") > 2 * 1024 * 1024
    || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || createHash("sha256").update(value.input).digest("hex") !== value.fingerprint
    || !Number.isSafeInteger(value.preparedAt) || Number(value.preparedAt) <= 0 || Number(value.preparedAt) > Date.now()
    || !Array.isArray(value.notices) || value.notices.length > 128
    || Array.from(value.notices).some(notice => typeof notice !== "string" || Buffer.byteLength(notice, "utf8") > 4096)
    || !Array.isArray(value.contextReceipts) || value.contextReceipts.length > 128
    || Array.from(value.contextReceipts).some(receipt => !hasExactKeys(receipt, ["id", "fingerprint"])
      || !boundedIdentifier(receipt.id, 512) || !boundedIdentifier(receipt.fingerprint, 256))
    || new Set(value.contextReceipts.map(receipt => receipt.id)).size !== value.contextReceipts.length) {
    throw new Error("准备检查点结构无效或超过大小上限");
  }
}
