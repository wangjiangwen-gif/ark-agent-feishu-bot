import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { GatewayStore } from "../src/store.ts";
import type { ChannelMessage } from "../src/channel.ts";
import type { InboxTask } from "../src/message-inbox.ts";
import { createPreparationPlan, validatePreparationPlan, MAX_PREPARATION_OUTPUT_BYTES, MAX_PREPARATION_STEPS } from "../src/preparation-plan.ts";

const message = (id = "first"): ChannelMessage => ({ channelType: "lark", installationId: "app", tenantId: "tenant",
  senderId: "user", conversationId: "chat", conversationType: "direct", threadId: "", rootMessageId: "", parentMessageId: "",
  messageId: id, eventId: id, createTime: 100, text: "请处理文件", resources: [], mentionedBot: false });
const binding = { scope: "scope", agentId: "agent", configFingerprint: "config" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const descriptor = (id = "history") => ({ id, kind: "observation" as const, inputFingerprint: hash(id) });
const target = { reusable: true, sessionId: "original-session" };
function memory() { const store = new GatewayStore(":memory:"); store.acquireRuntimeLock(); return store; }
function claim(store: GatewayStore, id = "first"): InboxTask {
  const queued = store.receiveMessage(message(id), binding)!;
  return store.inbox.claim(queued.id, binding)!;
}
function planned(store: GatewayStore, id = "first"): InboxTask { return store.inbox.beginPreparationPlan(claim(store, id), target); }
function db(store: GatewayStore): DatabaseSync { return (store as unknown as { db: DatabaseSync }).db; }
function rewrite(store: GatewayStore, taskId: string, fields: Record<string, unknown>, mutate: (payload: any) => any = payload => payload): void {
  const original = db(store).prepare("SELECT * FROM gateway_message_inbox WHERE id=?").get(taskId)!;
  const context = (row: Record<string, unknown>) => JSON.stringify(["message-inbox", row.sequence, row.id, row.event_key,
    row.channel_type, row.installation_id, row.scope, row.agent_id, row.config_fingerprint, row.state, row.owner, row.revision,
    row.session_id, row.request_fingerprint, row.interrupted_at]);
  const payload = mutate(JSON.parse(store.credentials.openAuthorization(String(original.secret), context(original))));
  const updated = { ...original, ...fields }, secret = store.credentials.sealAuthorization(JSON.stringify(payload), context(updated));
  for (const [column, value] of Object.entries(fields)) {
    assert.ok(["state", "session_id", "request_fingerprint", "interrupted_at", "owner", "sequence"].includes(column));
    db(store).prepare(`UPDATE gateway_message_inbox SET ${column}=? WHERE id=?`).run(value as string | number | null, taskId);
  }
  db(store).prepare("UPDATE gateway_message_inbox SET secret=? WHERE id=?").run(secret, taskId);
}

test("preparation plans freeze the target and named outputs without recording model dispatch", () => {
  const store = memory();
  try {
    const initial = claim(store), first = store.inbox.beginPreparationPlan(initial, target);
    assert.equal(first.sessionId, undefined); assert.equal(first.requestFingerprint, undefined); assert.equal(first.dispatchId, undefined);
    assert.deepEqual(first.preparationPlan!.target, target); assert.equal(first.preparationPlan!.version, 1);
    const id = first.preparationPlan!.id;
    assert.deepEqual(store.inbox.beginPreparationPlan(first, { ...target }), first);
    assert.throws(() => store.inbox.beginPreparationPlan(first, { reusable: false }), /计划|绑定/);
    const started = store.inbox.beginPreparationStep(first, id, descriptor());
    assert.equal(started.preparationPlan!.steps[0].state, "pending");
    assert.deepEqual(store.inbox.beginPreparationStep(started, id, descriptor()), started);
    const output = { history: [{ text: "PRIVATE_HISTORY", resources: [] }], request: { env: "PRIVATE_ENV" } };
    const completed = store.inbox.completePreparationStep(started, id, "history", output);
    output.history[0].text = "changed";
    assert.equal((completed.preparationPlan!.steps[0].output as any).history[0].text, "PRIVATE_HISTORY");
    assert.deepEqual(store.inbox.completePreparationStep(completed, id, "history", completed.preparationPlan!.steps[0].output!), completed);
    assert.throws(() => store.inbox.completePreparationStep(completed, id, "history", null), /步骤|替换/);
    assert.throws(() => store.inbox.beginPreparationStep(completed, id, { ...descriptor(), kind: "hook" }), /步骤|绑定/);
    assert.throws(() => store.inbox.beginPreparationStep(completed, id, { ...descriptor(), inputFingerprint: hash("changed") }), /步骤|绑定/);
  } finally { store.close(); }
});

test("plans and pending steps survive encrypted restart and can be claimed without implying safe replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "ark-preparation-plan-")), path = join(directory, "gateway.db");
  let store = new GatewayStore(path);
  try {
    store.acquireRuntimeLock();
    let task = planned(store), id = task.preparationPlan!.id;
    task = store.inbox.beginPreparationStep(task, id, descriptor());
    task = store.inbox.completePreparationStep(task, id, "history", { text: "PRIVATE_FROZEN_HISTORY", token: "PRIVATE_REQUEST_TOKEN" });
    task = store.inbox.beginPreparationStep(task, id, { ...descriptor("build"), kind: "hook" });
    store.close();
    for (const secret of ["PRIVATE_FROZEN_HISTORY", "PRIVATE_REQUEST_TOKEN"]) assert.equal(readFileSync(path).includes(Buffer.from(secret)), false);
    store = new GatewayStore(path); store.acquireRuntimeLock();
    const interrupted = store.recoverMessages("lark", "app").interrupted[0];
    assert.deepEqual(interrupted.preparationPlan, task.preparationPlan);
    assert.equal(interrupted.interruptedAt, "preparing");
    const resumed = store.claimPreparingMessage(interrupted, binding);
    assert.equal(resumed.state, "preparing"); assert.equal(resumed.interruptedAt, undefined);
    assert.notEqual(resumed.owner, interrupted.owner);
    assert.equal(resumed.preparationPlan!.steps[1].state, "pending");
    assert.equal(db(store).prepare("SELECT dispatched FROM processed_events").get()!.dispatched, 0);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("all mutation APIs reject stale revision, owner, plan ID, target and binding snapshots", () => {
  const store = memory();
  try {
    const first = planned(store), id = first.preparationPlan!.id;
    const started = store.inbox.beginPreparationStep(first, id, descriptor());
    assert.throws(() => store.inbox.beginPreparationStep(first, id, descriptor("other")), /版本|计划/);
    assert.throws(() => store.inbox.completePreparationStep(first, id, "history", null), /版本|计划/);
    for (const patch of [{ owner: "old" }, { revision: started.revision - 1 }, { binding: { ...binding, agentId: "other" } },
      { preparationPlan: { ...started.preparationPlan!, target: { reusable: false } } }]) {
      assert.throws(() => store.inbox.completePreparationStep({ ...started, ...patch }, id, "history", null), /版本|计划|绑定|归属/);
    }
    assert.throws(() => store.inbox.beginPreparationStep(started, "other-plan", descriptor("other")), /计划/);
    assert.throws(() => store.inbox.completePreparationStep(started, id, "missing", null), /步骤/);
  } finally { store.close(); }
});

test("uncertain plans are immutable until claimed and failed preparation preserves the plan", () => {
  const store = memory();
  try {
    const task = planned(store), interrupted = store.finishMessage(task.id, "failed");
    assert.deepEqual(interrupted.preparationPlan, task.preparationPlan);
    assert.throws(() => store.inbox.beginPreparationStep(interrupted, task.preparationPlan!.id, descriptor()), /状态|准备|计划/);
    const resumed = store.claimPreparingMessage(interrupted, binding);
    assert.throws(() => store.claimPreparingMessage(interrupted, binding), /版本|计划/);
    assert.deepEqual(resumed.preparationPlan, task.preparationPlan);
  } finally { store.close(); }
});

test("ready, dispatch and completion erase plan content and authorization continuation cannot start a fresh plan", () => {
  for (const transition of ["ready", "dispatch", "completed", "authorization"] as const) {
    const store = memory();
    try {
      const task = planned(store);
      const next = transition === "ready"
        ? store.inbox.prepare(task.id, { sessionId: "original-session", input: "ready", notices: [], contextReceipts: [] })
        : transition === "completed" ? store.finishMessage(task.id, "completed") : store.dispatchMessage(task.id, "original-session", hash("run"));
      assert.equal(next.preparationPlan, undefined);
      if (transition === "ready") assert.throws(() => store.inbox.beginPreparationPlan(next, target), /准备|计划/);
      if (transition === "authorization") {
        store.finishMessage(task.id, "awaiting_authorization");
        const resumed = store.inbox.transitionAuthorization(task.id, "preparing");
        assert.equal(resumed.preparationPlan, undefined);
        assert.throws(() => store.inbox.beginPreparationPlan(resumed, target), /派发|准备|计划/);
      }
    } finally { store.close(); }
  }
});

test("legacy unplanned interruptions, queued tasks and slash controls cannot acquire a preparation plan", () => {
  const store = memory();
  try {
    const initial = claim(store), interrupted = store.finishMessage(initial.id, "failed");
    assert.throws(() => store.claimPreparingMessage(interrupted, binding), /计划/);
    const queued = store.receiveMessage(message("queued"), binding)!;
    assert.throws(() => store.inbox.beginPreparationPlan(queued, target), /准备|归属|属于/);
    const controlMessage = { ...message("control"), text: "/compact" };
    const otherBinding = { ...binding, scope: "control" };
    const control = store.inbox.claim(store.receiveMessage(controlMessage, otherBinding)!.id, otherBinding)!;
    assert.throws(() => store.inbox.beginPreparationPlan(control, target), /准备|计划/);
  } finally { store.close(); }
});

for (const blocker of ["preparing", "dispatched", "uncertain", "awaiting_authorization", "earlier-queued"])
test(`plan claiming respects same-scope ${blocker} blockers`, () => {
  const store = memory();
  try {
    const task = planned(store), interrupted = store.finishMessage(task.id, "failed");
    const other = store.receiveMessage(message("other"), binding)!;
    rewrite(store, other.id, blocker === "earlier-queued" ? { sequence: 0 } : { state: blocker });
    assert.throws(() => store.claimPreparingMessage(interrupted, binding), /前序|计划|会话/);
    assert.equal(store.inbox.findTask(task.id)!.state, "uncertain");
  } finally { store.close(); }
});

for (const field of ["scope", "agentId", "configFingerprint"] as const)
test(`plan claiming rejects changed ${field}`, () => {
  const store = memory();
  try {
    const task = planned(store), interrupted = store.finishMessage(task.id, "failed");
    assert.throws(() => store.claimPreparingMessage(interrupted, { ...binding, [field]: "changed" }), /绑定|配置/);
  } finally { store.close(); }
});

test("claiming a plan is atomic with the processed event receipt", () => {
  const store = memory();
  try {
    const task = planned(store), interrupted = store.finishMessage(task.id, "failed");
    db(store).prepare("DELETE FROM processed_events").run();
    assert.throws(() => store.claimPreparingMessage(interrupted, binding), /接收记录/);
    assert.deepEqual(store.inbox.findTask(task.id), interrupted);
  } finally { store.close(); }
});

const cycle: any = {}; cycle.self = cycle;
const invalidOutputs: Array<[string, unknown]> = [["undefined", undefined], ["undefined field", { missing: undefined }],
  ["nonfinite", NaN], ["infinity", Infinity], ["bigint", 1n], ["function", () => null], ["symbol", Symbol("x")],
  ["date", new Date()], ["map", new Map()], ["cycle", cycle], ["sparse array", Array(2)], ["oversize", "x".repeat(2 * 1024 * 1024)],
  ["deeply nested", Array.from({ length: 34 }).reduce(value => ({ child: value }), {} as any)]];
for (const [name, output] of invalidOutputs) test(`preparation output rejects invalid ${name} without persisting`, () => {
  const store = memory();
  try {
    const task = planned(store), id = task.preparationPlan!.id;
    const started = store.inbox.beginPreparationStep(task, id, descriptor());
    assert.throws(() => store.inbox.completePreparationStep(started, id, "history", output as never), /准备|JSON|步骤/);
    assert.deepEqual(store.inbox.findTask(task.id), started);
  } finally { store.close(); }
});

for (const patch of [{ id: "" }, { id: "x".repeat(257) }, { id: "bad\nname" }, { kind: "unknown" }, { inputFingerprint: "bad" }, { unrecognized: true }])
test(`preparation step rejects invalid descriptor ${JSON.stringify(patch)}`, () => {
  const store = memory();
  try {
    const task = planned(store);
    assert.throws(() => store.inbox.beginPreparationStep(task, task.preparationPlan!.id, { ...descriptor(), ...patch } as never), /步骤/);
    assert.deepEqual(store.inbox.findTask(task.id), task);
  } finally { store.close(); }
});

for (const change of [
  (p: any) => { p.preparationPlan.version = 2; }, (p: any) => { p.preparationPlan.id = "invalid"; },
  (p: any) => { p.preparationPlan.createdAt = Date.now() + 60_000; }, (p: any) => { p.preparationPlan.target.extra = true; },
  (p: any) => { p.preparationPlan.steps.push({ ...descriptor(), state: "completed" }); },
  (p: any) => { p.preparationPlan.steps.push({ ...descriptor(), state: "pending", output: null }); },
  (p: any) => { p.preparationPlan.steps.push({ ...descriptor(), state: "pending" }, { ...descriptor(), state: "pending" }); },
  (p: any) => { p.version = 2; }, (p: any) => { p.preparation = { sessionId: "session", input: "ready", fingerprint: hash("ready"), notices: [], contextReceipts: [], preparedAt: Date.now() }; }
]) test("authenticated invalid preparation plan is rejected during decoding", () => {
  const store = memory();
  try {
    const task = planned(store);
    rewrite(store, task.id, {}, payload => { change(payload); return payload; });
    assert.throws(() => store.inbox.findTask(task.id), /结构损坏/);
  } finally { store.close(); }
});

test("version-two and legacy raw messages still decode but never gain a plan implicitly", () => {
  for (const version of [1, 2]) {
    const store = memory();
    try {
      const task = claim(store);
      rewrite(store, task.id, {}, payload => version === 1 ? payload.message : { ...payload, version: 2 });
      const restored = store.inbox.findTask(task.id)!;
      assert.equal(restored.preparationPlan, undefined);
      assert.equal(store.inbox.beginPreparationPlan(restored, target).preparationPlan!.version, 1);
    } finally { store.close(); }
  }
});

test("preparation plan APIs require the database runtime lock", () => {
  const store = new GatewayStore(":memory:");
  try {
    const expected = { id: "missing" } as InboxTask;
    assert.throws(() => store.inbox.beginPreparationPlan(expected, target), /运行锁/);
    assert.throws(() => store.inbox.beginPreparationStep(expected, "plan", descriptor()), /运行锁/);
    assert.throws(() => store.inbox.completePreparationStep(expected, "plan", "history", null), /运行锁/);
    assert.throws(() => store.inbox.claimPreparationPlan(expected, binding), /运行锁/);
  } finally { store.close(); }
});

test("independent scopes and later queued messages do not block plan recovery", () => {
  const store = memory();
  try {
    const first = planned(store), interrupted = store.finishMessage(first.id, "failed");
    const later = store.receiveMessage(message("later"), binding)!;
    const elsewhere = { ...binding, scope: "elsewhere" }, parallel = store.receiveMessage(message("parallel"), elsewhere)!;
    store.inbox.claim(parallel.id, elsewhere);
    assert.equal(store.claimPreparingMessage(interrupted, binding).state, "preparing");
    assert.equal(store.inbox.claim(later.id, binding), undefined);
  } finally { store.close(); }
});

test("plan limits count serialized UTF-8 output and aggregate bytes, not only character length", () => {
  const store = memory();
  try {
    const task = planned(store), started = store.inbox.beginPreparationStep(task, task.preparationPlan!.id, descriptor());
    const exact = "中".repeat(Math.floor((MAX_PREPARATION_OUTPUT_BYTES - 2) / 3));
    const completed = store.inbox.completePreparationStep(started, task.preparationPlan!.id, "history", exact);
    assert.equal(completed.preparationPlan!.steps[0].output, exact);
    const maximumSteps = createPreparationPlan({ reusable: false });
    maximumSteps.steps = Array.from({ length: MAX_PREPARATION_STEPS }, (_, index) => ({ ...descriptor(`s${index}`), state: "pending" }));
    assert.doesNotThrow(() => validatePreparationPlan(maximumSteps));
    maximumSteps.steps.push({ ...descriptor("overflow"), state: "pending" });
    assert.throws(() => validatePreparationPlan(maximumSteps), /准备/);
    const oversized = createPreparationPlan(target);
    oversized.steps = Array.from({ length: 5 }, (_, index) => ({ ...descriptor(`big${index}`), state: "completed", output: "x".repeat(MAX_PREPARATION_OUTPUT_BYTES - 2) }));
    assert.throws(() => validatePreparationPlan(oversized), /准备/);
  } finally { store.close(); }
});

test("preparation JSON validation never evaluates accessors or serializers", () => {
  const store = memory();
  try {
    const task = planned(store), id = task.preparationPlan!.id, started = store.inbox.beginPreparationStep(task, id, descriptor());
    let calls = 0;
    const accessor = { get privateValue() { calls++; return "PRIVATE"; } };
    const serializer = { toJSON() { calls++; return { safe: true }; } };
    for (const value of [accessor, serializer]) assert.throws(() => store.inbox.completePreparationStep(started, id, "history", value as never), /JSON/);
    assert.equal(calls, 0);
  } finally { store.close(); }
});

for (const metadata of [{ state: "queued" }, { state: "dispatched" }, { state: "uncertain", interrupted_at: "dispatched" },
  { session_id: "prior-session" }, { request_fingerprint: "prior-input" }])
test(`decoding refuses a plan attached to incompatible dispatch metadata ${JSON.stringify(metadata)}`, () => {
  const store = memory();
  try {
    const task = planned(store); rewrite(store, task.id, metadata);
    assert.throws(() => store.inbox.findTask(task.id), /结构损坏/);
  } finally { store.close(); }
});

for (const field of ["dispatchId", "replyIntent", "delivery", "replyInspection", "inspection", "resolution"])
test(`decoding refuses a plan with ${field} evidence`, () => {
  const store = memory();
  try {
    const task = planned(store);
    rewrite(store, task.id, {}, payload => ({ ...payload, [field]: "evidence" }));
    assert.throws(() => store.inbox.findTask(task.id), /结构损坏/);
  } finally { store.close(); }
});

test("one corrupted plan prevents partial recovery of the entire batch", () => {
  const store = memory();
  try {
    const first = planned(store);
    const otherBinding = { ...binding, scope: "other" }, queued = store.receiveMessage(message("other"), otherBinding)!;
    const second = store.inbox.beginPreparationPlan(store.inbox.claim(queued.id, otherBinding)!, target);
    rewrite(store, first.id, { owner: "previous-owner" });
    rewrite(store, second.id, {}, payload => { payload.preparationPlan.version = 999; return payload; });
    assert.throws(() => store.recoverMessages("lark", "app"), /结构损坏/);
    assert.equal(db(store).prepare("SELECT state FROM gateway_message_inbox WHERE id=?").get(first.id)!.state, "preparing");
    assert.equal(db(store).prepare("SELECT COUNT(*) AS count FROM processed_events WHERE status='uncertain'").get()!.count, 0);
  } finally { store.close(); }
});
