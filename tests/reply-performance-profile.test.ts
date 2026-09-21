import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { balancedOrder, traceSynchronousMethods, summarize } from "../scripts/profile-text-reply-recovery.mjs";

test("balanced profiling gives each variant every position equally without mutating inputs", () => {
  const variants = ["a", "b", "c", "d"], counts = variants.map(() => [0, 0, 0, 0]);
  for (let round = 0; round < 8; round++) {
    const order = balancedOrder(variants, round);
    assert.deepEqual([...order].sort(), variants);
    for (let position = 0; position < order.length; position++) counts[variants.indexOf(order[position])][position]++;
  }
  assert.deepEqual(counts, variants.map(() => [2, 2, 2, 2]));
  assert.deepEqual(variants, ["a", "b", "c", "d"]);
});

test("synchronous profiling counts nested store methods once and preserves receiver and return value", () => {
  let now = 0;
  const trace = { storeDepth: 0, storeMs: 0, operations: {} }, completed: string[] = [];
  class FakeStore {
    value = 7;
    inner() { now += 3; return this.value; }
    outer() { now += 2; const value = this.inner(); now += 4; return value; }
  }
  const store = new FakeStore(), untouched = new FakeStore();
  const restore = traceSynchronousMethods(store, "store", () => trace, name => { completed.push(name); }, () => now);
  assert.equal(store.outer(), 7);
  assert.equal(trace.storeMs, 9); assert.equal(trace.storeDepth, 0);
  assert.deepEqual(trace.operations, { "store.outer": 9 });
  assert.deepEqual(completed, ["store.inner", "store.outer"]);
  assert.equal(Object.hasOwn(untouched, "outer"), false);
  restore(); assert.equal(Object.hasOwn(store, "outer"), false);
});

test("failed store operations remain failures and are timed without a completion signal", () => {
  let now = 0, finished = false;
  const trace = { storeDepth: 0, storeMs: 0, operations: {} }, failure = new Error("injected");
  class FakeStore { fail() { now += 5; throw failure; } }
  const store = new FakeStore();
  traceSynchronousMethods(store, "store", () => trace, () => { finished = true; }, () => now);
  assert.throws(() => store.fail(), error => error === failure);
  assert.equal(trace.storeMs, 5); assert.equal(trace.storeDepth, 0); assert.equal(finished, false);
});

test("profiling ignores setup outside an active request and never wraps constructors", () => {
  let observed = 0;
  class FakeStore { ready() { return 42; } }
  const store = new FakeStore();
  const restore = traceSynchronousMethods(store, "store", () => undefined, () => { observed++; });
  assert.equal(store.ready(), 42); assert.equal(observed, 0);
  assert.equal(Object.hasOwn(store, "constructor"), false);
  restore();
});

test("latency summary preserves signed paired differences and does not reorder raw samples", () => {
  const values = [3, -2, 1, 0, -1];
  assert.deepEqual(summarize(values), { count: 5, minMs: -2, p50Ms: 0, p95Ms: 1, maxMs: 3, meanMs: .2 });
  assert.deepEqual(values, [3, -2, 1, 0, -1]);
  assert.throws(() => summarize([]), /样本/);
  assert.throws(() => summarize([NaN]), /样本/);
});

test("Store and Inbox nesting shares one timer and excludes later cleanup from captured completion", () => {
  let now = 0, completedMs = -1;
  const trace = { storeDepth: 0, storeMs: 0, operations: {} };
  class Inbox { finish() { now += 4; } }
  const inbox = new Inbox();
  class Store {
    finishMessage() { now += 2; inbox.finish(); }
    cleanup() { now += 8; }
  }
  const store = new Store();
  const complete = (name: string) => { if (name === "store.finishMessage") completedMs = trace.storeMs; };
  traceSynchronousMethods(inbox, "inbox", () => trace, complete, () => now);
  traceSynchronousMethods(store, "store", () => trace, complete, () => now);
  store.finishMessage(); store.cleanup();
  assert.equal(completedMs, 6); assert.equal(trace.storeMs, 14);
  assert.deepEqual(trace.operations, { "store.finishMessage": 6, "store.cleanup": 8 });
});

test("profiling command waits for actual Gateway completion in both modes and emits balanced control results", () => {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/profile-text-reply-recovery.mjs", ".", ".", "8"],
    { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 20000 });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.sameSourceControl, true); assert.equal(report.samples, 8);
  assert.equal(report.groups.length, 4); assert.equal(report.comparisons.length, 4);
  for (const group of report.groups) {
    assert.deepEqual(group.calls, { create: 1, run: 48, send: 48, inspect: 0, observer: group.durableQueue ? 48 : 0 });
    for (const scenario of Object.values(group.scenarios) as any[]) {
      assert.equal(scenario.metrics.totalMs.count, 8);
      assert.ok(scenario.metrics.otherBeforeTerminalMs.minMs >= 0);
      for (const { totalMs } of scenario.positions) assert.equal(totalMs.count, 2);
      for (const row of scenario.slowest) {
        assert.ok(row.operations[group.durableQueue ? "store.finishMessage" : "store.completeEvent"] > 0);
        assert.ok(Math.abs(row.totalMs - row.toTerminalMs - row.afterTerminalMs) < .000001);
        assert.ok(Math.abs(row.toTerminalMs - row.storeMs - row.replyExclusiveMs - row.otherBeforeTerminalMs) < .000001);
      }
    }
  }
});
