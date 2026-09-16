import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { ArkClient } from "../src/ark.ts";
import { configFingerprint } from "../src/session-config.ts";

const operationId = "12345678-1234-4234-8234-123456789abc", sessionId = "sesn-original", agentId = "agent-original";
const now = Date.now(), createdAt = now - 1000;
const operationTag = "arkagent_create_operation", requestTag = "arkagent_create_request";
const original = { agent: agentId, environment: { id: "env-original", type: "environment_with_overrides" as const,
  config: { type: "sandbox", env: { SECRET: "PRIVATE_ENV" } } }, vault_ids: ["vault-a", "vault-b"],
  resources: [{ type: "file", file_id: "file-a", mount_path: "/mnt/data/a.pdf" }], title: "private title" };
function query(request: Record<string, unknown> = original) {
  const fingerprint = configFingerprint(request);
  return { operationId, createdAt, agentId, requestFingerprint: fingerprint,
    request: { ...request, tags: [...(request.tags as object[] || []), { key: operationTag, value: operationId }, { key: requestTag, value: fingerprint }] } };
}
function row(q = query(), patch: Record<string, unknown> = {}) {
  return { id: sessionId, type: "session", agent: { id: agentId, version: "1" }, environment_id: "env-original",
    status: "idle", created_at: new Date(createdAt + 100).toISOString(), tags: q.request.tags, ...patch };
}
function detail(q = query(), patch: Record<string, unknown> = {}) {
  return { ...row(q), ...original, agent: { id: agentId, version: "1" },
    environment: { id: "env-original", config: original.environment.config }, ...patch };
}
function clientFor(replies: unknown[], paths: string[] = []) {
  return new ArkClient("PRIVATE_API_KEY", "https://ark.test", async (url, init) => {
    assert.equal(init?.method, "GET"); assert.equal(init?.body, undefined); assert.equal(init?.redirect, "error");
    paths.push(String(url)); assert.ok(replies.length, "不能多查或发送写请求");
    const reply = replies.shift(); return reply instanceof Response ? reply : Response.json(reply);
  });
}

test("creation inspection scans all pages then verifies the sole tagged Session detail", async () => {
  const q = query(), paths: string[] = [];
  const client = clientFor([{ data: [row(q)], next_page: "opaque + token" }, { data: [], next_page: "" }, detail(q)], paths);
  const result = await client.inspectSessionCreation(q as never);
  assert.deepEqual({ ...result, checkedAt: 1 }, { status: "confirmed", sessionId, operationId, requestFingerprint: q.requestFingerprint,
    agentId, environmentId: "env-original", sessionStatus: "idle", checkedAt: 1 });
  const first = new URL(paths[0]), second = new URL(paths[1]);
  assert.equal(first.pathname, "/sessions"); assert.equal(first.searchParams.get("agent_id"), agentId);
  assert.equal(first.searchParams.get("limit"), "20"); assert.equal(first.searchParams.get("order"), "desc");
  assert.ok(Date.parse(first.searchParams.get("created_at_gte")!) <= createdAt);
  assert.equal(first.searchParams.has("tags"), false); assert.equal(second.searchParams.get("page"), "opaque + token");
  assert.equal(paths.at(-1), "https://ark.test/sessions/" + sessionId);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private title|vault-a|file-a/);
});

for (const tags of [undefined, [], [{ key: "custom", value: "value" }]]) test(`original request tag form survives fingerprint validation (${JSON.stringify(tags)})`, async () => {
  const q = query({ ...original, ...(tags === undefined ? {} : { tags }) });
  const result = await clientFor([{ data: [row(q)], next_page: "" }, detail(q)]).inspectSessionCreation(q as never);
  assert.equal(result.status, "confirmed");
});

for (const status of ["idle", "running", "upgrading", "failed", "unknown"])
test(`creation proof preserves the confirmed Session status ${status} without implying readiness`, async () => {
  const q = query();
  const result = await clientFor([{ data: [row(q, { status })], next_page: "" }, detail(q, { status })]).inspectSessionCreation(q as never);
  assert.equal(result.status, "confirmed"); if (result.status === "confirmed") assert.equal(result.sessionStatus, status);
});

