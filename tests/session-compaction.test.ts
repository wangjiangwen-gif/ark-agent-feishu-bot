import test from "node:test";
import assert from "node:assert/strict";
import { baselineCompaction, decideCompaction, startCompaction, finishCompaction } from "../src/session-compaction.ts";

const stats = { eventCount: 200, latestEventId: "e200", latestBusinessEventId: "u5", latestTokenSampleId: "m5", latestInputTokens: 30000, status: "idle" as const };

test("legacy history establishes a baseline without compacting old samples", () => {
  const decision = decideCompaction(undefined, stats, "incoming", 1000);
  assert.equal(decision.compact, false);
  assert.equal(decision.checkpoint.consumedTokenSampleId, "m5");
  assert.equal(decision.checkpoint.baselineEventCount, 200);
});

test("only new business context can consume a fresh oversized token sample", () => {
  const state = baselineCompaction(stats);
  assert.equal(decideCompaction(state, { ...stats, latestTokenSampleId: "other-model-event" }, "incoming", 1000).compact, false);
  assert.equal(decideCompaction(state, { ...stats, latestBusinessEventId: "u6", latestTokenSampleId: "m6" }, "incoming", 1000).compact, true);
});

test("a previously consumed large sample cannot trigger another compact", () => {
  const state = baselineCompaction(stats);
  assert.equal(decideCompaction(state, { ...stats, latestBusinessEventId: "u6", eventCount: 210 }, "incoming", 1000).compact, false);
});

test("failed attempts consume their sample and preserve cooldown and circuit breaker", () => {
  let state = startCompaction(baselineCompaction({ ...stats, eventCount: 0 }), stats, "one", "automatic", 1000);
  state = finishCompaction(state, "failed", stats, 2000);
  const newer = { ...stats, latestBusinessEventId: "u6", latestTokenSampleId: "m6" };
  assert.equal(decideCompaction(state, newer, "two", 2001).compact, false);
  assert.equal(decideCompaction(state, newer, "two", 302001).compact, true);
  state = finishCompaction(startCompaction(state, newer, "two", "automatic", 302001), "failed", newer, 303000);
  assert.equal(state.paused, true);
  assert.equal(decideCompaction(state, { ...newer, eventCount: 1000 }, "three", 999999).compact, false);
});

test("unknown or in-flight attempt blocks another submission even after cooldown", () => {
  const running = startCompaction(baselineCompaction(stats), stats, "one", "manual", 1000);
  assert.equal(decideCompaction(running, { ...stats, eventCount: 1000 }, "two", 999999).compact, false);
  const unknown = finishCompaction(running, "unknown", undefined, 2000);
  assert.equal(decideCompaction(unknown, { ...stats, eventCount: 1000 }, "two", 999999).compact, false);
  assert.equal(unknown.attempt?.beforeEventId, "e200");
});

test("successful compact resets baseline and manual success clears auto failure pause", () => {
  const started = startCompaction({ ...baselineCompaction(stats), failures: 2, paused: true }, stats, "manual", "manual", 1000);
  const done = finishCompaction(started, "succeeded", { ...stats, eventCount: 205, latestEventId: "e205" }, 2000);
  assert.equal(done.paused, false);
  assert.equal(done.failures, 0);
  assert.equal(done.attempt?.afterEventId, "e205");
  assert.equal(decideCompaction(done, stats, "next", 999999).compact, false);
});

test("no repeated message or running session can initiate automatic compaction", () => {
  const state = baselineCompaction({ ...stats, eventCount: 0, latestBusinessEventId: "older", latestTokenSampleId: "older" });
  assert.equal(decideCompaction(state, { ...stats, status: "running" }, "one", 1000).compact, false);
  assert.equal(decideCompaction({ ...state, lastMessageId: "one" }, stats, "one", 1000).compact, false);
  assert.equal(decideCompaction(state, { ...stats, status: undefined }, "one", 1000).compact, false);
});

test("verified platform compaction establishes a fresh persisted boundary without sending compact", () => {
  const previous = baselineCompaction({ eventCount: 0 });
  const current = { ...stats, latestCompaction: { eventId: "compacted", eventCount: 199, tokenSampleId: "m5", businessEventId: "u5" } };
  const decision = decideCompaction(previous, current, "one", 1000);
  assert.equal(decision.compact, false);
  assert.equal(decision.checkpoint.platformCompactionEventId, "compacted");
  assert.equal(decision.checkpoint.baselineEventCount, 199);
  assert.equal(decideCompaction(decision.checkpoint, current, "two", 999999).compact, false);
});
