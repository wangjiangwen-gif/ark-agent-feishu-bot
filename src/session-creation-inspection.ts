import type { SessionCreationRecord } from "./session-creation-state.ts";
import { SESSION_CREATION_OPERATION_TAG, SESSION_CREATION_REQUEST_TAG } from "./session-creation-state.ts";
import { configFingerprint } from "./session-config.ts";

export type SessionCreationQuery = Pick<SessionCreationRecord, "operationId" | "createdAt" | "agentId" | "requestFingerprint" | "request">;
export type SessionCreationInspection = {
  status: "confirmed"; sessionId: string; operationId: string; requestFingerprint: string;
  agentId: string; environmentId: string; sessionStatus: "idle" | "running" | "upgrading" | "failed" | "unknown"; checkedAt: number;
} | { status: "unknown"; reason: "invalid_query" | "sessions_unavailable" | "invalid_sessions" | "ambiguous_session"
  | "not_found" | "scan_limit" | "configuration_unverified" | "cancelled" | "timeout" };

const statuses = ["idle", "running", "upgrading", "failed", "unknown"];
const reserved = [SESSION_CREATION_OPERATION_TAG, SESSION_CREATION_REQUEST_TAG];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value);
const unknown = (reason: Extract<SessionCreationInspection, { status: "unknown" }>["reason"]): SessionCreationInspection => ({ status: "unknown", reason });
const hasError = (value: Record<string, unknown>): boolean => Object.hasOwn(value, "error")
  || (Object.hasOwn(value, "code") && value.code !== 0) || value.success === false;

// 不调用getter/toJSON，且快照只取关联字段，异步查询中调用方修改record不会替换查询绑定。
function snapshot(value: unknown): unknown {
  let nodes = 0, bytes = 0;
  const parents = new Set<object>();
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > 65536 || depth > 32) throw new Error("invalid");
    if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string") { bytes += Buffer.byteLength(item); if (bytes > 4 * 1024 * 1024) throw new Error("invalid"); return item; }
    if (!object(item) && !Array.isArray(item)) throw new Error("invalid");
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error("invalid");
    if (parents.has(item) || Object.getOwnPropertySymbols(item).length) throw new Error("invalid");
    const properties = Object.getOwnPropertyDescriptors(item);
    if (Object.values(properties).some(property => property.get || property.set)) throw new Error("invalid");
    parents.add(item);
    let result: unknown;
    if (Array.isArray(item)) {
      if (item.length > 65536 || Object.keys(item).length !== item.length
        || Object.keys(item).some(key => !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) throw new Error("invalid");
      result = item.map(value => copy(value, depth + 1));
    } else {
      if (Object.keys(item).some(key => ["__proto__", "prototype", "constructor", "toJSON"].includes(key))) throw new Error("invalid");
      result = Object.fromEntries(Object.entries(properties).map(([key, property]) => [key, copy(property.value, depth + 1)]));
    }
    parents.delete(item); return result;
  };
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024) throw new Error("invalid");
  return result;
}

function tags(value: unknown): Map<string, Record<string, unknown>> | undefined {
  if (!Array.isArray(value) || value.length > 128) return undefined;
  const result = new Map<string, Record<string, unknown>>();
  for (const tag of value) {
    if (!object(tag) || typeof tag.key !== "string" || !tag.key || Buffer.byteLength(tag.key) > 256
      || /[\u0000-\u0020\u007f]/.test(tag.key) || (tag.value !== undefined && typeof tag.value !== "string")
      || result.has(tag.key)) return undefined;
    result.set(tag.key, tag);
  }
  return result;
}

function environmentId(value: Record<string, unknown>): string | undefined {
  const direct = value.environment_id, embedded = object(value.environment) ? value.environment.id : undefined;
  if (direct !== undefined && !identifier(direct) || embedded !== undefined && !identifier(embedded)
    || direct !== undefined && embedded !== undefined && direct !== embedded) return undefined;
  return identifier(direct) ? direct : identifier(embedded) ? embedded : undefined;
}