const malformedQuery: Array<[string, (q: ReturnType<typeof query>) => unknown]> = [
  ["operation ID", q => ({ ...q, operationId: "not-uuid" })],
  ["future time", q => ({ ...q, createdAt: now + 3600000 })], ["fractional time", q => ({ ...q, createdAt: 1.2 })],
  ["agent binding", q => ({ ...q, agentId: "other-agent" })], ["unsafe agent", q => ({ ...q, agentId: "../agent" })],
  ["hash", q => ({ ...q, requestFingerprint: "a".repeat(64) })],
  ["request tampering", q => ({ ...q, request: { ...q.request, vault_ids: ["other"] } })],
  ["missing tag", q => ({ ...q, request: { ...q.request, tags: q.request.tags.slice(0, 1) } })],
  ["duplicate operation tag", q => ({ ...q, request: { ...q.request, tags: [...q.request.tags, q.request.tags[0]] } })],
  ["wrong tag binding", q => ({ ...q, request: { ...q.request, tags: [{ key: operationTag, value: "other" }, q.request.tags[1]] } })],
  ["unsafe environment", () => query({ ...original, environment: { ...original.environment, id: "../environment" } })],
  ["duplicate vaults", () => query({ ...original, vault_ids: ["vault-a", "vault-a"] })]
];
for (const [name, change] of malformedQuery) test(`invalid ${name} fails closed before any HTTP`, async () => {
  const paths: string[] = [], result = await clientFor([], paths).inspectSessionCreation(change(query()) as never);
  assert.equal(result.status, "unknown"); assert.deepEqual(paths, []);
});

const malformedList: Array<[string, unknown]> = [
  ["missing envelope", {}], ["nested envelope", { data: { items: [row()] }, next_page: "" }],
  ["full page missing cursor", { data: Array.from({ length: 20 }, (_, i) => row(query(), { id: `sesn-${i}`, tags: [] })) }],
  ["null cursor", { data: [row()], next_page: null }],
  ["numeric cursor", { data: [], next_page: 12 }], ["conflicting cursor", { data: [], next_page: "", has_more: true }],
  ["business error", { data: [row()], next_page: "", error: { message: "PRIVATE" } }],
  ["empty error", { data: [row()], next_page: "", error: null }],
  ["business code", { data: [row()], next_page: "", code: 230001 }],
  ["business failure", { data: [row()], next_page: "", success: false }],
  ["unsafe row ID", { data: [row(query(), { id: "../session" })], next_page: "" }],
  ["row type", { data: [row(query(), { type: "agent" })], next_page: "" }],
  ["row agent", { data: [row(query(), { agent: { id: "other" } })], next_page: "" }],
  ["row created time", { data: [row(query(), { created_at: "yesterday" })], next_page: "" }],
  ["row too early", { data: [row(query(), { created_at: "2000-01-01T00:00:00Z" })], next_page: "" }],
  ["row future time", { data: [row(query(), { created_at: "9999-01-01T00:00:00Z" })], next_page: "" }],
  ["row unknown status", { data: [row(query(), { status: "surprise" })], next_page: "" }],
  ["malformed tags", { data: [row(query(), { tags: {} })], next_page: "" }],
  ["duplicate tags", { data: [row(query(), { tags: [...query().request.tags, query().request.tags[0]] })], next_page: "" }],
  ["duplicate candidate", { data: [row(), row()], next_page: "" }],
  ["multiple candidates", { data: [row(), row(query(), { id: "sesn-second" })], next_page: "" }]
];
for (const [name, payload] of malformedList) test(`creation list rejects ${name} without fetching detail`, async () => {
  const paths: string[] = [], result = await clientFor([payload], paths).inspectSessionCreation(query() as never);
  assert.equal(result.status, "unknown"); assert.equal(paths.length, 1);
});

for (const tags of [[], [{ key: operationTag, value: operationId }], [{ key: requestTag, value: query().requestFingerprint }]])
test(`missing dual-tag match remains unknown, never permission to create (${tags.length})`, async () => {
  const result = await clientFor([{ data: [row(query(), { tags })], next_page: "" }]).inspectSessionCreation(query() as never);
  assert.equal(result.status, "unknown");
});

const badDetails: Array<[string, Record<string, unknown>]> = [
  ["id", { id: "sesn-other" }], ["type", { type: "agent" }], ["agent", { agent: { id: "other" } }],
  ["environment", { environment_id: "env-other" }], ["environment object", { environment: { id: "env-other", config: original.environment.config } }],
  ["environment config", { environment: { id: "env-original", config: { type: "sandbox", env: { SECRET: "other" } } } }],
  ["missing environment config", { environment: undefined }], ["vaults", { vault_ids: ["vault-a"] }],
  ["extra user vault", { vault_ids: ["vault-a", "vault-b", "user-other"] }], ["missing resources", { resources: undefined }],
  ["file ID", { resources: [{ ...original.resources[0], file_id: "other" }] }],
  ["mount path", { resources: [{ ...original.resources[0], mount_path: "/wrong" }] }],
  ["resource type", { resources: [{ ...original.resources[0], type: "memory" }] }],
  ["tags", { tags: [] }], ["created time", { created_at: new Date(createdAt + 200).toISOString() }],
  ["status", { status: "new-state" }], ["title", { title: "other" }], ["business error", { error: { message: "PRIVATE" } }]
];
for (const [name, patch] of badDetails) test(`Session detail ${name} mismatch cannot confirm creation`, async () => {
  const result = await clientFor([{ data: [row()], next_page: "" }, detail(query(), patch)]).inspectSessionCreation(query() as never);
  assert.equal(result.status, "unknown"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|other/);
});

