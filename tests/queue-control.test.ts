import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import { Gateway, type GatewayOptions } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import type { ChannelMessage } from "../src/channel.ts";
import type { RunInspection } from "../src/ark.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const options: GatewayOptions = { agentId: "agent", environmentId: "env", vaultId: "vault", appId: "app",
  platformAccess: true, sharedGroupSessions: true, durableQueue: true, sessionCompaction: false, timeoutMs: 1000 };
const message = (id: string): ChannelMessage => ({ channelType: "lark", installationId: "app", tenantId: "tenant", senderId: "user",
  conversationType: "direct", conversationId: "chat", threadId: "", rootMessageId: "", parentMessageId: "", messageId: id,
  eventId: id, createTime: 1, text: `private-${id}`, resources: [], mentionedBot: false });
const ended: RunInspection = { status: "ended", anchorEventId: "anchor", terminalEventId: "terminal", result: { terminal: "idle", messages: ["private-result"] } };
async function until(check: () => boolean) { for (let n = 0; n < 150 && !check(); n++) await flush(); assert.ok(check()); }
async function fixture(inspect: () => Promise<RunInspection> = async () => ended) {
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock(); const runs: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => "session", run: async (_id, input) => {
    runs.push(input); if (runs.length === 1) throw new Error("lost response"); return { terminal: "idle", messages: ["done"] };
  }, inspectRun: inspect }, async () => {}, options);
  gateway.accept(message("first")); gateway.accept(message("second"));
  await until(() => store.inbox.findMessage(message("first"))?.state === "uncertain"); await flush();
  return { store, gateway, runs, task: () => store.inbox.findMessage(message("first"))! };
}

test("queue status is read-only, scoped and does not expose request or model text", async () => {
  let queries = 0; const f = await fixture(async () => { queries++; return ended; });
  try {
    const page = f.gateway.listRecoveryTasks("lark", "app");
    assert.equal(page.enabled, true); assert.equal(page.items.length, 2);
    assert.deepEqual(page.items.map(x => x.state), ["uncertain", "queued"]);
    assert.equal(page.items[0].id, f.task().id);
    assert.doesNotMatch(JSON.stringify(page), /private-|requestFingerprint|replyIntent|messages/);
    assert.equal(f.gateway.listRecoveryTasks("lark", "other").items.length, 0);
    assert.equal(queries, 0); assert.equal(f.runs.length, 1);
  } finally { f.store.close(); }
});

test("explicit discard checks original MA run, records failure and releases FIFO without replay", async () => {
  let queries = 0; const f = await fixture(async () => { queries++; return ended; });
  try {
    const task = f.task();
    await f.gateway.controlRecoveryTask("lark", "app", task.id, task.revision, "discard");
    await until(() => f.store.inbox.findMessage(message("second"))?.state === "completed");
    assert.equal(f.task().state, "failed"); assert.equal(f.task().replyConfirmed, undefined);
    assert.equal(f.task().resolution?.action, "discard"); assert.equal(queries, 1); assert.equal(f.runs.length, 2);
    assert.equal(f.store.listAuditLogs().filter(x => x.action === "queue_task_discarded").length, 1);
    assert.equal(f.gateway.accept(message("first")), false);
    await assert.rejects(f.gateway.controlRecoveryTask("lark", "app", task.id, task.revision, "discard"), /任务|版本/);
  } finally { f.store.close(); }
});

for (const observation of [
  { status: "unknown", reason: "anchor_not_found" }, { status: "running" },
  { status: "ended", result: { terminal: "idle", messages: [], authorizationRequired: { identity: "user" } } }
] as RunInspection[]) test(`discard refuses ${observation.status} or unresolved authorization`, async () => {
  const f = await fixture(async () => observation);
  try {
    const task = f.task(); await assert.rejects(f.gateway.controlRecoveryTask("lark", "app", task.id, task.revision, "discard"), /结束|授权/);
    assert.equal(f.task().state, "uncertain"); assert.equal(f.runs.length, 1);
    assert.equal(f.store.inbox.findMessage(message("second"))!.state, "queued");
  } finally { f.store.close(); }
});

test("wrong installation, stale revision and disabled queue never query or mutate", async () => {
  let queries = 0; const f = await fixture(async () => { queries++; return ended; });
  try {
    const task = f.task();
    await assert.rejects(f.gateway.controlRecoveryTask("lark", "other", task.id, task.revision, "discard"), /任务/);
    await assert.rejects(f.gateway.controlRecoveryTask("lark", "app", task.id, task.revision - 1, "discard"), /版本/);
    const disabled = new Gateway(f.store, { createSession: async () => "", run: async () => ({ terminal: "idle", messages: [] }) }, async () => {}, { ...options, durableQueue: false });
    assert.deepEqual(disabled.listRecoveryTasks("lark", "app"), { enabled: false, items: [] });
    await assert.rejects(disabled.controlRecoveryTask("lark", "app", task.id, task.revision, "discard"), /未启用/);
    assert.equal(queries, 0); assert.equal(f.task().state, "uncertain");
  } finally { f.store.close(); }
});

test("late proof after Session reset cannot discard or release original task", async () => {
  let release!: (value: RunInspection) => void;
  const f = await fixture(() => new Promise(resolve => { release = resolve; }));
  try {
    const task = f.task(), pending = f.gateway.controlRecoveryTask("lark", "app", task.id, task.revision, "discard");
    await until(() => Boolean(release)); f.store.resetAllSessions(); release(ended);
    await assert.rejects(pending, /绑定/); assert.equal(f.task().state, "uncertain"); assert.equal(f.runs.length, 1);
  } finally { f.store.close(); }
});