function prepareQuery(value: SessionCreationQuery): SessionCreationQuery | undefined {
  try {
    if (!object(value)) return undefined;
    const properties = Object.getOwnPropertyDescriptors(value), selected: Record<string, unknown> = {};
    for (const key of ["operationId", "createdAt", "agentId", "requestFingerprint", "request"]) {
      if (!properties[key] || properties[key].get || properties[key].set) return undefined;
      selected[key] = properties[key].value;
    }
    const query = snapshot(selected) as SessionCreationQuery, request = query.request;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(query.operationId)
      || !identifier(query.agentId) || !/^[a-f0-9]{64}$/.test(query.requestFingerprint)
      || !Number.isSafeInteger(query.createdAt) || query.createdAt <= 0 || query.createdAt > Date.now()
      || !object(request) || !environmentId(request)
      || (typeof request.agent === "string" ? request.agent : object(request.agent) ? request.agent.id : undefined) !== query.agentId) return undefined;
    if (request.vault_ids !== undefined && (!Array.isArray(request.vault_ids) || request.vault_ids.some(id => !identifier(id))
      || new Set(request.vault_ids).size !== request.vault_ids.length)) return undefined;
    if (request.resources !== undefined && (!Array.isArray(request.resources) || request.resources.length > 128
      || request.resources.some(resource => !object(resource) || typeof resource.type !== "string" || !resource.type))) return undefined;
    const requestTags = tags(request.tags);
    if (!requestTags || requestTags.get(reserved[0])?.value !== query.operationId || requestTags.get(reserved[1])?.value !== query.requestFingerprint) return undefined;
    const original = { ...request, tags: request.tags!.filter(tag => !reserved.includes(tag.key)) };
    const withTags = configFingerprint(original);
    if (!original.tags.length) delete (original as Record<string, unknown>).tags;
    if (withTags !== query.requestFingerprint && configFingerprint(original) !== query.requestFingerprint) return undefined;
    return query;
  } catch { return undefined; }
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined;
}

function validSession(value: unknown, query: SessionCreationQuery): value is Record<string, unknown> {
  if (!object(value) || hasError(value) || !identifier(value.id) || value.type !== "session"
    || !object(value.agent) || value.agent.id !== query.agentId || !environmentId(value)
    || typeof value.status !== "string" || !statuses.includes(value.status)) return false;
  const created = timestamp(value.created_at);
  return created !== undefined && created >= query.createdAt - 30000 && created <= Date.now() + 30000
    && (value.tags === undefined || tags(value.tags) !== undefined);
}

function correlated(value: Record<string, unknown>, query: SessionCreationQuery): boolean {
  const labels = tags(value.tags);
  return labels?.get(reserved[0])?.value === query.operationId && labels.get(reserved[1])?.value === query.requestFingerprint;
}

// 请求明确指定的值必须由响应证明；服务端附加字段不能替代缺失字段。
function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => contains(actual[index], item));
  if (object(expected)) return object(actual) && Object.keys(expected).every(key => Object.hasOwn(actual, key) && contains(actual[key], expected[key]));
  return actual === expected;
}

