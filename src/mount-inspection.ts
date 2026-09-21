export type FileMountQuery = { sessionId: string; fileId: string; mountPath: string };
export type FileMountProof = FileMountQuery & { status: "confirmed"; resourceId: string; checkedAt: number };
export type FileMountInspection = FileMountProof | { status: "unknown"; reason: "resources_unavailable" | "invalid_resources" | "not_found" | "ambiguous_resource" };

export function validMountQuery(query: FileMountQuery): boolean {
  return [query.sessionId, query.fileId, query.mountPath].every(value => typeof value === "string" && value.length > 0
    && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value))
    && !query.mountPath.split("/").some(part => part === "." || part === "..");
}

// 只确认目标文件在目标路径的唯一挂载，不以空列表证明此前POST没有生效。
// 返回原请求路径与Session绑定；远端沙箱路径不替换本地缓存的请求路径。
export function inspectMountResources(payload: unknown, query: FileMountQuery): FileMountInspection {
  const invalid: FileMountInspection = { status: "unknown", reason: "invalid_resources" };
  if (!validMountQuery(query) || !payload || typeof payload !== "object" || Array.isArray(payload)) return invalid;
  const envelope = payload as Record<string, unknown>;
  if (envelope.error || envelope.has_more || envelope.next_page) return invalid;
  const data = envelope.data;
  if (!Array.isArray(data) || data.length > 1000 || data.some(row => !row || typeof row !== "object" || Array.isArray(row))) return invalid;
  const visiblePath = `/mnt/session/uploads/${query.mountPath.replace(/^\/+/, "")}`;
  const matches = data.filter(row => row.mount_path === visiblePath);
  if (!matches.length) return { status: "unknown", reason: "not_found" };
  if (matches.length !== 1) return { status: "unknown", reason: "ambiguous_resource" };
  const row = matches[0];
  if (row.type !== "file" || row.file_id !== query.fileId || typeof row.id !== "string" || !row.id
    || row.id.length > 4096 || /[\u0000-\u001f\u007f]/.test(row.id)
    || (row.access !== undefined && !["read_only", "read_write"].includes(row.access))) return invalid;
  if (data.filter(item => item.id === row.id).length !== 1) return { status: "unknown", reason: "ambiguous_resource" };
  return { status: "confirmed", ...query, resourceId: row.id, checkedAt: Date.now() };
}
