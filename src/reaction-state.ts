import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ChannelMessage } from "./channel.ts";
import type { CredentialStateStore } from "./credential-state.ts";
import type { MessageInbox } from "./message-inbox.ts";

export type ReactionReceipt = { id: string; taskId: string; owner: string; revision: number;
  phase: "creating" | "active" | "removing"; emoji: "Get" | "OnIt"; reactionId?: string };

// 表情补偿独立于任务状态：清理失败不能导致模型重跑，也不能使运行核查的CAS失效。
export class ReactionStateStore {
  private db: DatabaseSync;
  private credentials: CredentialStateStore;
  private inbox: MessageInbox;
  private runtimeOwner: () => string;
  constructor(db: DatabaseSync, credentials: CredentialStateStore, inbox: MessageInbox, runtimeOwner: () => string) {
    this.db = db; this.credentials = credentials; this.inbox = inbox; this.runtimeOwner = runtimeOwner;
    db.exec(`CREATE TABLE IF NOT EXISTS gateway_reaction_receipts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, owner TEXT NOT NULL, revision INTEGER NOT NULL,
      phase TEXT NOT NULL, secret TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS gateway_reactions_task ON gateway_reaction_receipts(task_id);`);
  }

  begin(message: ChannelMessage, emoji: string): ReactionReceipt {
    const owner = this.runtimeOwner(), task = this.inbox.findMessage(message);
    if (!task || !["queued", "preparing", "dispatched"].includes(task.state) || !["Get", "OnIt"].includes(emoji)) throw new Error("表情缺少有效任务或类型");
    const existing = this.db.prepare("SELECT * FROM gateway_reaction_receipts WHERE task_id=?").all(task.id).map(row => this.decode(row));
    if (existing.some(receipt => receipt.emoji === emoji)) throw new Error("旧表情尚未核实清理，不能再次添加相同表情");
    const receipt: ReactionReceipt = { id: randomUUID(), taskId: task.id, owner, revision: 1, phase: "creating", emoji: emoji as "Get" | "OnIt" };
    this.db.prepare("INSERT INTO gateway_reaction_receipts VALUES (?, ?, ?, ?, ?, ?)")
      .run(receipt.id, receipt.taskId, owner, receipt.revision, receipt.phase, this.encode(receipt));
    return receipt;
  }

  activate(id: string, reactionId: string): ReactionReceipt {
    const receipt = this.get(id);
    if (receipt.owner !== this.runtimeOwner() || receipt.phase !== "creating" || typeof reactionId !== "string" || !reactionId.trim() || reactionId.length > 1024) throw new Error("表情确认状态或ID无效");
    return this.save(receipt, { ...receipt, phase: "active", reactionId });
  }

  startRemoval(id: string): ReactionReceipt {
    const receipt = this.get(id);
    if (!receipt.reactionId || receipt.phase === "creating") throw new Error("表情发送结果未知，不能猜测删除目标");
    return this.save(receipt, { ...receipt, owner: this.runtimeOwner(), phase: "removing" });
  }

  finishRemoval(expected: ReactionReceipt): void {
    const current = this.get(expected.id);
    if (current.owner !== this.runtimeOwner() || current.phase !== "removing" || current.revision !== expected.revision) throw new Error("表情清理检查点已变化");
    const result = this.db.prepare("DELETE FROM gateway_reaction_receipts WHERE id=? AND revision=?").run(current.id, current.revision);
    if (Number(result.changes) !== 1) throw new Error("表情清理检查点已变化");
  }

  pending(channelType: string, installationId: string): Array<{ receipt: ReactionReceipt; message: ChannelMessage }> {
    const owner = this.runtimeOwner();
    const rows = this.db.prepare(`SELECT r.* FROM gateway_reaction_receipts r JOIN gateway_message_inbox i ON i.id=r.task_id
      WHERE i.channel_type=? AND i.installation_id=? AND r.phase IN ('active','removing')
      AND (r.owner<>? OR r.phase='removing' OR i.state IN ('completed','failed','uncertain','awaiting_authorization'))
      ORDER BY i.sequence, r.id`).all(channelType, installationId, owner);
    return rows.map(row => {
      const receipt = this.decode(row), task = this.inbox.findTask(receipt.taskId);
      if (!task || task.message.channelType !== channelType || task.message.installationId !== installationId) throw new Error("表情归属与消息不一致");
      return { receipt, message: task.message };
    });
  }

  private get(id: string): ReactionReceipt {
    this.runtimeOwner();
    const row = this.db.prepare("SELECT * FROM gateway_reaction_receipts WHERE id=?").get(id);
    if (!row) throw new Error("表情检查点不存在");
    return this.decode(row);
  }
  private context(r: Omit<ReactionReceipt, "emoji" | "reactionId">): string {
    return JSON.stringify(["message-reaction", r.id, r.taskId, r.owner, r.revision, r.phase]);
  }
  private encode(r: ReactionReceipt): string {
    return this.credentials.sealAuthorization(JSON.stringify({ emoji: r.emoji, reactionId: r.reactionId }), this.context(r));
  }
  private decode(row: Record<string, unknown>): ReactionReceipt {
    const metadata = { id: String(row.id), taskId: String(row.task_id), owner: String(row.owner), revision: Number(row.revision), phase: row.phase as ReactionReceipt["phase"] };
    try {
      const payload = JSON.parse(this.credentials.openAuthorization(String(row.secret), this.context(metadata)));
      if (!["Get", "OnIt"].includes(payload.emoji) || !["creating", "active", "removing"].includes(metadata.phase)
        || (metadata.phase !== "creating" && (typeof payload.reactionId !== "string" || !payload.reactionId.trim() || payload.reactionId.length > 1024))) throw new Error("invalid receipt");
      return { ...metadata, emoji: payload.emoji, ...(payload.reactionId ? { reactionId: payload.reactionId } : {}) };
    } catch { throw new Error("表情检查点损坏，未清理未知目标"); }
  }
  private save(previous: ReactionReceipt, update: ReactionReceipt): ReactionReceipt {
    const r = { ...update, revision: previous.revision + 1 };
    const result = this.db.prepare("UPDATE gateway_reaction_receipts SET owner=?, revision=?, phase=?, secret=? WHERE id=? AND revision=?")
      .run(r.owner, r.revision, r.phase, this.encode(r), r.id, previous.revision);
    if (Number(result.changes) !== 1) throw new Error("表情检查点已变化");
    return r;
  }
}
