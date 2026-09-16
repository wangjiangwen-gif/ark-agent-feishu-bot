import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { GatewayStore } from "../src/store.ts";
import type { ChannelMessage } from "../src/channel.ts";

const message = (id = "m"): ChannelMessage => ({ channelType: "lark", installationId: "cli",
  tenantId: "tenant", senderId: "user", conversationId: "chat", conversationType: "direct", threadId: "",
  rootMessageId: "", parentMessageId: "quote", messageId: id, eventId: `event-${id}`, createTime: 100,
  text: "private-request", resources: [{ type: "file", id: "file", name: "a.pdf" }], mentionedBot: false });
const binding = { scope: "scope", agentId: "agent", configFingerprint: "config" };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ark-receive-")), path = join(dir, "gateway.db");
  const store = new GatewayStore(path); store.acquireRuntimeLock();
  const db = new DatabaseSync(path);
  return { path, store, db, close() { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("atomic receive persists both deduplication and the complete queued message", () => {
  const f = fixture();
  try {
    const task = f.store.receiveMessage(message(), binding)!;
    assert.equal(task.state, "queued");
    assert.deepEqual(f.store.inbox.recover("lark", "cli").queued[0].message, message());
    assert.equal(f.store.claimEvent("lark", "cli", "m"), false);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM processed_events").get()!.n, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM gateway_message_inbox").get()!.n, 1);
  } finally { f.close(); }
});

test("a delayed duplicate with a different event ID never reclaims or replaces queued work", () => {
  const f = fixture();
  try {
    const task = f.store.receiveMessage(message(), binding)!;
    f.db.exec("UPDATE processed_events SET updated_at='2000-01-01T00:00:00.000Z'");
    assert.equal(f.store.claimEvent("lark", "cli", "m"), false);
    assert.equal(f.store.receiveMessage({ ...message(), eventId: "redelivery", text: "replacement" }, binding), undefined);
    const pending = f.store.inbox.recover("lark", "cli").queued;
    assert.equal(pending.length, 1); assert.equal(pending[0].id, task.id);
    assert.equal(pending[0].message.text, "private-request");
    assert.equal(f.db.prepare("SELECT attempts FROM processed_events").get()!.attempts, 1);
  } finally { f.close(); }
});

test("duplicate message identity changes are rejected even though the event was already claimed", () => {
  const f = fixture();
  try {
    f.store.receiveMessage(message(), binding);
    for (const change of [{ tenantId: "other" }, { senderId: "other" }, { conversationId: "other" }, { threadId: "other" }]) {
      assert.throws(() => f.store.receiveMessage({ ...message(), ...change }, binding), /身份或会话/);
    }
    assert.equal(f.store.inbox.recover("lark", "cli").queued.length, 1);
  } finally { f.close(); }
});

test("invalid input rolls back event deduplication so a valid delivery can still be received", () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.receiveMessage({ ...message(), tenantId: "" }, binding), /身份/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM processed_events").get()!.n, 0);
    assert.ok(f.store.receiveMessage(message(), binding));
  } finally { f.close(); }
});

test("inbox persistence failure rolls back the event claim", () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TRIGGER fail_inbox BEFORE INSERT ON gateway_message_inbox BEGIN SELECT RAISE(ABORT, 'injected'); END");
    assert.throws(() => f.store.receiveMessage(message(), binding), /injected/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM processed_events").get()!.n, 0);
    f.db.exec("DROP TRIGGER fail_inbox");
    assert.ok(f.store.receiveMessage(message(), binding));
  } finally { f.close(); }
});

test("legacy completed, failed, stale or uncertain events are never silently migrated into replayable tasks", () => {
  const f = fixture();
  try {
    for (const status of ["completed", "failed", "processing", "uncertain"]) {
      f.store.claimEvent("lark", "cli", status);
      f.db.prepare("UPDATE processed_events SET status=?, updated_at='2000-01-01T00:00:00.000Z' WHERE event_id=?")
        .run(status, f.store.eventKey("lark", "cli", status));
      assert.equal(f.store.receiveMessage(message(status), binding), undefined);
    }
    f.db.prepare("INSERT INTO processed_events(event_id,status,updated_at) VALUES ('legacy','failed','2000-01-01')").run();
    assert.equal(f.store.receiveMessage(message("legacy"), binding), undefined);
    assert.deepEqual(f.store.inbox.recover("lark", "cli").queued, []);
  } finally { f.close(); }
});

test("atomic receive requires the runtime lock and isolates installations", () => {
  const store = new GatewayStore(":memory:");
  try {
    assert.throws(() => store.receiveMessage(message(), binding), /运行锁/);
    store.acquireRuntimeLock();
    assert.ok(store.receiveMessage(message(), binding));
    assert.ok(store.receiveMessage({ ...message(), installationId: "other" }, binding));
    assert.equal(store.inbox.recover("lark", "other").queued.length, 1);
  } finally { store.close(); }
});

