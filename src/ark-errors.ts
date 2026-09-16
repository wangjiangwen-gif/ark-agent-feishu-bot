export type FailureKind = "auth" | "permission" | "rate_limit" | "invalid_request" | "not_found" | "conflict" | "too_large" | "timeout" | "cancelled" | "network" | "upstream" | "unknown";
export type FailureDiagnostic = { kind: FailureKind; status?: number; code?: string; requestId?: string };
const kinds: FailureKind[] = ["auth", "permission", "rate_limit", "invalid_request", "not_found", "conflict", "too_large", "timeout", "cancelled", "network", "upstream", "unknown"];
const networkCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);

export function safeErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value) ? value : undefined;
}
export function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : undefined;
}
export function sanitizeFailure(value: unknown): FailureDiagnostic {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result: FailureDiagnostic = { kind: kinds.includes(data.kind as FailureKind) ? data.kind as FailureKind : "unknown" };
  if (Number.isInteger(data.status) && Number(data.status) >= 400 && Number(data.status) <= 599) result.status = Number(data.status);
  const code = safeErrorCode(data.code), requestId = safeRequestId(data.requestId);
  if (code) result.code = code;
  if (requestId) result.requestId = requestId;
  return result;
}

export class ArkHttpError extends Error {
  status: number;
  code?: string;
  requestId?: string;
  kind: FailureKind;
  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message); this.name = "ArkHttpError"; this.status = status;
    this.code = safeErrorCode(code); this.requestId = safeRequestId(requestId);
    this.kind = ({ 400: "invalid_request", 401: "auth", 403: "permission", 404: "not_found", 409: "conflict", 413: "too_large", 429: "rate_limit" } as Record<number, FailureKind>)[status] || "upstream";
  }
}

export class ArkNetworkError extends Error {
  kind: FailureKind;
  code?: string;
  constructor(operation: string, error: unknown) {
    const original = error instanceof Error ? error : undefined;
    const cause = original?.cause instanceof Error ? original.cause : undefined;
    const code = [original, cause].flatMap(item => item ? [(item as NodeJS.ErrnoException).code, item.message] : []).find(value => typeof value === "string" && networkCodes.has(value));
    const kind = original?.name === "TimeoutError" ? "timeout" : original?.name === "AbortError" ? "cancelled" : "network";
    super(`方舟网络请求失败（${operation}）：${code || kind}`);
    this.name = "ArkNetworkError"; this.kind = kind; this.code = code;
    // 不保留原始cause：Node日志可能递归输出其中的请求地址、正文或凭证。
  }
}

export function failureDiagnostic(error: unknown): FailureDiagnostic {
  return error instanceof ArkRunError ? sanitizeFailure(error.failure)
    : error instanceof ArkHttpError || error instanceof ArkNetworkError ? sanitizeFailure(error) : { kind: "unknown" };
}

// 只解析已观测的结构化错误；原始message、URL与嵌套响应不进入回复/审计。
export function sessionFailure(event: Record<string, unknown>): FailureDiagnostic {
  const error = event.error && typeof event.error === "object" ? event.error as Record<string, unknown> : {};
  if (error.type === "model_rate_limited_error") return { kind: "rate_limit", code: "model_rate_limited_error" };
  if (error.type !== "model_request_failed_error") return { kind: "unknown" };
  const fallback: FailureDiagnostic = { kind: "upstream", code: "model_request_failed_error" };
  if (typeof error.message !== "string" || error.message.length > 32768) return fallback;
  try {
    const inner = JSON.parse(error.message)?.error;
    if (inner?.code !== "InvalidParameter" || inner?.param !== "file_url" || typeof inner.message !== "string"
      || !/^Timeout while processing file_url(?:\s|$)/.test(inner.message)) return fallback;
    const requestId = safeRequestId(inner.message.match(/\bRequest id:\s*([A-Za-z0-9_.:-]+)(?:\s|$)/)?.[1]);
    return { kind: "timeout", code: "model_file_processing_timeout", ...(requestId ? { requestId } : {}) };
  } catch { return fallback; }
}

export class ArkRunError extends Error {
  failure: FailureDiagnostic;
  constructor(failure?: FailureDiagnostic) {
    const safe = sanitizeFailure(failure);
    const reason = safe.code === "model_file_processing_timeout" ? "模型侧文件内容处理超时（file_url），本轮未完成；网关不会自动重跑任务。"
      : safe.kind === "rate_limit" ? "模型请求被限流，本轮未完成；网关不会自动重跑任务。"
      : "Agent Session 执行失败，请检查 MA 运行记录；网关不会自动重跑任务。";
    super(`${reason}${safe.requestId ? ` Request ID: ${safe.requestId}` : ""}`);
    this.name = "ArkRunError"; this.failure = safe;
  }
}

export function streamFailureText(error: unknown): string {
  return `执行失败：${error instanceof ArkRunError ? new ArkRunError(error.failure).message : "本次回复未完成，请查看网关与 MA 运行记录。"}`;
}
