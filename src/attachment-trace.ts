import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ChannelMessage } from "./channel.ts";

export type AttachmentStage = "download" | "upload" | "mount" | "inline" | "cache";
export type AttachmentStageDetails = { bytes?: number; sha256?: string; fileId?: string; mountPath?: string; sessionId?: string };
export type AttachmentStageReceipt = AttachmentStageDetails & {
  id: string; sequence: number; attachmentKey: string; stage: AttachmentStage;
  status: "pending" | "succeeded" | "error"; startedAt: number; finishedAt?: number; durationMs?: number;
};

function details(value: AttachmentStageDetails): AttachmentStageDetails {
  const result: AttachmentStageDetails = {};
  if (value.bytes !== undefined) {
    if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) throw new Error("附件大小无效");
    result.bytes = value.bytes;
  }
  if (value.sha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("附件Hash无效");
    result.sha256 = value.sha256;
  }
  for (const field of ["fileId", "sessionId", "mountPath"] as const) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== "string" || !value[field] || value[field]!.length > 4096) throw new Error("附件资源标识无效");
    result[field] = value[field];
  }
  return result;
}

// 仅记录传输/准备证据，不根据工具返回Document或MA idle推断“已读懂”。
// pending表示未记录到结束，并非进程仍活跃；error也不证明远端写入未发生。
export class AttachmentTraceStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS attachment_stage_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL, attachment_key TEXT NOT NULL, stage TEXT NOT NULL,
      status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
      details TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS attachment_stage_scope ON attachment_stage_receipts(scope, sequence);`);
  }

  begin(message: ChannelMessage, key: string, stage: AttachmentStage, value: AttachmentStageDetails = {}): string {
    if (!/^[a-f0-9]{64}$/.test(key) || !["download", "upload", "mount", "inline", "cache"].includes(stage)) throw new Error("附件阶段无效");
    const id = randomUUID();
    this.db.prepare(`INSERT INTO attachment_stage_receipts (id, scope, attachment_key, stage, status, started_at, details)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, this.scope(message), key, stage, Date.now(), JSON.stringify(details(value)));
    return id;
  }

  finish(id: string, status: "succeeded" | "error", value: AttachmentStageDetails = {}): void {
    if (!["succeeded", "error"].includes(status)) throw new Error("附件阶段终态无效");
    const row = this.db.prepare("SELECT details FROM attachment_stage_receipts WHERE id=? AND status='pending'").get(id) as { details: string } | undefined;
    if (!row) throw new Error("附件阶段不存在或已经结束");
    const data = details({ ...JSON.parse(row.details), ...details(value) });
    const result = this.db.prepare("UPDATE attachment_stage_receipts SET status=?, finished_at=MAX(started_at, ?), details=? WHERE id=? AND status='pending'")
      .run(status, Date.now(), JSON.stringify(data), id);
    if (Number(result.changes) !== 1) throw new Error("附件阶段已经结束");
  }

  list(message: ChannelMessage, after = 0): { items: AttachmentStageReceipt[]; next?: number } {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("附件阶段游标无效");
    const rows = this.db.prepare("SELECT * FROM attachment_stage_receipts WHERE scope=? AND sequence>? ORDER BY sequence LIMIT 201").all(this.scope(message), after);
    const items = rows.slice(0, 200).map(row => ({
      id: String(row.id), sequence: Number(row.sequence), attachmentKey: String(row.attachment_key),
      stage: row.stage as AttachmentStage, status: row.status as AttachmentStageReceipt["status"], startedAt: Number(row.started_at),
      ...(row.finished_at === null ? {} : { finishedAt: Number(row.finished_at), durationMs: Number(row.finished_at) - Number(row.started_at) }),
      ...details(JSON.parse(String(row.details)))
    }));
    return { items, ...(rows.length > 200 ? { next: items.at(-1)!.sequence } : {}) };
  }

  confirmedUpload(message: ChannelMessage, key: string): AttachmentStageDetails | undefined {
    const row = this.db.prepare(`SELECT details FROM attachment_stage_receipts
      WHERE scope=? AND attachment_key=? AND stage='upload' AND status='succeeded'
      ORDER BY sequence DESC LIMIT 1`).get(this.scope(message), key) as { details: string } | undefined;
    if (!row) return undefined;
    const value = details(JSON.parse(row.details));
    if (!value.fileId || value.bytes === undefined || !value.sha256) throw new Error("已确认附件上传记录不完整，不能自动重复上传");
    return value;
  }

  private scope(message: ChannelMessage): string {
    return JSON.stringify([message.channelType, message.installationId, message.tenantId, message.conversationId, message.threadId, message.messageId]);
  }
}