test("concurrent discard cannot duplicate query or resolution", async () => {
  let release!: (value: RunInspection) => void, queries = 0;
  const f = await fixture(() => { queries++; return new Promise(resolve => { release = resolve; }); });
  try {
    const task = f.task(), pending = f.gateway.controlRecoveryTask("lark", "app", task.id, task.revision, "discard");
    await until(() => Boolean(release));
    await assert.rejects(f.gateway.controlRecoveryTask("lark", "app", task.id, task.revision, "discard"), /核查/);
    release(ended); await pending; await until(() => f.runs.length === 2); await flush();
    assert.equal(queries, 1);
  } finally { f.store.close(); }
});

test("manual reconcile only inspects and does not discard an undelivered reply", async () => {
  const f = await fixture();
  try {
    const task = f.task(); await f.gateway.controlRecoveryTask("lark", "app", task.id, task.revision, "reconcile");
    assert.equal(f.task().state, "uncertain"); assert.equal(f.task().inspection?.observation.status, "ended");
    assert.equal(f.task().resolution, undefined); assert.equal(f.runs.length, 1);
    assert.doesNotMatch(JSON.stringify(f.gateway.listRecoveryTasks("lark", "app")), /private-result/);
  } finally { f.store.close(); }
});

test("store refuses stale, future, unknown proof and atomically rolls back failed audit", async () => {
  const f = await fixture();
  try {
    let task = f.store.recordMessageInspection(f.task(), ended);
    const originalNow = Date.now;
    try {
      Date.now = () => task.inspection!.checkedAt + 30_001; assert.throws(() => f.store.discardInspectedMessage(task), /结束/);
      Date.now = () => task.inspection!.checkedAt - 1; assert.throws(() => f.store.discardInspectedMessage(task), /结束/);
    }
    finally { Date.now = originalNow; }
    const originalAudit = f.store.addAuditLog;
    f.store.addAuditLog = () => { throw new Error("audit unavailable"); };
    assert.throws(() => f.store.discardInspectedMessage(task), /audit/);
    f.store.addAuditLog = originalAudit;
    assert.equal(f.task().state, "uncertain"); assert.equal(f.task().revision, task.revision);
    task = f.store.recordMessageInspection(task, { status: "unknown", reason: "history_unavailable" });
    assert.throws(() => f.store.discardInspectedMessage(task), /结束/);
    task = f.store.recordMessageInspection(task, ended);
    f.store.discardInspectedMessage(task); assert.equal(f.task().state, "failed");
  } finally { f.store.close(); }
});

test("pending list has bounded pagination and excludes other Agent records", () => {
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock();
  try {
    for (let n = 0; n < 103; n++) store.receiveMessage(message(`m-${n}`), { scope: "scope", agentId: "agent", configFingerprint: "config" });
    store.receiveMessage(message("foreign"), { scope: "scope", agentId: "other", configFingerprint: "config" });
    const first = store.inbox.listPending("lark", "app", "agent");
    assert.equal(first.tasks.length, 100); assert.equal(first.next, 100);
    const next = store.inbox.listPending("lark", "app", "agent", first.next);
    assert.equal(next.tasks.length, 3); assert.equal(next.next, undefined);
    assert.throws(() => store.inbox.listPending("lark", "app", "agent", -1), /游标/);
  } finally { store.close(); }
});

test("missing native terminal evidence cannot support an administrator discard", async () => {
  const f = await fixture(async () => ({ status: "ended", result: { terminal: "idle", messages: [] } } as any));
  try {
    const task = f.task(); await assert.rejects(f.gateway.controlRecoveryTask("lark", "app", task.id, task.revision, "discard"), /结束/);
    assert.equal(f.task().state, "uncertain");
  } finally { f.store.close(); }
});

test("timed out inspection leaves scope blocked and a late result cannot discard", async t => {
  let release!: (value: RunInspection) => void;
  const f = await fixture(() => new Promise(resolve => { release = resolve; }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const task = f.task(), pending = f.gateway.controlRecoveryTask("lark", "app", task.id, task.revision, "discard");
    await until(() => Boolean(release)); t.mock.timers.tick(10_001);
    await assert.rejects(pending, /结束/); release(ended); await flush();
    assert.equal(f.task().state, "uncertain"); assert.equal(f.runs.length, 1);
  } finally { t.mock.timers.reset(); f.store.close(); }
});

test("committed discard survives real child-process exit without replay or losing its audit", () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-queue-discard-")), path = join(dir, "gateway.db");
  try {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import { Gateway } from './src/gateway.ts'; import { GatewayStore } from './src/store.ts';
      import { setImmediate as flush } from 'node:timers/promises';
      const store = new GatewayStore(${JSON.stringify(path)}); store.acquireRuntimeLock();
      const message = ${JSON.stringify(message("first"))};
      const gateway = new Gateway(store, {createSession:async()=> 'session',run:async()=>{throw Error('lost')},inspectRun:async()=>(${JSON.stringify(ended)})},async()=>{},${JSON.stringify(options)});
      gateway.accept(message);
      while(store.inbox.findMessage(message)?.state !== 'uncertain') await flush();
      const task=store.inbox.findMessage(message);
      await gateway.controlRecoveryTask('lark','app',task.id,task.revision,'discard');
      process.exit(79);
    `], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 79, child.stderr);
    const store = new GatewayStore(path); store.acquireRuntimeLock();
    try {
      const task = store.inbox.findMessage(message("first"))!;
      assert.equal(task.state, "failed"); assert.equal(task.resolution?.action, "discard");
      assert.equal(store.listAuditLogs().filter(x => x.action === "queue_task_discarded").length, 1);
      assert.deepEqual(store.recoverMessages("lark", "app"), { queued: [], interrupted: [], awaitingAuthorization: [] });
      assert.equal(store.receiveMessage(message("first"), task.binding), undefined);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
