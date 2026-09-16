import test from "node:test";
import assert from "node:assert/strict";
import { baselineCompaction, startCompaction, finishCompaction } from "../src/session-compaction.ts";

const stats = { eventCount: 200, latestEventId: "e200", latestBusinessEventId: "u5", latestTokenSampleId: "m5", latestInputTokens: 30000, status: "idle" as const };

test("baseline only records history and never starts an attempt", () => {
  const state = baselineCompaction(stats);
  assert.equal(state.attempt, undefined);
  assert.equal(state.consumedTokenSampleId, "m5");
  assert.equal(state.baselineEventCount, 200);
});

test("manual checkpoint records the exact user command and boundary", () => {
  const state = startCompaction(baselineCompaction(stats), stats, "command", "manual", 1000);
  assert.deepEqual(state.attempt, { source: "manual", messageId: "command", beforeEventId: "e200", startedAt: 1000, result: "running" });
});

test("starting a checkpoint does not mutate the previous state", () => {
  const before = baselineCompaction(stats);
  startCompaction(before, stats, "command", "manual", 1000);
  assert.equal(before.attempt, undefined);
  assert.equal(before.lastMessageId, undefined);
});

test("legacy automatic checkpoints retain failure history for restart inspection", () => {
  let state = startCompaction(baselineCompaction(stats), stats, "one", "automatic", 1000);
  state = finishCompaction(state, "failed", stats, 2000);
  assert.equal(state.attempt?.source, "automatic");
  assert.equal(state.attempt?.terminal, "failed");
  assert.equal(state.failures, 1);
  state = finishCompaction(startCompaction(state, stats, "two", "manual", 3000), "failed", stats, 4000);
  assert.equal(state.paused, true);
  assert.equal(state.failures, 2);
});

test("unknown attempts retain the original submission boundary", () => {
  const running = startCompaction(baselineCompaction(stats), stats, "one", "manual", 1000);
  const unknown = finishCompaction(running, "unknown", undefined, 2000);
  assert.equal(unknown.attempt?.result, "unknown");
  assert.equal(unknown.attempt?.beforeEventId, "e200");
  assert.equal(unknown.attempt?.terminal, undefined);
});

test("successful manual compaction records proof and clears legacy failure pause", () => {
  const started = startCompaction({ ...baselineCompaction(stats), failures: 2, paused: true }, stats, "manual", "manual", 1000);
  const done = finishCompaction(started, "succeeded", { ...stats, eventCount: 205, latestEventId: "e205" }, 2000, 300000, { eventId: "proof", terminal: "idle" });
  assert.equal(done.paused, false);
  assert.equal(done.failures, 0);
  assert.equal(done.attempt?.afterEventId, "e205");
  assert.equal(done.attempt?.evidenceEventId, "proof");
});

test("cannot finish compaction without a submitted attempt", () => {
  assert.throws(() => finishCompaction(baselineCompaction(stats), "succeeded", stats, 1000), /缺少执行记录/);
});

test("platform compaction metadata can be retained without starting a gateway attempt", () => {
  const current = { ...stats, latestCompaction: { eventId: "compacted", eventCount: 199, tokenSampleId: "m5", businessEventId: "u5" } };
  const state = baselineCompaction(current);
  assert.equal(state.platformCompactionEventId, "compacted");
  assert.equal(state.attempt, undefined);
});