function configurationMatches(actual: Record<string, unknown>, query: SessionCreationQuery): boolean {
  const expected = query.request;
  if (environmentId(actual) !== environmentId(expected)) return false;
  for (const [key, value] of Object.entries(expected)) {
    if (key === "environment_id") continue;
    if (key === "agent") {
      if (typeof value === "string") continue;
      if (!object(value)) return false;
      // Agent包装type尚无独立核实的响应转换规则；缺少任何请求字段时保持未知。
      if (!contains(actual.agent, value)) return false;
    } else if (key === "environment") {
      if (!object(value)) return false;
      const request = { ...value };
      if (request.type === "environment_with_overrides") delete request.type;
      if (Object.keys(request).every(key => key === "id")) continue;
      if (!contains(actual.environment, request)) return false;
    } else if (key === "vault_ids") {
      const vaults = actual.vault_ids;
      if (!Array.isArray(value) || !Array.isArray(vaults) || vaults.some(id => !identifier(id)) || vaults.length !== value.length
        || new Set(vaults).size !== vaults.length || value.some(id => !vaults.includes(id))) return false;
    } else if (key === "tags") {
      const labels = tags(actual.tags);
      if (!labels || !Array.isArray(value) || value.some(tag => !contains(labels.get(tag.key), tag))) return false;
    } else if (key === "resources") {
      if (!Array.isArray(value) || !Array.isArray(actual.resources) || actual.resources.some(resource => !object(resource))) return false;
      const used = new Set<number>();
      for (const resource of value) {
        const indices = actual.resources.flatMap((item, index) => !used.has(index) && contains(item, resource) ? [index] : []);
        if (indices.length !== 1) return false;
        used.add(indices[0]);
      }
    } else if (!Object.hasOwn(actual, key) || !contains(actual[key], value)) return false;
  }
  return true;
}

// 关联标签不是服务端幂等键。必须读完有界列表并核对唯一详情；不存在也不允许重发POST。
export async function inspectCreatedSession(value: SessionCreationQuery, read: (path: string) => Promise<unknown>): Promise<SessionCreationInspection> {
  const query = prepareQuery(value);
  if (!query) return unknown("invalid_query");
  let cursor = "", count = 0, candidate: Record<string, unknown> | undefined;
  const cursors = new Set<string>(), ids = new Set<string>();
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({ agent_id: query.agentId, created_at_gte: new Date(Math.max(0, query.createdAt - 30000)).toISOString(), limit: "20", order: "desc" });
    if (cursor) params.set("page", cursor);
    const payload = await read(`/sessions?${params}`);
    if (!object(payload) || hasError(payload) || !Array.isArray(payload.data) || payload.data.length > 20) return unknown("invalid_sessions");
    // 已核实终页可省略next_page；恰好满页又没游标时仍保守保留未知，不能猜分页完整。
    if (!Object.hasOwn(payload, "next_page") && payload.data.length === 20) return unknown("invalid_sessions");
    const next = Object.hasOwn(payload, "next_page") ? payload.next_page : "";
    if (typeof next !== "string" || next.length > 2048 || /[\u0000-\u001f\u007f]/.test(next)
      || (Object.hasOwn(payload, "has_more") && payload.has_more !== Boolean(next))) return unknown("invalid_sessions");
    count += payload.data.length;
    if (count > 100) return unknown("scan_limit");
    for (const session of payload.data) {
      if (!validSession(session, query) || ids.has(String(session.id))) return unknown("invalid_sessions");
      ids.add(String(session.id));
      if (!correlated(session, query)) continue;
      if (candidate) return unknown("ambiguous_session");
      candidate = session;
    }
    if (!next) {
      if (!candidate) return unknown("not_found");
      const detail = await read(`/sessions/${encodeURIComponent(String(candidate.id))}`);
      if (!validSession(detail, query) || detail.id !== candidate.id || timestamp(detail.created_at) !== timestamp(candidate.created_at)
        || !correlated(detail, query)) return unknown("invalid_sessions");
      if (!configurationMatches(detail, query)) return unknown("configuration_unverified");
      return { status: "confirmed", sessionId: String(detail.id), operationId: query.operationId, requestFingerprint: query.requestFingerprint,
        agentId: query.agentId, environmentId: environmentId(detail)!, sessionStatus: detail.status as Extract<SessionCreationInspection, { status: "confirmed" }>["sessionStatus"], checkedAt: Date.now() };
    }
    if (cursors.has(next)) return unknown("invalid_sessions");
    cursors.add(next); cursor = next;
  }
  return unknown("scan_limit");
}
