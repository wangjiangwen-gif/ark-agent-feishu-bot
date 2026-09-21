import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseOptions, validateCounts } from "../scripts/benchmark-credential-preparation.mjs";

test("credential benchmark defaults to 128 balanced samples without durable queue and rejects invalid parameters", () => {
  assert.deepEqual(parseOptions([]), { samples: 128, durable: false });
  assert.deepEqual(parseOptions(["--samples", "8", "--durable"]), { samples: 8, durable: true });
  for (const args of [["--samples"], ["--samples", "0"], ["--samples", "7"], ["--samples", "2008"],
    ["--samples", "Infinity"], ["--samples", "8.0"], ["--durable", "--durable"], ["--unknown"], ["--samples", "8", "--samples", "16"]]) {
    assert.throws(() => parseOptions(args), /参数|样本/);
  }
});

test("credential benchmark count checks reject extra remote work and skipped dispatch guards", () => {
  const calls = { create: 0, run: 1, post: 1, send: 1, inspect: 0, refresh: 0, update: 0, provision: 0,
    begin: 0, card: 0, legacyEnsureFresh: 0, prepare: 1, refreshPrepared: 0, matches: 3, guard: 1 };
  validateCounts(calls, "after", 1);
  validateCounts({ ...calls, legacyEnsureFresh: 1, prepare: 0, matches: 0, guard: 0 }, "before", 1);
  for (const key of ["create", "inspect", "refresh", "update", "provision", "begin", "card", "refreshPrepared"]) {
    assert.throws(() => validateCounts({ ...calls, [key]: 1 }, "after", 1), /不应额外调用/);
  }
  for (const key of ["run", "post", "send"]) assert.throws(() => validateCounts({ ...calls, [key]: 2 }, "after", 1), /仅能调用一次/);
  assert.throws(() => validateCounts({ ...calls, guard: 0 }, "after", 1), /没有实际运行/);
});

test("small credential benchmark measures both modes through committed terminal state with only mock external services", () => {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/benchmark-credential-preparation.mjs", "--samples", "8", "--durable"], {
    cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 20_000
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.baselineRef, "1070b63"); assert.equal(report.samples, 8); assert.equal(report.warmup, 16);
  assert.equal(report.externalServices, "mock"); assert.equal(report.endpoint, "successful_terminal_committed_and_independent_sqlite_read");
  assert.equal(report.groups.length, 4); assert.equal(report.comparisons.length, 2);
  for (const group of report.groups) {
    validateCounts(group.calls, group.label, 24);
    assert.equal(group.metrics.toTerminalMs.count, 8);
    assert.ok(group.metrics.afterReplyMs.minMs > 0);
    assert.ok(group.metrics.credentialStoreMs.minMs > 0);
    assert.ok(group.positions.every((position: { count: number }) => position.count === 2));
    for (const row of group.slowest) {
      validateCounts(row.calls, group.label, 1);
      assert.ok(row.operations[group.durableQueue ? "store.finishMessage" : "store.completeEvent"] > 0);
      assert.ok(Math.abs(row.credentialMs - row.credentialStoreMs - row.credentialExclusiveMs) < 1e-6);
      assert.ok(Math.abs(row.toTerminalMs - row.storeMs - row.credentialExclusiveMs - row.otherBeforeTerminalMs) < 1e-6);
    }
  }
});
