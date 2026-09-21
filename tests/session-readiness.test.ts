import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { ArkClient } from "../src/ark.ts";

const sessionId = "sesn-readiness-original", agentId = "agent-original", key = "PRIVATE_API_KEY";
const unknown = { sessionId, status: "unknown" };
const snapshot = (patch: Record<string, unknown> = {}) => ({ id: sessionId, type: "session", status: "idle",
  agent: { id: agentId, system: "PRIVATE_SYSTEM" }, environment: { config: { env: { TOKEN: "PRIVATE_ENV" } } },
  vault_ids: ["PRIVATE_VAULT"], ...patch });

for (const status of ["idle", "running", "upgrading", "failed", "unknown"] as const)
test(`Session readiness uses an exact read-only resource response for ${status}, including no-history Sessions`, async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const client = new ArkClient(key, "https://ark.test", async (url, init) => {
    calls.push({ url: String(url), method: init?.method || "GET", body: init?.body });
    assert.equal((init!.headers as Record<string, string>).Authorization, `Bearer ${key}`);
    assert.ok(init?.signal); return Response.json(snapshot({ status }));
  });
  assert.deepEqual(await client.inspectSessionReadiness(sessionId), { sessionId, status, agentId });
  assert.deepEqual(calls, [{ url: `https://ark.test/sessions/${sessionId}`, method: "GET", body: undefined }]);
});

test("Session readiness accepts the string Agent form and exposes no configuration payload", async () => {
  const client = new ArkClient(key, "https://ark.test", async () => Response.json(snapshot({ agent: agentId })));
  const result = await client.inspectSessionReadiness(sessionId);
  assert.deepEqual(result, { sessionId, status: "idle", agentId });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|environment|system|vault/);
});

const malformed: Array<[string, unknown]> = [
  ["wrong ID", snapshot({ id: "different-session" })], ["missing ID", snapshot({ id: undefined })],
  ["wrong type", snapshot({ type: "agent" })], ["missing type", snapshot({ type: undefined })],
  ["unrecognized status", snapshot({ status: "starting" })], ["uppercase status", snapshot({ status: "IDLE" })],
  ["missing status", snapshot({ status: undefined })], ["missing agent", snapshot({ agent: undefined })],
  ["empty agent", snapshot({ agent: "" })], ["whitespace agent", snapshot({ agent: "  " })],
  ["empty agent ID", snapshot({ agent: { id: "" } })], ["numeric agent ID", snapshot({ agent: { id: 123 } })],
  ["array agent", snapshot({ agent: [agentId] })], ["too long agent", snapshot({ agent: "a".repeat(257) })],
  ["agent contains credential", snapshot({ agent: `agent-${key}` })],
  ["error envelope", snapshot({ error: { message: "PRIVATE_ERROR", code: "error" } })],
  ["empty error field", snapshot({ error: null })], ["data envelope", { data: snapshot() }],
  ["array response", [snapshot()]], ["null response", null]
];
for (const [name, payload] of malformed) test(`Session readiness refuses ${name} without leaking payload`, async () => {
  let calls = 0;
  const client = new ArkClient(key, "https://ark.test", async () => { calls++; return Response.json(payload); });
  assert.deepEqual(await client.inspectSessionReadiness(sessionId), unknown); assert.equal(calls, 1);
});

for (const bad of ["", "../session", "session?query", "session/other", "session\nother", "s".repeat(257)])
test(`Session readiness rejects invalid requested ID ${JSON.stringify(bad)} without a request`, async () => {
  let calls = 0;
  const client = new ArkClient(key, "https://ark.test", async () => { calls++; throw new Error("must not fetch"); });
  assert.deepEqual(await client.inspectSessionReadiness(bad), { sessionId: bad, status: "unknown" }); assert.equal(calls, 0);
});

for (const status of [301, 400, 401, 403, 404, 429, 500]) test(`HTTP ${status} produces unknown and cancels rather than reading sensitive errors`, async () => {
  let reads = 0, cancelled = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ pull() { reads++; }, cancel() { cancelled++; } }), { status });
  const client = new ArkClient(key, "https://ark.test", async () => response);
  assert.deepEqual(await client.inspectSessionReadiness(sessionId), unknown);
  assert.ok(cancelled > 0); assert.ok(reads <= 1);
});

