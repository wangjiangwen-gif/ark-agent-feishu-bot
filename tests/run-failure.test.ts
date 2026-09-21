import test from "node:test";
import assert from "node:assert/strict";
import { ArkClient, resultFromEvents, type ArkEvent } from "../src/ark.ts";
import { resultToReply } from "../src/gateway.ts";

const requestId = "021789567820234d6bdab3051f46472bfd942e874cc5db08e552e-Wh7Ms_eY2vBSmsZKyAIZ9";
const failure = { kind: "timeout", code: "model_file_processing_timeout", requestId };
const error = { type: "model_request_failed_error", message: JSON.stringify({ error: {
  code: "InvalidParameter", param: "file_url", message: `Timeout while processing file_url Request id: ${requestId}`
} }), retry_status: { type: "exhausted" } };
const events = [
  { id: "input", type: "user.message", content: [{ type: "text", text: "read pdf" }] },
  { id: "error", type: "session.error", error },
  { id: "idle", type: "session.status_idle" }
];
const historyResult = (items: ArkEvent[]) => resultFromEvents(items.map(item => ({ ...item, processed_at: "2026-09-16T00:00:00Z" })), 0);

test("history retains safe file-processing failure after idle", () => {
  const result = historyResult(events)!;
  assert.equal(result.terminal, "failed");
  assert.deepEqual(result.failure, failure);
  assert.throws(() => resultToReply(result), e => {
    assert.match(String(e), /文件内容处理超时/);
    assert.match(String(e), new RegExp(requestId));
    assert.doesNotMatch(String(e), /InvalidParameter|retry_status/);
    return true;
  });
});

for (const transport of ["sse", "poll"] as const) test(`${transport} retains failure without replaying the request`, async () => {
  let posted = 0;
  const client = new ArkClient("test-secret", "https://ark.example/api/v3", async (url, init) => {
    if (init?.method === "POST") { posted++; return new Response("{}"); }
    if (String(url).includes("/stream")) {
      if (transport === "poll") return new Response("", { status: 503 });
      const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
      return new Response(new ReadableStream({ start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      } }));
    }
    return new Response(JSON.stringify({ data: posted && transport === "poll" ? events : [] }));
  }, { sseHeadStartMs: 0, eventPollIntervalMs: 1 });
  const result = await client.run("session", "read pdf", 1000);
  assert.deepEqual(result.failure, failure);
  assert.equal(posted, 1);
});

for (const raw of [
  { type: "model_request_failed_error", message: "secret https://private.example?token=secret" },
  { type: "secret-value", message: "Timeout while processing file_url Request id: secret" },
  { type: "model_request_failed_error", message: "x".repeat(40000) },
  { type: "model_request_failed_error", message: JSON.stringify({ error: { param: "other", message: "Timeout while processing file_url" } }) }
]) test(`unrecognized error stays safe (${String(raw.type)}, ${raw.message.length} chars)`, () => {
  const result = historyResult([{ type: "session.error", error: raw }])!;
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.notEqual(result.failure?.code, "model_file_processing_timeout");
  assert.throws(() => resultToReply(result), /执行失败/);
});

test("rate limits keep a distinct static classification", () => {
  const result = historyResult([{ type: "session.error", error: { type: "model_rate_limited_error", message: "private" } }])!;
  assert.deepEqual(result.failure, { kind: "rate_limit", code: "model_rate_limited_error" });
  assert.throws(() => resultToReply(result), /限流/);
});

test("API key cannot escape through a request ID", async () => {
  const key = requestId;
  const client = new ArkClient(key, "https://ark.example/api/v3", async url => String(url).includes("/stream")
    ? new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("")) : new Response("{}"), { sseHeadStartMs: 0 });
  const result = await client.run("session", "read pdf", 1000);
  assert.equal(JSON.stringify(result.failure).includes(key), false);
});

test("old successful runs have no added failure diagnostic", () => {
  assert.deepEqual(historyResult([{ type: "agent.message", content: [{ type: "text", text: "ok" }] }, { type: "session.status_idle" }]),
    { terminal: "idle", messages: ["ok"] });
});
