import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RunFileObserver, sanitizeFileObservation } from "../src/run-file-observation.ts";
import type { ArkEvent } from "../src/ark.ts";

const read = (id: string, path = "/mnt/session/uploads/a.pdf"): ArkEvent => ({ type: "agent.tool_use", id, name: "read", input: { file_path: path } });
const result = (id: string, call: string, patch: Record<string, unknown> = {}): ArkEvent => ({ type: "agent.tool_result", id, tool_use_id: call,
  is_error: false, content: [{ type: "document", source: { type: "base64", data: "PRIVATE-PDF-BYTES" } }], ...patch });
const reply: ArkEvent = { type: "agent.message", id: "reply", content: [{ type: "text", text: "稍后分析 PRIVATE-MESSAGE" }] };
function observe(events: ArkEvent[]) { const observer = new RunFileObserver(); for (const event of events) observer.observe(event); return observer.snapshot(); }

test("two PDF tool results and a later message are observations, not proof of understanding", () => {
  const value = observe([read("call-a"), read("call-b", "/b.pdf"), result("result-a", "call-a"), result("result-b", "call-b"), reply])!;
  assert.equal(value.replyTiming, "after_reads");
  assert.deepEqual(value.reads.map(x => [x.outcome, x.hasDocument]), [["returned", true], ["returned", true]]);
  assert.equal(value.reads[0].pathHash, createHash("sha256").update("/mnt/session/uploads/a.pdf").digest("hex"));
  assert.equal(value.businessResult, "not_assessed");
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|base64|\/mnt|a\.pdf|稍后/);
});
test("tool completion without a later reply is not confused with model final analysis", () => {
  assert.equal(observe([reply, read("call"), result("result", "call")])!.replyTiming, "before_reads_finished");
  assert.equal(observe([read("call"), result("result", "call")])!.replyTiming, "none");
});
test("missing and failed tool results never become successful document reads", () => {
  const value = observe([read("missing"), read("failed"), result("error", "failed", { is_error: true }), reply])!;
  assert.deepEqual(value.reads.map(x => x.outcome), ["missing_event", "error"]);
  assert.equal(value.replyTiming, "unknown");
});
test("JSON-string tool inputs and explicit call ids use the same linkage as object inputs", () => {
  const value = observe([{ ...read("event"), tool_use_id: "call", input: JSON.stringify({ file_path: "/a.pdf" }) }, result("result", "call"), reply])!;
  assert.equal(value.reads[0].toolUseId, "call"); assert.equal(value.reads[0].outcome, "returned");
});
test("unmatched document results are recorded without pretending they belong to a known file", () => {
  const value = observe([result("orphan", "missing"), reply])!;
  assert.equal(value.unmatchedDocumentResults, 1); assert.equal(value.reads.length, 0); assert.equal(value.replyTiming, "unknown");
});
test("duplicates do not double count, but conflicting result metadata is ambiguous", () => {
  const original = result("result", "call");
  assert.equal(observe([read("call"), original, original, reply])!.reads.length, 1);
  assert.equal(observe([read("call"), original, { ...original, is_error: true }, reply])!.ambiguous, true);
});
test("result-before-call delivery is retained as ambiguous, not final-order proof", () => {
  const value = observe([result("result", "call"), read("call"), reply])!;
  assert.equal(value.reads[0].outcome, "returned"); assert.equal(value.replyTiming, "unknown");
});
test("multiple MA threads and regressing timestamps cannot prove final response order", () => {
  for (const events of [
    [{ ...read("call"), session_thread_id: "one" }, { ...result("result", "call"), session_thread_id: "two" }, reply],
    [{ ...read("call"), processed_at: "2026-09-16T01:01:00Z" }, { ...result("result", "call"), processed_at: "2026-09-16T01:00:00Z" }, reply]
  ]) assert.equal(observe(events)!.replyTiming, "unknown");
});
test("ordinary conversation does not produce file observations", () => {
  assert.equal(observe([reply]), undefined);
  assert.equal(observe([{ ...read("bash"), name: "bash" }, { ...result("text", "bash"), content: [{ type: "text", text: "PRIVATE" }] }, reply]), undefined);
});
test("bounded file observation drops raw payload and marks overflow instead of growing forever", () => {
  const events = Array.from({ length: 300 }, (_, n) => read("call-" + n));
  const value = observe(events)!;
  assert.ok(value.reads.length <= 128); assert.equal(value.truncated, true); assert.equal(value.replyTiming, "unknown");
  const safe = sanitizeFileObservation({ ...value, raw: "PRIVATE", reads: [{ ...value.reads[0], source: "PRIVATE", pathHash: "not-a-hash" }] })!;
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE|not-a-hash|source|raw/);
  assert.equal(safe.businessResult, "not_assessed");
});

test("document result with no call id remains visible as unlinked evidence", () => {
  const value = observe([result("orphan", "", { tool_use_id: undefined }), reply]);
  assert.equal(value?.unmatchedDocumentResults, 1);
  assert.equal(value?.replyTiming, "unknown");
});

test("document bytes are never accessed by the metadata observer", () => {
  const event = result("document", "call");
  event.content = [{ type: "document", get source() { throw new Error("不应访问文件正文"); } }];
  assert.equal(observe([read("call"), event, reply])?.reads[0].hasDocument, true);
});

test("sanitizer downgrades contradictory records instead of preserving misleading reply order", () => {
  const value = observe([read("call"), result("document", "call"), reply])!;
  for (const patch of [{ unmatchedDocumentResults: 1 }, { reads: [{ ...value.reads[0], outcome: "missing_event" }] },
    { reads: [value.reads[0], value.reads[0]] }, { reads: [{ ...value.reads[0], resultEventId: undefined }] }]) {
    assert.equal(sanitizeFileObservation({ ...value, ...patch })?.replyTiming, "unknown");
  }
});