test("Session readiness suppresses network and malformed JSON errors", async () => {
  for (const reply of [async () => { throw new Error("PRIVATE_NETWORK "+key); }, async () => new Response("PRIVATE_NOT_JSON")]) {
    const client = new ArkClient(key, "https://ark.test", reply);
    assert.deepEqual(await client.inspectSessionReadiness(sessionId), unknown);
  }
});

test("already aborted caller cancels readiness without any HTTP request", async () => {
  let calls = 0;
  const client = new ArkClient(key, "https://ark.test", async () => { calls++; return Response.json(snapshot()); });
  assert.deepEqual(await client.inspectSessionReadiness(sessionId, AbortSignal.abort("PRIVATE_REASON")), unknown);
  assert.equal(calls, 0);
});

test("caller abort stops a stalled header request even when fetcher ignores its signal", async () => {
  let supplied: AbortSignal | undefined;
  const client = new ArkClient(key, "https://ark.test", async (_url, init) => { supplied = init!.signal!; return new Promise<Response>(() => {}); });
  const controller = new AbortController(), pending = client.inspectSessionReadiness(sessionId, controller.signal);
  controller.abort("PRIVATE_REASON");
  assert.deepEqual(await pending, unknown); assert.equal(supplied?.aborted, true);
});

test("total readiness deadline is capped at five seconds even for a stalled fetcher", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let supplied: AbortSignal | undefined;
  const client = new ArkClient(key, "https://ark.test", async (_url, init) => { supplied = init!.signal!; return new Promise<Response>(() => {}); }, { inspectionTimeoutMs: 30_000 });
  let settled = false; const pending = client.inspectSessionReadiness(sessionId).then(value => { settled = true; return value; });
  t.mock.timers.tick(4_999); await flush(); assert.equal(settled, false);
  t.mock.timers.tick(1); await flush(); assert.deepEqual(await pending, unknown); assert.equal(supplied?.aborted, true);
});

test("header and body phases share one deadline and stalled body is cancelled", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false, release!: (value: Response) => void;
  const client = new ArkClient(key, "https://ark.test", async () => new Promise<Response>(yes => { release = yes; }), { inspectionTimeoutMs: 50 });
  const pending = client.inspectSessionReadiness(sessionId);
  t.mock.timers.tick(40);
  release(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
  await flush(); t.mock.timers.tick(10); await flush();
  assert.deepEqual(await pending, unknown); assert.equal(cancelled, true);
});

test("a late response after cancellation cannot leak data and its body is cancelled", async () => {
  let release!: (value: Response) => void, cancelled = false;
  const client = new ArkClient(key, "https://ark.test", async () => new Promise<Response>(yes => { release = yes; }));
  const controller = new AbortController(), pending = client.inspectSessionReadiness(sessionId, controller.signal);
  controller.abort(); assert.deepEqual(await pending, unknown);
  release(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
  await flush(); assert.equal(cancelled, true);
});

for (const mode of ["oversize", "invalid-utf8"] as const) test(`Session readiness cancels ${mode} response bodies`, async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(mode === "oversize" ? new Uint8Array(4 * 1024 * 1024 + 1) : new Uint8Array([0xff]));
  }, cancel() { cancelled = true; } }));
  const client = new ArkClient(key, "https://ark.test", async () => response);
  assert.deepEqual(await client.inspectSessionReadiness(sessionId), unknown); assert.equal(cancelled, true);
});

test("Session readiness accepts an exactly four-MiB response without returning unrelated data", async () => {
  const data = JSON.stringify(snapshot()), body = data + " ".repeat(4 * 1024 * 1024 - Buffer.byteLength(data));
  const client = new ArkClient(key, "https://ark.test", async () => new Response(body));
  assert.deepEqual(await client.inspectSessionReadiness(sessionId), { sessionId, status: "idle", agentId });
});