test("dispatch and terminal event checkpoints commit with inbox transitions", () => {
  const f = fixture();
  try {
    const task = f.store.receiveMessage(message(), binding)!; f.store.inbox.claim(task.id, binding);
    f.store.dispatchMessage(task.id, "session", "hash");
    assert.equal(f.db.prepare("SELECT dispatched FROM processed_events").get()!.dispatched, 1);
    f.store.finishMessage(task.id, "completed");
    assert.equal(f.db.prepare("SELECT status FROM processed_events").get()!.status, "completed");
    assert.deepEqual(f.store.inbox.recover("lark", "cli").queued, []);
    assert.equal(f.store.receiveMessage(message(), binding), undefined);
    assert.throws(() => f.store.finishMessage(task.id, "completed"), /状态/);
  } finally { f.close(); }
});

test("failed preparation and authorization waiting have matching durable event states", () => {
  const f = fixture();
  try {
    for (const outcome of ["failed", "awaiting_authorization"] as const) {
      const task = f.store.receiveMessage(message(outcome), { ...binding, scope: outcome })!;
      f.store.inbox.claim(task.id, { ...binding, scope: outcome });
      if (outcome === "awaiting_authorization") f.store.dispatchMessage(task.id, "session", "hash");
      f.store.finishMessage(task.id, outcome);
      const expected = outcome === "failed" ? "uncertain" : outcome;
      assert.equal(f.db.prepare("SELECT status FROM processed_events WHERE event_id=?").get(f.store.eventKey("lark", "cli", outcome))!.status, expected);
      assert.equal(f.db.prepare("SELECT state FROM gateway_message_inbox WHERE id=?").get(task.id)!.state, expected);
    }
  } finally { f.close(); }
});

test("event checkpoint failure rolls back dispatch and completion instead of splitting the journals", () => {
  const f = fixture();
  try {
    const task = f.store.receiveMessage(message(), binding)!; f.store.inbox.claim(task.id, binding);
    f.db.exec("CREATE TRIGGER fail_event BEFORE UPDATE ON processed_events BEGIN SELECT RAISE(ABORT, 'event-injected'); END");
    assert.throws(() => f.store.dispatchMessage(task.id, "session", "hash"), /event-injected/);
    assert.equal(f.db.prepare("SELECT state FROM gateway_message_inbox").get()!.state, "preparing");
    assert.throws(() => f.store.finishMessage(task.id, "completed"), /event-injected/);
    assert.equal(f.db.prepare("SELECT state FROM gateway_message_inbox").get()!.state, "preparing");
    f.db.exec("DROP TRIGGER fail_event");
    f.store.dispatchMessage(task.id, "session", "hash"); f.store.finishMessage(task.id, "completed");
  } finally { f.close(); }
});

test("missing event checkpoint prevents dispatch and duplicate receipt from hiding inconsistent data", () => {
  const f = fixture();
  try {
    const task = f.store.receiveMessage(message(), binding)!; f.store.inbox.claim(task.id, binding);
    f.db.exec("DELETE FROM processed_events");
    assert.throws(() => f.store.dispatchMessage(task.id, "session", "hash"), /接收记录/);
    assert.equal(f.db.prepare("SELECT state FROM gateway_message_inbox").get()!.state, "preparing");
    assert.throws(() => f.store.receiveMessage(message(), binding), /接收记录/);
  } finally { f.close(); }
});

test("actual process exit before the receive transaction commits leaves neither journal half-written", () => {
  const f = fixture(); f.store.close();
  try {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
      const store = new GatewayStore(${JSON.stringify(f.path)}); store.acquireRuntimeLock();
      const enqueue = store.inbox.enqueue.bind(store.inbox);
      store.inbox.enqueue = (...args) => { enqueue(...args); process.exit(17); };
      store.receiveMessage(${JSON.stringify(message())}, ${JSON.stringify(binding)});
    `], { encoding: "utf8" });
    assert.equal(child.status, 17, child.stderr);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM processed_events").get()!.n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM gateway_message_inbox").get()!.n, 0);
    const recovered = new GatewayStore(f.path);
    try { recovered.acquireRuntimeLock(); assert.ok(recovered.receiveMessage(message(), binding)); }
    finally { recovered.close(); }
  } finally { f.close(); }
});

test("committed acceptance survives an actual process exit with deduplication and original ordering intact", () => {
  const f = fixture(); f.store.close();
  try {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
      const store = new GatewayStore(${JSON.stringify(f.path)}); store.acquireRuntimeLock();
      store.receiveMessage(${JSON.stringify(message("first"))}, ${JSON.stringify(binding)});
      store.receiveMessage(${JSON.stringify(message("second"))}, ${JSON.stringify(binding)});
      process.exit(0);
    `], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const recovered = new GatewayStore(f.path);
    try {
      recovered.acquireRuntimeLock();
      const tasks = recovered.inbox.recover("lark", "cli").queued;
      assert.deepEqual(tasks.map(task => task.message.messageId), ["first", "second"]);
      assert.equal(recovered.receiveMessage(message("first"), binding), undefined);
      assert.equal(recovered.inbox.claim(tasks[1].id, binding), undefined);
      assert.ok(recovered.inbox.claim(tasks[0].id, binding));
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM processed_events").get()!.n, 2);
    } finally { recovered.close(); }
  } finally { f.close(); }
});

