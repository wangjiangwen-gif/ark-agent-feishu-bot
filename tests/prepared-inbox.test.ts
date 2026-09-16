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

const message = (id: string): ChannelMessage => ({ channelType: "lark", installationId: "app", tenantId: "tenant",
  senderId: "user", conversationId: "chat", conversationType: "group", threadId: "", rootMessageId: "", parentMessageId: "",
  messageId: id, eventId: id, createTime: 100, text: "请比较文件", resources: [], mentionedBot: true });
const binding = { scope: "chat:group", agentId: "agent", configFingerprint: "config" };
const prepared = () => ({ sessionId: "session-original", input: "完整原文 PRIVATE_PREPARED_INPUT 中文",
  notices: ["附件未完整读取"], contextReceipts: [{ id: "history-original", fingerprint: "history-fingerprint:partial" }] });
const hash = (input: string) => createHash("sha256").update(input).digest("hex");
function memory() { const store = new GatewayStore(":memory:"); store.acquireRuntimeLock(); return store; }
function claim(store: GatewayStore, id = "first"): InboxTask {
  const task = store.inbox.enqueue(message(id), binding)!;
  return store.inbox.claim(task.id, binding)!;
}
function ready(store: GatewayStore, id = "first"): InboxTask {
  return store.inbox.prepare(claim(store, id).id, prepared());
}
function interrupted(store: GatewayStore, id = "first"): InboxTask {
  return store.inbox.finish(ready(store, id).id, "failed");
}

// 有意构造经过正常密封的坏记录，验证解码层而非仅测试密文认证失败。
function rewrite(store: GatewayStore, id: string, fields: Record<string, unknown>, change: (payload: any) => void = () => {}): void {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const original = db.prepare("SELECT * FROM gateway_message_inbox WHERE id=?").get(id)!;
  const context = (row: Record<string, unknown>) => JSON.stringify(["message-inbox", row.sequence, row.id, row.event_key,
    row.channel_type, row.installation_id, row.scope, row.agent_id, row.config_fingerprint, row.state, row.owner, row.revision,
    row.session_id, row.request_fingerprint, row.interrupted_at]);
  const payload = JSON.parse(store.credentials.openAuthorization(String(original.secret), context(original)));
  change(payload);
  const row = { ...original, ...fields };
  const secret = store.credentials.sealAuthorization(JSON.stringify(payload), context(row));
  for (const [column, value] of Object.entries(fields)) {
    assert.ok(["state", "session_id", "request_fingerprint", "interrupted_at", "owner", "sequence"].includes(column));
    db.prepare(`UPDATE gateway_message_inbox SET ${column}=? WHERE id=?`).run(value as string | number | null, id);
  }
  db.prepare("UPDATE gateway_message_inbox SET secret=? WHERE id=?").run(secret, id);
}

