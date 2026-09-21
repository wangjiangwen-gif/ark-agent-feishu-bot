import { randomUUID } from "node:crypto";

export type FileUploadQuery = { uploadName: string; bytes: number; startedAt: number };
export type FileUploadProof = FileUploadQuery & { status: "confirmed"; fileId: string; checkedAt: number };
export type FileUploadInspection = FileUploadProof | { status: "unknown"; reason: "files_unavailable" | "invalid_files" | "not_found" | "ambiguous_file" | "file_not_ready" | "scan_limit" };

export function validUploadName(value: unknown): value is string {
  return typeof value === "string" && /^arkagent-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?:\.[a-zA-Z0-9]{1,16})?$/.test(value);
}
export function newUploadName(originalName: string): string {
  return `arkagent-${randomUUID()}${originalName.match(/\.[a-zA-Z0-9]{1,16}$/)?.[0] || ""}`;
}
export function validUploadQuery(query: FileUploadQuery): boolean {
  return validUploadName(query.uploadName) && Number.isSafeInteger(query.bytes) && query.bytes >= 0
    && Number.isSafeInteger(query.startedAt) && query.startedAt > 0 && query.startedAt <= Date.now();
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function identifier(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/.test(value); }
function matchesUpload(value: Record<string, unknown>, query: FileUploadQuery): boolean {
  const created = value.created_at;
  return identifier(value.id) && value.filename === query.uploadName && value.bytes === query.bytes && value.purpose === "user_data"
    && Number.isSafeInteger(created) && Number(created) >= Math.floor(query.startedAt / 1000) - 30
    && Number(created) <= Math.ceil(query.startedAt / 1000) + 120 && Number(created) <= Math.floor(Date.now() / 1000) + 30;
}
function active(value: Record<string, unknown>): boolean {
  return value.status === "active" && !value.error && Number.isSafeInteger(value.expire_at) && Number(value.expire_at) > Date.now() / 1000;
}

// 随机操作名用于关联本次上传，并非服务端Hash或官方幂等键。
// 必须读完有界列表排除重复，详情再次确认可用；没有匹配不意味着可以重发POST。
export async function inspectUploadedFile(query: FileUploadQuery, read: (path: string) => Promise<unknown>): Promise<FileUploadInspection> {
  const invalid: FileUploadInspection = { status: "unknown", reason: "invalid_files" };
  if (!validUploadQuery(query)) return invalid;
  const ids = new Set<string>();
  let after: string | undefined, candidate: Record<string, unknown> | undefined;
  for (let index = 0; index < 20; index++) {
    const payload = await read(`/files?purpose=user_data&limit=100&order=desc${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    if (!record(payload) || payload.error || !Array.isArray(payload.data) || payload.data.length > 100 || typeof payload.has_more !== "boolean") return invalid;
    const rows: unknown[] = payload.data;
    for (const row of rows) {
      if (!record(row) || !identifier(row.id) || typeof row.filename !== "string" || ids.has(row.id)) return invalid;
      ids.add(row.id);
      if (row.filename !== query.uploadName) continue;
      if (candidate) return { status: "unknown", reason: "ambiguous_file" };
      if (!matchesUpload(row, query)) return invalid;
      candidate = row;
    }
    if (rows.length && (payload.first_id !== (rows[0] as Record<string, unknown>).id || payload.last_id !== (rows.at(-1) as Record<string, unknown>).id)) return invalid;
    if (!payload.has_more) {
      if (!candidate) return { status: "unknown", reason: "not_found" };
      const detail = await read(`/files/${encodeURIComponent(String(candidate.id))}`);
      if (!record(detail) || !matchesUpload(detail, query) || detail.id !== candidate.id || detail.created_at !== candidate.created_at) return invalid;
      if (!active(detail)) return { status: "unknown", reason: "file_not_ready" };
      return { status: "confirmed", ...query, fileId: String(detail.id), checkedAt: Date.now() };
    }
    if (!rows.length || !identifier(payload.last_id) || payload.last_id === after) return invalid;
    after = payload.last_id;
  }
  return { status: "unknown", reason: "scan_limit" };
}