test("requested native fields require returned evidence and resource order may differ", async () => {
  const q = query({ ...original, metadata: { native: "yes" }, resources: [...original.resources, { type: "tos", mount_path: "/mnt/tos", bucket: "bucket", prefix: "readonly" }] });
  const response = detail(q, { metadata: { native: "yes", server: "extra" }, resources: [...q.request.resources as object[]].reverse() });
  assert.equal((await clientFor([{ data: [row(q)], next_page: "" }, response]).inspectSessionCreation(q as never)).status, "confirmed");
  delete response.metadata;
  assert.equal((await clientFor([{ data: [row(q)], next_page: "" }, response]).inspectSessionCreation(q as never)).status, "unknown");
});

test("creation lookup requires all pages, rejects cursor loops and scan limits", async () => {
  for (const replies of [
    [{ data: [row()], next_page: "repeat" }, { data: [], next_page: "repeat" }],
    Array.from({ length: 5 }, (_, i) => ({ data: i ? [] : [row()], next_page: `page-${i}` })),
    [{ data: Array.from({ length: 21 }, (_, i) => row(query(), { id: `sesn-${i}`, tags: [] })), next_page: "" }],
    [{ data: [row()], next_page: "page-2" }, { data: [row(query(), { id: "sesn-two" })], next_page: "" }]
  ]) assert.equal((await clientFor(replies).inspectSessionCreation(query() as never)).status, "unknown");
});

test("documented short terminal page may omit next_page, including an empty result", async () => {
  assert.equal((await clientFor([{ data: [row()] }, detail()]).inspectSessionCreation(query() as never)).status, "confirmed");
  assert.deepEqual(await clientFor([{ data: [] }]).inspectSessionCreation(query() as never), { status: "unknown", reason: "not_found" });
});

test("exactly one hundred list rows across five pages can prove a unique Session", async () => {
  const replies = Array.from({ length: 5 }, (_, page) => ({ data: Array.from({ length: 20 }, (_, index) =>
    page === 0 && index === 0 ? row() : row(query(), { id: `sesn-${page}-${index}`, tags: [] })), next_page: page === 4 ? "" : `page-${page}` }));
  assert.equal((await clientFor([...replies, detail()]).inspectSessionCreation(query() as never)).status, "confirmed");
});

test("a duplicate row across list pages cannot prove uniqueness", async () => {
  const replies = [{ data: [row()], next_page: "page-2" }, { data: [row()], next_page: "" }];
  assert.equal((await clientFor(replies).inspectSessionCreation(query() as never)).status, "unknown");
});

test("Agent request wrapper and explicit version cannot be discarded when detail lacks proof", async () => {
  const q = query({ ...original, agent: { id: agentId, type: "agent_reference", version: "1" } });
  assert.equal((await clientFor([{ data: [row(q)], next_page: "" }, detail(q)]).inspectSessionCreation(q as never)).status, "unknown");
  const complete = detail(q, { agent: { id: agentId, type: "agent_reference", version: "1" } });
  assert.equal((await clientFor([{ data: [row(q)], next_page: "" }, complete]).inspectSessionCreation(q as never)).status, "confirmed");
  complete.agent.version = "2";
  assert.equal((await clientFor([{ data: [row(q)], next_page: "" }, complete]).inspectSessionCreation(q as never)).status, "unknown");
});

test("environment ID form works without inventing configuration evidence", async () => {
  const q = query({ agent: agentId, environment_id: "env-original", vault_ids: [], resources: [] });
  assert.equal((await clientFor([{ data: [row(q)] }, { ...row(q), vault_ids: [], resources: [] }]).inspectSessionCreation(q as never)).status, "confirmed");
});

test("duplicate resource matches cannot substitute for unique mounting evidence", async () => {
  assert.equal((await clientFor([{ data: [row()] }, detail(query(), { resources: [original.resources[0], original.resources[0]] })])
    .inspectSessionCreation(query() as never)).status, "unknown");
});

test("query snapshot rejects getters without invoking them and ignores later caller mutation", async () => {
  let touched = 0;
  const poisoned = query(); Object.defineProperty(poisoned.request, "title", { get() { touched++; return "secret"; } });
  assert.equal((await clientFor([]).inspectSessionCreation(poisoned as never)).status, "unknown"); assert.equal(touched, 0);
  const q = query(); let release!: (response: Response) => void, calls = 0;
  const originalDetail = detail(q), originalRow = row(q);
  const client = new ArkClient("PRIVATE_API_KEY", "https://ark.test", async () => ++calls === 1
    ? new Promise<Response>(yes => { release = yes; }) : Response.json(originalDetail));
  const pending = client.inspectSessionCreation(q as never);
  q.request.title = "mutated"; q.requestFingerprint = "a".repeat(64);
  release(Response.json({ data: [originalRow] }));
  assert.equal((await pending).status, "confirmed"); assert.equal(calls, 2);
});