test("prepared input is encrypted, survives reopening, and does not imply model dispatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-prepared-inbox-")), path = join(dir, "gateway.db");
  let store = new GatewayStore(path);
  try {
    store.acquireRuntimeLock();
    const checkpoint = ready(store), source = prepared();
    assert.equal(checkpoint.preparation!.fingerprint, hash(source.input));
    assert.equal(checkpoint.sessionId, undefined); assert.equal(checkpoint.requestFingerprint, undefined);
    assert.equal(checkpoint.dispatchId, undefined);
    store.close(); store = new GatewayStore(path); store.acquireRuntimeLock();
    const restored = store.inbox.recover("lark", "app").interrupted[0];
    assert.deepEqual(restored.preparation, checkpoint.preparation);
    assert.equal(restored.interruptedAt, "preparing");
    assert.equal(readFileSync(path).includes(Buffer.from("PRIVATE_PREPARED_INPUT")), false);
    assert.equal(readFileSync(path).includes(Buffer.from("history-original")), false);
    const claimed = store.inbox.claimPreparation(restored, binding);
    assert.equal(claimed.state, "preparing"); assert.equal(claimed.interruptedAt, undefined);
    assert.equal(claimed.sessionId, undefined); assert.notEqual(claimed.owner, restored.owner);
    assert.deepEqual(claimed.preparation, checkpoint.preparation);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("identical prepare is immutable and idempotent without updating revision or time", () => {
  const store = memory();
  try {
    const task = claim(store), source = prepared();
    const first = store.inbox.prepare(task.id, source), second = store.inbox.prepare(task.id, prepared());
    assert.deepEqual(second, first);
    source.notices.push("changed"); source.contextReceipts[0].id = "changed";
    first.preparation!.input = "changed";
    assert.deepEqual(store.inbox.findTask(task.id)!.preparation, second.preparation);
  } finally { store.close(); }
});

for (const changed of [{ sessionId: "replacement" }, { input: "replacement" }, { notices: [] }, { contextReceipts: [] }])
test(`prepare rejects changing an existing ${Object.keys(changed)[0]}`, () => {
  const store = memory();
  try {
    const task = ready(store);
    assert.throws(() => store.inbox.prepare(task.id, { ...prepared(), ...changed }), /准备/);
    assert.deepEqual(store.inbox.findTask(task.id), task);
  } finally { store.close(); }
});

test("prepared dispatch requires exactly the bound Session and input fingerprint, then erases the input", () => {
  const store = memory();
  try {
    const task = ready(store);
    assert.throws(() => store.inbox.dispatched(task.id, "other", task.preparation!.fingerprint), /准备/);
    assert.throws(() => store.inbox.dispatched(task.id, task.preparation!.sessionId, "other"), /准备/);
    const sent = store.inbox.dispatched(task.id, task.preparation!.sessionId, task.preparation!.fingerprint);
    assert.equal(sent.preparation, undefined); assert.ok(sent.dispatchId);
    assert.equal(store.inbox.findTask(task.id)!.preparation, undefined);
    const failed = store.inbox.finish(task.id, "failed");
    assert.throws(() => store.inbox.claimPreparation(failed, binding), /准备/);
  } finally { store.close(); }
});

test("claim preparation rejects stale revisions, modified expected checkpoint, and repeat claims", () => {
  const store = memory();
  try {
    const task = interrupted(store);
    assert.throws(() => store.inbox.claimPreparation({ ...task, revision: task.revision - 1 }, binding), /版本|准备/);
    assert.throws(() => store.inbox.claimPreparation({ ...task, preparation: { ...task.preparation!, input: "changed" } }, binding), /准备/);
    const resumed = store.inbox.claimPreparation(task, binding);
    assert.equal(resumed.revision, task.revision + 1);
    assert.throws(() => store.inbox.claimPreparation(task, binding), /版本|准备/);
  } finally { store.close(); }
});

for (const field of ["scope", "agentId", "configFingerprint"] as const)
test(`claim preparation rejects changed ${field} in both expected binding sources`, () => {
  const store = memory();
  try {
    const task = interrupted(store);
    assert.throws(() => store.inbox.claimPreparation(task, { ...binding, [field]: "other" }), /配置|绑定/);
    assert.throws(() => store.inbox.claimPreparation({ ...task, binding: { ...binding, [field]: "other" } }, binding), /版本|绑定/);
  } finally { store.close(); }
});

test("prepare requires preparing owned work and rejects slash controls and previous OAuth dispatches", () => {
  const store = memory();
  try {
    const queued = store.inbox.enqueue(message("queued"), binding)!;
    assert.throws(() => store.inbox.prepare(queued.id, prepared()), /状态/);
    store.inbox.claim(queued.id, binding);
    store.inbox.dispatched(queued.id, "session", "prior-hash");
    store.inbox.finish(queued.id, "awaiting_authorization");
    const resumed = store.inbox.transitionAuthorization(queued.id, "preparing");
    assert.equal(resumed.preparation, undefined);
    assert.throws(() => store.inbox.prepare(queued.id, prepared()), /准备/);
    store.inbox.finish(queued.id, "completed");
    assert.throws(() => store.inbox.prepare(queued.id, prepared()), /准备|状态/);
    for (const text of ["/new", " /Compact ", "/custom argument"]) {
      const task = store.inbox.enqueue({ ...message(text), text }, binding)!;
      store.inbox.claim(task.id, binding);
      assert.throws(() => store.inbox.prepare(task.id, prepared()), /命令|准备/);
      store.inbox.finish(task.id, "completed");
    }
  } finally { store.close(); }
});

test("an unprepared interruption cannot be reclaimed and an old owner cannot prepare", () => {
  const store = memory();
  try {
    const task = claim(store);
    const unknown = store.inbox.finish(task.id, "failed");
    assert.throws(() => store.inbox.claimPreparation(unknown, binding), /准备/);
    rewrite(store, task.id, { state: "preparing", owner: "old-owner", interrupted_at: null });
    assert.throws(() => store.inbox.prepare(task.id, prepared()), /属于/);
  } finally { store.close(); }
});

for (const state of ["preparing", "dispatched", "uncertain", "awaiting_authorization", "earlier-queued"])
test(`preparation recovery respects same-scope ${state} blocker`, () => {
  const store = memory();
  try {
    const task = interrupted(store), other = store.inbox.enqueue(message("blocker"), binding)!;
    rewrite(store, other.id, state === "earlier-queued" ? { sequence: 0 } : { state });
    assert.throws(() => store.inbox.claimPreparation(task, binding), /前序|准备|会话/);
    assert.equal(store.inbox.findTask(task.id)!.state, "uncertain");
  } finally { store.close(); }
});

test("later queued messages and independent scope blockers do not prevent reclaim, but followers stay blocked", () => {
  const store = memory();
  try {
    const task = interrupted(store), later = store.inbox.enqueue(message("later"), binding)!;
    const elsewhere = { ...binding, scope: "other-scope" };
    const parallel = store.inbox.enqueue(message("parallel"), elsewhere)!; store.inbox.claim(parallel.id, elsewhere);
    const resumed = store.inbox.claimPreparation(task, binding);
    assert.equal(resumed.state, "preparing");
    assert.equal(store.inbox.claim(later.id, binding), undefined);
  } finally { store.close(); }
});

const invalidInputs: Array<[string, Record<string, unknown>]> = [
  ["input bytes", { input: "中".repeat(700_000) }], ["nontext input", { input: null }],
  ["empty session", { sessionId: "" }], ["oversize session", { sessionId: "x".repeat(257) }],
  ["whitespace session", { sessionId: "session\nother" }], ["missing notices", { notices: undefined }],
  ["many notices", { notices: Array(129).fill("notice") }], ["oversize notice", { notices: ["n".repeat(4097)] }],
  ["nontext notice", { notices: [1] }], ["many receipts", { contextReceipts: Array(129).fill({ id: "i", fingerprint: "f" }) }],
  ["sparse notices", { notices: Array(1) }], ["sparse receipts", { contextReceipts: Array(1) }],
  ["missing receipts", { contextReceipts: undefined }], ["empty receipt id", { contextReceipts: [{ id: "", fingerprint: "f" }] }],
  ["oversize receipt id", { contextReceipts: [{ id: "i".repeat(513), fingerprint: "f" }] }],
  ["empty receipt fingerprint", { contextReceipts: [{ id: "i", fingerprint: "" }] }],
  ["oversize receipt fingerprint", { contextReceipts: [{ id: "i", fingerprint: "f".repeat(257) }] }],
  ["duplicate receipt", { contextReceipts: [{ id: "i", fingerprint: "f" }, { id: "i", fingerprint: "g" }] }],
  ["unknown preparation field", { unrecognized: "sensitive" }],
  ["unknown receipt field", { contextReceipts: [{ id: "i", fingerprint: "f", token: "sensitive" }] }]
];
for (const [name, value] of invalidInputs) test(`prepare rejects invalid ${name} without persisting`, () => {
  const store = memory();
  try {
    const task = claim(store);
    assert.throws(() => store.inbox.prepare(task.id, { ...prepared(), ...value } as any), /准备/);
    assert.equal(store.inbox.findTask(task.id)!.preparation, undefined);
  } finally { store.close(); }
});

test("exact UTF-8 input size limit and legitimate partial receipts are accepted", () => {
  const store = memory();
  try {
    const task = claim(store), input = "中".repeat(699_050) + "xx";
    assert.equal(Buffer.byteLength(input), 2 * 1024 * 1024);
    const saved = store.inbox.prepare(task.id, { ...prepared(), input });
    assert.equal(saved.preparation!.fingerprint, hash(input));
  } finally { store.close(); }
});

for (const [name, change] of [
  ["incorrect hash", (p: any) => { p.preparation.fingerprint = "0".repeat(64); }],
  ["invalid hash", (p: any) => { p.preparation.fingerprint = "invalid"; }],
  ["future time", (p: any) => { p.preparation.preparedAt = Date.now() + 60_000; }],
  ["zero time", (p: any) => { p.preparation.preparedAt = 0; }],
  ["unsafe time", (p: any) => { p.preparation.preparedAt = Number.MAX_SAFE_INTEGER + 1; }],
  ["null preparation", (p: any) => { p.preparation = null; }],
  ["dispatch evidence", (p: any) => { p.dispatchId = "11111111-1111-1111-1111-111111111111"; }]
] as const) test(`decoding rejects authenticated but invalid prepared checkpoint: ${name}`, () => {
  const store = memory();
  try {
    const task = ready(store); rewrite(store, task.id, {}, change);
    assert.throws(() => store.inbox.findTask(task.id), /结构损坏/);
  } finally { store.close(); }
});

for (const fields of [{ session_id: "old-session" }, { request_fingerprint: "prior-hash" },
  { state: "dispatched" }, { state: "queued" }, { state: "uncertain", interrupted_at: "dispatched" },
  { state: "preparing", interrupted_at: "dispatched" }])
test(`decoding rejects preparation with incompatible task metadata ${JSON.stringify(fields)}`, () => {
  const store = memory();
  try {
    const task = ready(store); rewrite(store, task.id, fields);
    assert.throws(() => store.inbox.findTask(task.id), /结构损坏/);
  } finally { store.close(); }
});

test("legacy version-two messages without preparation still decode", () => {
  const store = memory();
  try {
    const task = claim(store);
    assert.equal(store.inbox.findTask(task.id)!.preparation, undefined);
    assert.equal(store.inbox.dispatched(task.id, "old-session", "legacy-hash").sessionId, "old-session");
  } finally { store.close(); }
});

test("prepare and claim preparation require the runtime lock", () => {
  const store = new GatewayStore(":memory:");
  try {
    assert.throws(() => store.inbox.prepare("missing", prepared()), /运行锁/);
    assert.throws(() => store.inbox.claimPreparation({ id: "missing" } as InboxTask, binding), /运行锁/);
  } finally { store.close(); }
});

test("terminal non-dispatched completion cannot retain reusable preparation", () => {
  const store = memory();
  try {
    const task = ready(store);
    const completed = store.inbox.finish(task.id, "completed");
    assert.equal(completed.preparation, undefined);
    assert.equal(store.inbox.findTask(task.id)!.state, "completed");
  } finally { store.close(); }
});
