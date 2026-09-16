import { createHash } from "node:crypto";
import type { FailureDiagnostic } from "./ark-errors.ts";

// 官方升级文档只列出这四个顶层字段，未给出嵌套schema。
// 这里保留调用方提供的原生JSON，不把创建接口的id/type等约定猜成升级契约。
export type SessionUpgradeRequest = {
  agent?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  initial_events?: Array<Record<string, unknown>>;
  vault_ids?: string[];
};

export type SessionUpgradeSnapshot = {
  sessionId: string;
  status: "upgrading" | "idle" | "running" | "failed" | "unknown";
  updatedAt: string;
  checkedAt: number;
  configuration: { agent?: string; environment?: string; vaults?: string; resources?: string };
};
export type SessionUpgradeSubmission = {
  requestFingerprint: string;
  failure?: FailureDiagnostic;
} & (
  | { status: "accepted"; snapshot: SessionUpgradeSnapshot }
  | { status: "rejected" | "unknown"; reason: "request_failed" | "invalid_response" }
);
export type SessionUpgradeObservation = {
  status: "settled" | "pending" | "unknown";
  reason: "upgrading_to_idle" | "transition_not_observed" | "status_not_confirmed" | "query_failed" | "invalid_response" | "time_regressed" | "timeout" | "cancelled";
  snapshot?: SessionUpgradeSnapshot;
  requestFingerprint: string;
  // 状态切换不证明请求中的配置已在沙箱生效，更不证明initial_events的业务完成。
  configurationVerified: false;
  businessResult: "not_assessed";
};
export type SessionUpgradeWaitOptions = { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal };

export function validUpgradeSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

// 同时拒绝getter/toJSON、循环、非JSON值，避免序列化时悄悄改变原生参数或泄露异常正文。
function canonicalJSON(value: unknown, maxBytes: number): string {
  let nodes = 0, bytes = 0;
  const ancestors = new Set<object>();
  const fail = () => { throw new Error("JSON结构无效"); };
  const encode = (item: unknown, depth: number): string => {
    if (++nodes > 65_536 || depth > 32) return fail();
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) return JSON.stringify(item);
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item);
      if (bytes > maxBytes) return fail();
      return JSON.stringify(item);
    }
    if (!Array.isArray(item) && !object(item)) return fail();
    if (ancestors.has(item as object) || Object.getOwnPropertySymbols(item as object).length) return fail();
    ancestors.add(item as object);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.values(descriptors).some(value => value.get || value.set)) return fail();
    let result: string;
    if (Array.isArray(item)) {
      if (item.length > 65_536 || Object.keys(item).some(key => !/^\d+$/.test(key)) || Object.keys(item).length !== item.length) return fail();
      result = `[${item.map(value => encode(value, depth + 1)).join(",")}]`;
    } else {
      const keys = Object.keys(item).sort();
      if (keys.some(key => ["__proto__", "prototype", "constructor", "toJSON"].includes(key))) return fail();
      result = `{${keys.map(key => `${encode(key, depth + 1)}:${encode(descriptors[key].value, depth + 1)}`).join(",")}}`;
    }
    ancestors.delete(item as object);
    if (Buffer.byteLength(result) > maxBytes) return fail();
    return result;
  };
  return encode(value, 0);
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const statuses = ["upgrading", "idle", "running", "failed", "unknown"];

export function prepareSessionUpgrade(request: SessionUpgradeRequest): { body: string; fingerprint: string } {
  try {
    if (!object(request) || !Object.keys(request).length
      || Object.keys(request).some(key => !["agent", "environment", "initial_events", "vault_ids"].includes(key))) throw new Error();
    const body = canonicalJSON(request, 256 * 1024);
    const copy = JSON.parse(body) as SessionUpgradeRequest;
    for (const key of ["agent", "environment"] as const) if (key in copy && !object(copy[key])) throw new Error();
    if ("initial_events" in copy && (!Array.isArray(copy.initial_events) || !copy.initial_events.every(object))) throw new Error();
    if ("vault_ids" in copy && (!Array.isArray(copy.vault_ids) || !copy.vault_ids.every(value => typeof value === "string" && value.length > 0))) throw new Error();
    return { body, fingerprint: hash(body) };
  } catch { throw new Error("Session 升级请求无效：仅支持官方升级字段及有界的原生JSON对象"); }
}

export function parseSessionUpgradeSnapshot(payload: unknown, sessionId: string): SessionUpgradeSnapshot | undefined {
  try {
    if (!object(payload) || payload.error || payload.id !== sessionId || payload.type !== "session"
      || typeof payload.status !== "string" || !/^[a-z][a-z_]{0,63}$/.test(payload.status)
      || typeof payload.updated_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(payload.updated_at)
      || !Number.isFinite(Date.parse(payload.updated_at))) return undefined;
    const configuration: SessionUpgradeSnapshot["configuration"] = {};
    for (const [key, field] of [["agent", "agent"], ["environment", "environment"], ["vaults", "vault_ids"], ["resources", "resources"]] as const) {
      if (!(field in payload)) continue;
      if ((field === "agent" || field === "environment") && !object(payload[field])) return undefined;
      if (field === "vault_ids" && (!Array.isArray(payload[field]) || !payload[field].every(value => typeof value === "string"))) return undefined;
      if (field === "resources" && (!Array.isArray(payload[field]) || !payload[field].every(object))) return undefined;
      configuration[key] = hash(canonicalJSON(payload[field], 4 * 1024 * 1024));
    }
    return { sessionId, status: statuses.includes(payload.status) ? payload.status as SessionUpgradeSnapshot["status"] : "unknown",
      updatedAt: payload.updated_at, checkedAt: Date.now(), configuration };
  } catch { return undefined; }
}

export function validateUpgradeWait(submission: SessionUpgradeSubmission, options: SessionUpgradeWaitOptions): { snapshot: SessionUpgradeSnapshot; requestFingerprint: string } {
  if (submission?.status !== "accepted") throw new Error("升级请求未确认受理，不能以轮询代替提交结果核查");
  const snapshot = submission.snapshot;
  if (!snapshot || !validUpgradeSessionId(snapshot.sessionId) || !/^[a-f0-9]{64}$/.test(submission.requestFingerprint)
    || !statuses.includes(snapshot.status) || !object(snapshot.configuration)
    || !Number.isFinite(Date.parse(snapshot.updatedAt)) || !Number.isFinite(snapshot.checkedAt)
    || Date.now() - snapshot.checkedAt > 30_000 || snapshot.checkedAt > Date.now()) throw new Error("升级回执无效或过期，需要重新核查原操作");
  const configuration: SessionUpgradeSnapshot["configuration"] = {};
  for (const key of ["agent", "environment", "vaults", "resources"] as const) {
    if (!(key in snapshot.configuration)) continue;
    const fingerprint = snapshot.configuration[key];
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("升级回执指纹无效");
    configuration[key] = fingerprint;
  }
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)) throw new Error("升级等待时限应为1至120000毫秒");
  if (options.pollIntervalMs !== undefined && (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs < 1 || options.pollIntervalMs > 10_000)) throw new Error("升级轮询间隔应为1至10000毫秒");
  return { requestFingerprint: submission.requestFingerprint,
    snapshot: { sessionId: snapshot.sessionId, status: snapshot.status, updatedAt: snapshot.updatedAt, checkedAt: snapshot.checkedAt, configuration } };
}