test("malformed JSON and invalid UTF-8 cannot expose upstream payload or confirm creation", async () => {
  for (const body of ["PRIVATE invalid JSON", new Uint8Array([0xff])]) {
    const result = await clientFor([new Response(body)]).inspectSessionCreation(query() as never);
    assert.equal(result.status, "unknown"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});

test("candidate identifiers containing a credential are not returned", async () => {
  const result = await clientFor([{ data: [row(query(), { id: "sesn-PRIVATE_API_KEY" })] }, detail(query(), { id: "sesn-PRIVATE_API_KEY" })])
    .inspectSessionCreation(query() as never);
  assert.equal(result.status, "unknown"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_API_KEY/);
});

for (const status of [301, 400, 401, 403, 429, 500]) test(`creation lookup HTTP ${status} never retries or exposes error bodies`, async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
  const result = await clientFor([response]).inspectSessionCreation(query() as never);
  assert.equal(result.status, "unknown"); assert.equal(cancelled, true);
});

test("creation lookup has a total five-second header deadline even if fetch ignores abort", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let signal: AbortSignal | undefined;
  const client = new ArkClient("key", "https://ark.test", async (_url, init) => { signal = init!.signal!; return new Promise<Response>(() => {}); }, { inspectionTimeoutMs: 30000 });
  const pending = client.inspectSessionCreation(query() as never); t.mock.timers.tick(5000); await flush();
  assert.equal((await pending).status, "unknown"); assert.equal(signal?.aborted, true);
});

test("caller abort cancels creation lookup before or during request without any detail call", async () => {
  const paths: string[] = [];
  assert.equal((await clientFor([], paths).inspectSessionCreation(query() as never, AbortSignal.abort())).status, "unknown");
  assert.deepEqual(paths, []);
  const controller = new AbortController(); let signal: AbortSignal | undefined;
  const client = new ArkClient("key", "https://ark.test", async (_url, init) => { signal = init!.signal!; return new Promise<Response>(() => {}); });
  const pending = client.inspectSessionCreation(query() as never, controller.signal); controller.abort();
  assert.equal((await pending).status, "unknown"); assert.equal(signal?.aborted, true);
});

test("four-MiB response limit is shared by list pages and detail, not reset per HTTP call", async () => {
  const first = JSON.stringify({ data: [row()], next_page: "page-2" }), second = JSON.stringify({ data: [], next_page: "" });
  const result = await clientFor([new Response(first + " ".repeat(3 * 1024 * 1024 - first.length)),
    new Response(second + " ".repeat(2 * 1024 * 1024 - second.length))]).inspectSessionCreation(query() as never);
  assert.equal(result.status, "unknown");
});

test("shared response budget counts a UTF-8 BOM even though decoding strips it", async () => {
  const list = JSON.stringify({ data: [row()] }), final = JSON.stringify(detail());
  const body = "\ufeff" + list + " ".repeat(4 * 1024 * 1024 - Buffer.byteLength(list) - Buffer.byteLength(final));
  const result = await clientFor([new Response(body), new Response(final)]).inspectSessionCreation(query() as never);
  assert.equal(result.status, "unknown");
});

test("exactly four MiB across the list and detail remains within the shared budget", async () => {
  const list = JSON.stringify({ data: [row()] }), final = JSON.stringify(detail());
  const body = list + " ".repeat(4 * 1024 * 1024 - Buffer.byteLength(list) - Buffer.byteLength(final));
  assert.equal((await clientFor([new Response(body), new Response(final)]).inspectSessionCreation(query() as never)).status, "confirmed");
});

test("late response after caller cancellation is cancelled rather than inspected", async () => {
  let release!: (response: Response) => void, cancelled = false;
  const client = new ArkClient("key", "https://ark.test", async () => new Promise<Response>(yes => { release = yes; }));
  const controller = new AbortController(), pending = client.inspectSessionCreation(query() as never, controller.signal);
  controller.abort(); assert.equal((await pending).status, "unknown");
  release(new Response(new ReadableStream({ cancel() { cancelled = true; } }))); await flush(); assert.equal(cancelled, true);
});

test("stalled response body shares the deadline and is cancelled", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let cancelled = false;
  const client = new ArkClient("key", "https://ark.test", async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), { inspectionTimeoutMs: 20 });
  const pending = client.inspectSessionCreation(query() as never); await flush(); t.mock.timers.tick(20); await flush();
  assert.equal((await pending).status, "unknown"); assert.equal(cancelled, true);
});