test("restart recovery atomically records uncertain dispatched work in both journals", () => {
  const f = fixture();
  try {
    const task = f.store.receiveMessage(message(), binding)!;
    f.store.inbox.claim(task.id, binding); f.store.dispatchMessage(task.id, "original-session", "hash");
    f.store.receiveMessage(message("later"), binding); f.store.close();
    const restarted = new GatewayStore(f.path);
    try {
      restarted.acquireRuntimeLock(); const recovered = restarted.recoverMessages("lark", "cli");
      assert.equal(recovered.interrupted[0].sessionId, "original-session");
      assert.equal(f.db.prepare("SELECT status FROM processed_events WHERE event_id=?").get(restarted.eventKey("lark", "cli", "m"))!.status, "uncertain");
      assert.equal(restarted.inbox.claim(recovered.queued[0].id, binding), undefined);
      assert.deepEqual(restarted.recoverMessages("lark", "cli"), recovered);
    } finally { restarted.close(); }
  } finally { f.close(); }
});

test("inconsistent queued event prevents partial restart recovery and rolls back earlier transitions", () => {
  const f = fixture();
  try {
    const task = f.store.receiveMessage(message(), binding)!; f.store.inbox.claim(task.id, binding);
    f.store.receiveMessage(message("later"), binding); f.store.close();
    f.db.prepare("DELETE FROM processed_events WHERE event_id=?").run(f.store.eventKey("lark", "cli", "later"));
    const restarted = new GatewayStore(f.path);
    try {
      restarted.acquireRuntimeLock(); assert.throws(() => restarted.recoverMessages("lark", "cli"), /接收记录/);
      assert.equal(f.db.prepare("SELECT state FROM gateway_message_inbox WHERE id=?").get(task.id)!.state, "preparing");
      assert.equal(f.db.prepare("SELECT status FROM processed_events").get()!.status, "processing");
    } finally { restarted.close(); }
  } finally { f.close(); }
});

test("recovery preserves authorization waiting and never reads another installation's corrupted records", () => {
  const f = fixture();
  try {
    const task = f.store.receiveMessage(message(), binding)!; f.store.inbox.claim(task.id, binding);
    f.store.dispatchMessage(task.id, "session", "hash"); f.store.finishMessage(task.id, "awaiting_authorization");
    f.store.receiveMessage({ ...message(), installationId: "other" }, binding);
    f.db.exec("UPDATE processed_events SET status='completed' WHERE event_id='lark:other:m'");
    const recovered = f.store.recoverMessages("lark", "cli");
    assert.equal(recovered.awaitingAuthorization.length, 1);
    assert.deepEqual(recovered.interrupted, []);
    assert.throws(() => f.store.recoverMessages("lark", "other"), /接收记录/);
  } finally { f.close(); }
});

test("authorization continuation and cancellation cannot split inbox and event checkpoints on storage failure", () => {
  const f = fixture();
  try {
    const incoming = message(), task = f.store.receiveMessage(incoming, binding)!;
    f.store.inbox.claim(task.id, binding); f.store.dispatchMessage(task.id, "session", "hash");
    f.store.startAuthorizationRecovery(incoming, "session"); f.store.finishMessage(task.id, "awaiting_authorization");
    f.store.claimAuthorizationRecovery(incoming);
    f.db.exec("CREATE TRIGGER fail_event BEFORE UPDATE ON processed_events BEGIN SELECT RAISE(ABORT, 'event-injected'); END");
    assert.throws(() => f.store.resumeAuthorizationMessage(incoming), /event-injected/);
    assert.equal(f.store.inbox.findMessage(incoming)!.state, "awaiting_authorization");
    f.store.finishAuthorizationRecovery(incoming, "cancelled");
    assert.throws(() => f.store.settleAuthorizationMessage(incoming), /event-injected/);
    assert.equal(f.store.inbox.findMessage(incoming)!.state, "awaiting_authorization");
    f.db.exec("DROP TRIGGER fail_event");
    assert.equal(f.store.settleAuthorizationMessage(incoming), true);
    assert.equal(f.store.inbox.findMessage(incoming)!.state, "failed");
  } finally { f.close(); }
});

test("authorization transition requires matching original Session and claimed recovery, never just an OAuth callback", () => {
  const f = fixture();
  try {
    const incoming = message(), task = f.store.receiveMessage(incoming, binding)!;
    f.store.inbox.claim(task.id, binding); f.store.dispatchMessage(task.id, "session", "hash");
    f.store.finishMessage(task.id, "awaiting_authorization");
    assert.throws(() => f.store.resumeAuthorizationMessage(incoming), /绑定/);
    assert.equal(f.store.settleAuthorizationMessage(incoming), false);
    f.store.startAuthorizationRecovery(incoming, "wrong-session"); f.store.claimAuthorizationRecovery(incoming);
    assert.throws(() => f.store.resumeAuthorizationMessage(incoming), /绑定/);
    assert.throws(() => f.store.resumeAuthorizationMessage({ ...incoming, senderId: "other" }), /身份/);
    assert.equal(f.store.inbox.findMessage(incoming)!.state, "awaiting_authorization");
  } finally { f.close(); }
});
