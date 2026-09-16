import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ChannelMessage } from "./channel.ts";
import { validMountQuery, type FileMountProof } from "./mount-inspection.ts";
import { newUploadName, validUploadName, validUploadQuery, type FileUploadProof } from "./upload-inspection.ts";

export type AttachmentStage = "download" | "upload" | "upload_check" | "mount" | "mount_check" | "inline" | "cache";
export type AttachmentStageDetails = { bytes?: number; sha256?: string; fileId?: string; mountPath?: string; sessionId?: string; resourceId?: string; checkedAt?: number; rejected?: true; uploadName?: string };
export type AttachmentStageReceipt = AttachmentStageDetails & {
  id: string; sequence: number; attachmentKey: string; stage: AttachmentStage;
  status: "pending" | "succeeded" | "error"; startedAt: number; finishedAt?: number; durationMs?: number;
};
export type AttachmentDiagnosticFilters = { before?: number; messageId?: string; sessionId?: string };
export type AttachmentDiagnostic = AttachmentStageReceipt & { tenantId: string; conversationId: string; threadId: string; messageId: string };

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
  if (value.rejected === true) result.rejected = true;
  if (value.uploadName !== undefined) {
    if (!validUploadName(value.uploadName)) throw new Error("上传操作标识无效");
    result.uploadName = value.uploadName;
  }
  if (value.checkedAt !== undefined) {
    if (!Number.isSafeInteger(value.checkedAt) || value.checkedAt < 0) throw new Error("附件核查时间无效");
    result.checkedAt = value.checkedAt;
  }
  for (const field of ["fileId", "sessionId", "mountPath", "resourceId"] as const) {
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
    ); CREATE INDEX IF NOT EXISTS attachment_stage_scope ON attachment_stage_receipts(scope, sequence);
    CREATE INDEX IF NOT EXISTS attachment_stage_installation ON attachment_stage_receipts(
      json_extract(scope, '$[0]'), json_extract(scope, '$[1]'), sequence
    );
    CREATE INDEX IF NOT EXISTS attachment_stage_message ON attachment_stage_receipts(
      json_extract(scope, '$[0]'), json_extract(scope, '$[1]'), json_extract(scope, '$[5]'), sequence
    );
    CREATE INDEX IF NOT EXISTS attachment_stage_session ON attachment_stage_receipts(
      json_extract(scope, '$[0]'), json_extract(scope, '$[1]'), json_extract(details, '$.sessionId'), sequence
    );
    CREATE INDEX IF NOT EXISTS attachment_mount_lookup ON attachment_stage_receipts(
      scope, attachment_key, json_extract(details, '$.sessionId'), sequence
    ) WHERE stage='mount' OR (stage='mount_check' AND status='succeeded');
    CREATE INDEX IF NOT EXISTS attachment_upload_lookup ON attachment_stage_receipts(attachment_key, sequence)
      WHERE stage='upload' OR (stage='upload_check' AND status='succeeded');
    `);
  }

  begin(message: ChannelMessage, key: string, stage: AttachmentStage, value: AttachmentStageDetails = {}): string {
    if (!/^[a-f0-9]{64}$/.test(key) || !["download", "upload", "upload_check", "mount", "mount_check", "inline", "cache"].includes(stage)) throw new Error("附件阶段无效");
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
    const items = rows.slice(0, 200).map(receipt);
    return { items, ...(rows.length > 200 ? { next: items.at(-1)!.sequence } : {}) };
  }

  // 管理员查看当前应用的历史准备证据；不将历史记录归属到当前配置的Agent。
  // 只读本地记录，不查询远端、不重试附件，也不推断pending任务仍在执行。
  listForInstallation(channelType: string, installationId: string, filters: AttachmentDiagnosticFilters = {}): {
    scope: "installation"; items: AttachmentDiagnostic[]; next?: number;
  } {
    if (filters.before !== undefined && (!Number.isSafeInteger(filters.before) || filters.before < 1)) throw new Error("附件阶段游标无效");
    for (const value of [filters.messageId, filters.sessionId]) if (value !== undefined
      && (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value))) throw new Error("附件筛选条件无效");
    const clauses = ["json_extract(scope, '$[0]')=?", "json_extract(scope, '$[1]')=?"];
    const parameters: Array<string | number> = [channelType, installationId];
    if (filters.before !== undefined) { clauses.push("sequence<?"); parameters.push(filters.before); }
    if (filters.messageId !== undefined) { clauses.push("json_extract(scope, '$[5]')=?"); parameters.push(filters.messageId); }
    if (filters.sessionId !== undefined) { clauses.push("json_extract(details, '$.sessionId')=?"); parameters.push(filters.sessionId); }
    const rows = this.db.prepare(`SELECT * FROM attachment_stage_receipts WHERE ${clauses.join(" AND ")} ORDER BY sequence DESC LIMIT 101`).all(...parameters);
    const items = rows.slice(0, 100).map(row => {
      const scope: unknown = JSON.parse(String(row.scope));
      if (!Array.isArray(scope) || scope.length !== 6 || scope.some(value => typeof value !== "string")) throw new Error("附件范围记录无效");
      return { ...receipt(row), tenantId: scope[2], conversationId: scope[3], threadId: scope[4], messageId: scope[5] };
    });
    return { scope: "installation", items, ...(rows.length > 100 ? { next: items.at(-1)!.sequence } : {}) };
  }

  confirmedUpload(message: ChannelMessage, key: string): AttachmentStageDetails | undefined {
    const row = this.latestUpload(message, key);
    if (!row || row.status !== "succeeded") return undefined;
    const value = details(row);
    if (!value.fileId || value.bytes === undefined || !value.sha256) throw new Error("已确认附件上传记录不完整，不能自动重复上传");
    return value;
  }

  latestUpload(message: ChannelMessage, key: string): AttachmentStageReceipt | undefined {
    // 同一源消息可能同时出现在群背景和话题引用中，上传缓存键本身不含Thread。
    // 只合并同应用/租户/群/源消息/附件的上传，保留首次回执的真实Thread归属。
    const row = this.db.prepare(`SELECT * FROM attachment_stage_receipts WHERE attachment_key=?
      AND json_extract(scope, '$[0]')=? AND json_extract(scope, '$[1]')=? AND json_extract(scope, '$[2]')=?
      AND json_extract(scope, '$[3]')=? AND json_extract(scope, '$[5]')=?
      AND (stage='upload' OR (stage='upload_check' AND status='succeeded')) ORDER BY sequence DESC LIMIT 1`)
      .get(key, message.channelType, message.installationId, message.tenantId, message.conversationId, message.messageId);
    return row ? receipt(row) : undefined;
  }

  beginUpload(message: ChannelMessage, key: string, originalName: string, value: { bytes: number; sha256: string }): AttachmentStageReceipt {
    this.db.exec("SAVEPOINT attachment_upload_start");
    try {
      const previous = this.latestUpload(message, key);
      if (previous && !(previous.status === "error" && previous.rejected)) throw new Error("附件上传结果待核实，未重复提交上传请求");
      const id = this.begin(message, key, "upload", { ...value, uploadName: newUploadName(originalName) });
      const started = receipt(this.db.prepare("SELECT * FROM attachment_stage_receipts WHERE id=?").get(id)!);
      this.db.exec("RELEASE attachment_upload_start");
      return started;
    } catch (error) {
      this.db.exec("ROLLBACK TO attachment_upload_start; RELEASE attachment_upload_start");
      throw error;
    }
  }

  confirmUpload(message: ChannelMessage, key: string, expectedId: string, proof: FileUploadProof, checkedAfter: number): void {
    if (proof.status !== "confirmed" || !validUploadQuery(proof) || !proof.fileId || !Number.isSafeInteger(proof.checkedAt)
      || proof.checkedAt < checkedAfter || proof.checkedAt > Date.now() || Date.now() - proof.checkedAt > 30_000) throw new Error("附件上传核查证据无效");
    this.db.exec("SAVEPOINT attachment_upload_confirmation");
    try {
      const previous = this.latestUpload(message, key);
      if (!previous || previous.id !== expectedId || previous.uploadName !== proof.uploadName || previous.bytes !== proof.bytes
        || previous.startedAt !== proof.startedAt || !previous.sha256 || previous.rejected
        || (previous.status === "succeeded" && previous.fileId !== proof.fileId)) throw new Error("附件上传记录已变化");
      const id = this.begin(message, key, "upload_check", { bytes: previous.bytes, sha256: previous.sha256,
        uploadName: proof.uploadName, fileId: proof.fileId, checkedAt: proof.checkedAt });
      this.finish(id, "succeeded");
      this.db.exec("RELEASE attachment_upload_confirmation");
    } catch (error) {
      this.db.exec("ROLLBACK TO attachment_upload_confirmation; RELEASE attachment_upload_confirmation");
      throw error;
    }
  }

  latestMount(message: ChannelMessage, key: string, sessionId: string): AttachmentStageReceipt | undefined {
    const row = this.db.prepare(`SELECT * FROM attachment_stage_receipts WHERE scope=? AND attachment_key=?
      AND json_extract(details, '$.sessionId')=? AND (stage='mount' OR (stage='mount_check' AND status='succeeded'))
      ORDER BY sequence DESC LIMIT 1`).get(this.scope(message), key, sessionId);
    return row ? receipt(row) : undefined;
  }

  confirmMount(message: ChannelMessage, key: string, expectedId: string, proof: FileMountProof, checkedAfter: number): void {
    if (proof.status !== "confirmed" || !validMountQuery(proof) || !proof.resourceId || !Number.isSafeInteger(proof.checkedAt)
      || proof.checkedAt < checkedAfter || proof.checkedAt > Date.now() || Date.now() - proof.checkedAt > 30_000) throw new Error("附件挂载核查证据无效");
    this.db.exec("SAVEPOINT attachment_mount_confirmation");
    try {
      const previous = this.latestMount(message, key, proof.sessionId);
      if (!previous || previous.id !== expectedId || previous.fileId !== proof.fileId || previous.mountPath !== proof.mountPath
        || proof.checkedAt < previous.startedAt) throw new Error("附件挂载记录已变化");
      const id = this.begin(message, key, "mount_check", {
        bytes: previous.bytes, sha256: previous.sha256, sessionId: proof.sessionId, fileId: proof.fileId,
        mountPath: proof.mountPath, resourceId: proof.resourceId, checkedAt: proof.checkedAt
      });
      this.finish(id, "succeeded");
      this.db.exec("RELEASE attachment_mount_confirmation");
    } catch (error) {
      this.db.exec("ROLLBACK TO attachment_mount_confirmation; RELEASE attachment_mount_confirmation");
      throw error;
    }
  }

  private scope(message: ChannelMessage): string {
    return JSON.stringify([message.channelType, message.installationId, message.tenantId, message.conversationId, message.threadId, message.messageId]);
  }
}

function receipt(row: Record<string, unknown>): AttachmentStageReceipt {
  return {
    id: String(row.id), sequence: Number(row.sequence), attachmentKey: String(row.attachment_key),
    stage: row.stage as AttachmentStage, status: row.status as AttachmentStageReceipt["status"], startedAt: Number(row.started_at),
    ...(row.finished_at === null ? {} : { finishedAt: Number(row.finished_at), durationMs: Number(row.finished_at) - Number(row.started_at) }),
    ...details(JSON.parse(String(row.details)))
  };
}
