import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ArkClient, type ArkEvent } from "../src/ark.ts";

const input = '当前请求 message_id="message-123"\n查询今天日程';
const fingerprint = createHash("sha256").update(input).digest("hex");
const text = (id: string, type: string, value: string): ArkEvent => ({ id, type, content: [{ type: "text", text: value }] });
const anchor = text("user-1", "user.message", input);
const running = { id: "running-1", type: "session.status_running" };
const reply = text("reply-1", "agent.message", "已经查询完成");
const idle = { id: "idle-1", type: "session.status_idle" };

function fixture(pages: unknown[]) {
  const calls: { url: string; method: string }[] = [];
  const client = new ArkClient("not-a-real-key", "https://example.invalid/api/v3", (async (url, init) => {
    calls.push({ url: String(url), method: init?.method || "GET" });
    assert.equal(init?.method || "GET", "GET");
    assert.equal(init?.body, undefined);
    return Response.json(pages[calls.length - 1]);
  }) as typeof fetch);
  return { client, calls };
}

test("inspection anchors the exact request across pages and never submits work", async () => {
  const { client, calls } = fixture([
    { data: [text("old-user", "user.message", "以前的问题"), { ...idle, id: "old-idle" }, anchor], next_page: "cursor/+" },
    { data: { items: [running, reply, idle] } }
  ]);
  const result = await client.inspectRun("session/one", fingerprint);
  assert.deepEqual(result, { status: "ended", anchorEventId: "user-1", terminalEventId: "idle-1", result: { terminal: "idle", messages: ["已经查询完成"] } });
  assert.deepEqual(calls.map(call => call.url), [
    "https://example.invalid/api/v3/sessions/session%2Fone/events?limit=200",
    "https://example.invalid/api/v3/sessions/session%2Fone/events?limit=200&page=cursor%2F%2B"
  ]);
});

test("inspection reports runtime completion without claiming business success", async () => {
  const { client } = fixture([{ data: [anchor, running, idle] }]);
  const result = await client.inspectRun("session", fingerprint);
  assert.equal(result.status, "ended");
  if (result.status === "ended") assert.deepEqual(result.result.messages, []);
});

test("inspection requires a session terminal even after a tool or session error", async () => {
  const error = { id: "error", type: "session.error", error: { message: "failed" } };
  const first = fixture([{ data: [anchor, running, error] }]);
  assert.equal((await first.client.inspectRun("session", fingerprint)).status, "running");
  const second = fixture([{ data: [anchor, running, error, idle] }]);
  const result = await second.client.inspectRun("session", fingerprint);
  assert.equal(result.status, "ended");
  if (result.status === "ended") assert.equal(result.result.terminal, "failed");
});

test("inspection returns running only with observed running status", async () => {
  const { client } = fixture([{ data: [anchor, running, reply] }]);
  assert.deepEqual(await client.inspectRun("session", fingerprint), { status: "running", anchorEventId: "user-1" });
  const pending = fixture([{ data: [anchor] }]);
  assert.deepEqual(await pending.client.inspectRun("session", fingerprint), { status: "unknown", reason: "terminal_not_observed", anchorEventId: "user-1" });
});

for (const events of [[], [idle], [text("different", "user.message", input + " "), idle]]) {
  test(`inspection never uses old idle or approximate input as an anchor (${events.length}:${events[0]?.id})`, async () => {
    const { client } = fixture([{ data: events }]);
    assert.deepEqual(await client.inspectRun("session", fingerprint), { status: "unknown", reason: "anchor_not_found" });
  });
}

test("identical repeated events are deduplicated even with reordered JSON keys", async () => {
  const { client } = fixture([{ data: [anchor, running, reply, { content: reply.content, type: reply.type, id: reply.id }, idle, idle] }]);
  const result = await client.inspectRun("session", fingerprint);
  assert.equal(result.status, "ended");
  if (result.status === "ended") assert.deepEqual(result.result.messages, ["已经查询完成"]);
});

for (const [name, events, reason] of [
  ["conflicting event identity", [anchor, reply, text("reply-1", "agent.message", "different"), idle], "conflicting_event"],
  ["two matching requests", [anchor, idle, { ...anchor, id: "user-2" }], "ambiguous_anchor"],
  ["later request before terminal", [anchor, text("user-2", "user.message", "另外一个问题"), reply, idle], "later_request"],
  ["later request after terminal", [anchor, reply, idle, text("user-2", "user.message", "另外一个问题"), running], "later_request"],
  ["running resumes after terminal", [anchor, reply, idle, running], "activity_after_terminal"],
  ["reply arrives after terminal", [anchor, idle, reply], "activity_after_terminal"],
  ["multiple MA threads", [anchor, { ...reply, session_thread_id: "thread-1" }, { ...running, session_thread_id: "thread-2" }, idle], "multiple_threads"],
  ["reversed event timestamps", [{ ...anchor, processed_at: "2026-09-16T02:00:02Z" }, { ...idle, processed_at: "2026-09-16T02:00:01Z" }], "event_order_unknown"]
] as const) {
  test(`inspection refuses ambiguous history: ${name}`, async () => {
    const { client } = fixture([{ data: events }]);
    const result = await client.inspectRun("session", fingerprint);
    assert.equal(result.status, "unknown");
    if (result.status === "unknown") assert.equal(result.reason, reason);
  });
}

test("inspection retains structured user authorization and original tool evidence", async () => {
  const { client } = fixture([{ data: [anchor, running,
    { id: "tool", type: "agent.tool_use", tool_use_id: "call", name: "bash", input: { command: "lark-cli calendar +agenda --as user" } },
    { ...text("tool-result", "agent.tool_result", 'exit_code: 3\n--- stderr ---\n{"ok":false,"identity":"user","error":{"type":"authentication","subtype":"token_missing"}}'), tool_use_id: "call", is_error: false }, idle] }]);
  const result = await client.inspectRun("session", fingerprint);
  assert.equal(result.status, "ended");
  if (result.status !== "ended") return;
  assert.equal(result.result.authorizationRequired?.domain, "calendar");
  assert.equal(result.result.evidence?.anchorEventId, "user-1");
  assert.equal(result.result.evidence?.complete, true);
  assert.equal(result.result.evidence?.steps[0].outcome, "auth_required");
});

for (const [name, payload] of [
  ["empty envelope", {}], ["null", null], ["non-array items", { data: { items: {} } }],
  ["anonymous event", { data: [{ type: "session.status_idle" }] }],
  ["missing type", { data: [{ id: "event" }] }],
  ["invalid cursor", { data: [idle], next_page: 12 }],
  ["conflicting cursor", { data: { items: [idle], next_page: "b" }, next_page: "a" }]
] as const) {
  test(`inspection does not accept incomplete history: ${name}`, async () => {
    const { client } = fixture([{ data: [anchor, reply, idle], next_page: "next" }, payload]);
    assert.deepEqual(await client.inspectRun("session", fingerprint), { status: "unknown", reason: "history_unavailable" });
  });
}

test("inspection rejects repeated cursors instead of returning partial completion", async () => {
  const { client } = fixture([{ data: [anchor, idle], next_page: "same" }, { data: [], next_page: "same" }]);
  assert.deepEqual(await client.inspectRun("session", fingerprint), { status: "unknown", reason: "history_unavailable" });
});

test("inspection does not disclose upstream errors or start work after cancellation", async () => {
  let calls = 0;
  const client = new ArkClient("key", "https://example.invalid", (async () => {
    calls++;
    throw new Error("upstream leaked secret-token");
  }) as typeof fetch);
  assert.deepEqual(await client.inspectRun("session", fingerprint), { status: "unknown", reason: "history_unavailable" });
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await client.inspectRun("session", fingerprint, controller.signal), { status: "unknown", reason: "history_unavailable" });
  assert.equal(calls, 1);
});

test("invalid request fingerprints fail before any network access", async () => {
  const { client, calls } = fixture([]);
  await assert.rejects(() => client.inspectRun("session", "not-a-fingerprint"), /指纹/);
  assert.equal(calls.length, 0);
});

test("inspection bounds the entire history operation and cancels a stalled response body", async () => {
  let cancelled = false;
  const keepAlive = setTimeout(() => {}, 1000);
  const client = new ArkClient("key", "https://example.invalid", (async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')); },
    cancel() { cancelled = true; }
  }))) as typeof fetch, { inspectionTimeoutMs: 15 });
  try {
    assert.deepEqual(await client.inspectRun("session", fingerprint), { status: "unknown", reason: "history_unavailable" });
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});

test("inspection stops reading oversized bodies before parsing or retaining an unlimited document payload", async () => {
  let cancelled = false;
  let chunks = 0;
  const block = new TextEncoder().encode(" ".repeat(1024 * 1024));
  const client = new ArkClient("key", "https://example.invalid", (async () => new Response(new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(block); },
    cancel() { cancelled = true; }
  }))) as typeof fetch);
  assert.deepEqual(await client.inspectRun("session", fingerprint), { status: "unknown", reason: "history_unavailable" });
  assert.equal(cancelled, true);
  assert.ok(chunks <= 66);
});

test("inspection stops at the page limit even if all cursors are distinct", async () => {
  const { client, calls } = fixture(Array.from({ length: 100 }, (_, index) => ({ data: index ? [] : [anchor, idle], next_page: `page-${index}` })));
  assert.deepEqual(await client.inspectRun("session", fingerprint), { status: "unknown", reason: "history_unavailable" });
  assert.equal(calls.length, 100);
});

test("inspection rejects excessive event counts even in a single successful response", async () => {
  const { client } = fixture([{ data: [anchor, idle, ...Array.from({ length: 19_999 }, (_, index) => ({ id: `metadata-${index}`, type: "metadata" }))] }]);
  assert.deepEqual(await client.inspectRun("session", fingerprint), { status: "unknown", reason: "history_unavailable" });
});

test("inspection refuses a same-text multimodal request and allows harmless terminal metadata", async () => {
  const multimodal = fixture([{ data: [{ ...anchor, content: [...anchor.content as object[], { type: "image", source: { data: "other" } }] }, idle] }]);
  assert.deepEqual(await multimodal.client.inspectRun("session", fingerprint), { status: "unknown", reason: "anchor_not_found" });
  const metadata = fixture([{ data: [anchor, reply, idle, { id: "thread-idle", type: "session.thread_status_idle", session_thread_id: "one" }] }]);
  assert.equal((await metadata.client.inspectRun("session", fingerprint)).status, "ended");
});

test("inspection decodes split UTF-8 bytes but rejects damaged response encoding", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ data: [anchor, reply, idle] }));
  const client = new ArkClient("key", "https://example.invalid", (async () => new Response(new ReadableStream({
    start(controller) {
      for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    }
  }))) as typeof fetch);
  assert.equal((await client.inspectRun("session", fingerprint)).status, "ended");
  const broken = new ArkClient("key", "https://example.invalid", (async () => new Response(Uint8Array.from([...encoded.slice(0, -1), 255, 125]))) as typeof fetch);
  assert.deepEqual(await broken.inspectRun("session", fingerprint), { status: "unknown", reason: "history_unavailable" });
});
