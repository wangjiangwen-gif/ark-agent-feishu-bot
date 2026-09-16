import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { GatewayStore } from "../src/store.ts";
import type { ChannelMessage } from "../src/channel.ts";

const message = (id: string, installationId = "cli"): ChannelMessage => ({ channelType: "lark", installationId,
  tenantId: "tenant", senderId: "user", conversationId: "chat", conversationType: "direct", threadId: "",
  rootMessageId: "", parentMessageId: "quoted", messageId: id, eventId: `event-${id}`, createTime: 100,
  text: `private-message-secret-${id}`, resources: [{ type: "file", id: "file-secret", name: "secret.pdf" }], mentionedBot: false });
const binding = { scope: "scope-a", agentId: "agent-a", configFingerprint: "fingerprint-a" };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ark-inbox-")), path = join(dir, "gateway.db");
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("inbox encrypts original input and preserves arrival order, attachments and binding after reopen", () => {
  const files = fixture(); let store = new GatewayStore(files.path);
  try {
    store.acquireRuntimeLock();
    const first = { ...message("first"), createTime: 200 }, second = message("second");
    store.inbox.enqueue(first, binding); store.inbox.enqueue(second, binding);
    store.close(); store = new GatewayStore(files.path); store.acquireRuntimeLock();
    const recovered = store.inbox.recover("lark", "cli");
    assert.deepEqual(recovered.queued.map(task => task.message), [first, second]);
    assert.deepEqual(recovered.queued[0].binding, binding);
    assert.deepEqual(recovered.interrupted, []);
    assert.equal(readFileSync(files.path).includes(Buffer.from("private-message-secret")), false);
    assert.equal(readFileSync(files.path).includes(Buffer.from("file-secret")), false);
  } finally { store.close(); files.cleanup(); }
});

test("inbox enqueue and claim require the database runtime lock", () => {
  const store = new GatewayStore(":memory:");
  try {
    assert.throws(() => store.inbox.enqueue(message("m"), binding), /运行锁/);
    assert.throws(() => store.inbox.recover("lark", "cli"), /运行锁/);
  } finally { store.close(); }
});

test("inbox deduplicates business message ID but not messages from different installations", () => {
  const store = new GatewayStore(":memory:");
  try {
    store.acquireRuntimeLock();
    const task = store.inbox.enqueue(message("m"), binding)!;
    assert.equal(store.inbox.enqueue({ ...message("m"), eventId: "retry" }, binding), undefined);
    assert.ok(store.inbox.enqueue(message("m", "other-cli"), binding));
    assert.ok(store.inbox.claim(task.id, binding)); assert.equal(store.inbox.claim(task.id, binding), undefined);
    assert.equal(store.inbox.recover("lark", "other-cli").queued.length, 1);
  } finally { store.close(); }
});

test("started work is never classified as safe queued work after restart, even before MA dispatch", () => {
  const files = fixture(); let store = new GatewayStore(files.path);
  try {
    store.acquireRuntimeLock();
    const task = store.inbox.enqueue(message("started"), binding)!;
    store.inbox.claim(task.id, binding); store.inbox.enqueue(message("later"), binding);
    assert.equal(store.inbox.recover("lark", "cli").interrupted.length, 0);
    store.close(); store = new GatewayStore(files.path); store.acquireRuntimeLock();
    const recovered = store.inbox.recover("lark", "cli");
    assert.equal(recovered.interrupted[0].id, task.id);
    assert.equal(recovered.interrupted[0].state, "uncertain");
    assert.equal(recovered.interrupted[0].interruptedAt, "preparing");
    assert.deepEqual(recovered.queued.map(item => item.message.messageId), ["later"]);
    assert.equal(store.inbox.claim(recovered.queued[0].id, binding), undefined);
    assert.equal(store.inbox.claim(task.id, binding), undefined);
  } finally { store.close(); files.cleanup(); }
});

test("dispatch evidence and unknown outcomes persist without replay, while terminal tasks are not recovered", () => {
  const files = fixture(); let store = new GatewayStore(files.path);
  try {
    store.acquireRuntimeLock();
    const unknown = store.inbox.enqueue(message("unknown"), binding)!;
    store.inbox.claim(unknown.id, binding); store.inbox.dispatched(unknown.id, "session-original", "input-sha256");
    const otherScope = { ...binding, scope: "another-scope" };
    const done = store.inbox.enqueue(message("done"), otherScope)!;
    store.inbox.claim(done.id, otherScope); store.inbox.finish(done.id, "completed");
    store.close(); store = new GatewayStore(files.path); store.acquireRuntimeLock();
    const recovered = store.inbox.recover("lark", "cli");
    assert.deepEqual(recovered.queued, []);
    assert.equal(recovered.interrupted.length, 1);
    assert.equal(recovered.interrupted[0].sessionId, "session-original");
    assert.equal(recovered.interrupted[0].requestFingerprint, "input-sha256");
    assert.equal(recovered.interrupted[0].interruptedAt, "dispatched");
    assert.equal(store.inbox.enqueue(message("done"), binding), undefined);
  } finally { store.close(); files.cleanup(); }
});

test("failures after preparation or dispatch require inspection and cannot be blindly retried", () => {
  const store = new GatewayStore(":memory:");
  try {
    store.acquireRuntimeLock();
    for (const dispatched of [false, true]) {
      const independent = { ...binding, scope: String(dispatched) };
      const task = store.inbox.enqueue(message(String(dispatched)), independent)!;
      store.inbox.claim(task.id, independent);
      if (dispatched) store.inbox.dispatched(task.id, "session", "hash");
      const result = store.inbox.finish(task.id, "failed");
      assert.equal(result.state, "uncertain");
      assert.equal(result.interruptedAt, dispatched ? "dispatched" : "preparing");
      assert.equal(store.inbox.claim(task.id, binding), undefined);
    }
  } finally { store.close(); }
});

test("claim enforces durable per-scope FIFO and permits independent scopes", () => {
  const store = new GatewayStore(":memory:");
  try {
    store.acquireRuntimeLock();
    const first = store.inbox.enqueue(message("first"), binding)!;
    const second = store.inbox.enqueue(message("second"), binding)!;
    assert.equal(store.inbox.claim(second.id, binding), undefined);
    assert.ok(store.inbox.claim(first.id, binding));
    assert.equal(store.inbox.claim(second.id, binding), undefined);
    const independent = { ...binding, scope: "parallel" };
    const other = store.inbox.enqueue(message("other"), independent)!;
    assert.ok(store.inbox.claim(other.id, independent));
    store.inbox.finish(first.id, "completed");
    assert.ok(store.inbox.claim(second.id, binding));
  } finally { store.close(); }
});

test("queued task cannot be claimed under a different Agent, configuration or identity scope", () => {
  const store = new GatewayStore(":memory:");
  try {
    store.acquireRuntimeLock();
    const task = store.inbox.enqueue(message("m"), binding)!;
    for (const changed of [{ scope: "other" }, { agentId: "other" }, { configFingerprint: "other" }]) {
      assert.throws(() => store.inbox.claim(task.id, { ...binding, ...changed }), /配置已变化/);
    }
    assert.equal(store.inbox.recover("lark", "cli").queued.length, 1);
    assert.ok(store.inbox.claim(task.id, binding));
  } finally { store.close(); }
});

test("recovery filters Channel and installation and rejects duplicate identity changes", () => {
  const store = new GatewayStore(":memory:");
  try {
    store.acquireRuntimeLock();
    store.inbox.enqueue(message("m"), binding);
    store.inbox.enqueue({ ...message("m"), channelType: "another-channel" }, binding);
    const recovered = store.inbox.recover("another-channel", "cli");
    assert.equal(recovered.queued.length, 1);
    assert.equal(recovered.queued[0].message.channelType, "another-channel");
    for (const changed of [{ senderId: "other" }, { tenantId: "other" }, { conversationId: "other" }, { threadId: "other" }]) {
      assert.throws(() => store.inbox.enqueue({ ...message("m"), ...changed }, binding), /身份或会话/);
    }
  } finally { store.close(); }
});

test("message and configuration are snapshotted at acceptance, not shared mutable objects", () => {
  const store = new GatewayStore(":memory:");
  try {
    store.acquireRuntimeLock();
    const incoming = message("m"), config = { ...binding };
    const task = store.inbox.enqueue(incoming, config)!;
    incoming.resources[0].id = "changed"; config.agentId = "changed";
    task.message.text = "changed"; task.binding.scope = "changed";
    const queued = store.inbox.recover("lark", "cli").queued[0];
    assert.deepEqual(queued.message, message("m"));
    assert.deepEqual(queued.binding, binding);
  } finally { store.close(); }
});

test("authorization waiting is retained separately from replayable queued business messages", () => {
  const files = fixture(); let store = new GatewayStore(files.path);
  try {
    store.acquireRuntimeLock();
    const task = store.inbox.enqueue(message("oauth"), binding)!;
    store.inbox.claim(task.id, binding); store.inbox.dispatched(task.id, "session", "hash");
    store.inbox.finish(task.id, "awaiting_authorization");
    store.close(); store = new GatewayStore(files.path); store.acquireRuntimeLock();
    const recovered = store.inbox.recover("lark", "cli");
    assert.equal(recovered.awaitingAuthorization.length, 1);
    assert.deepEqual(recovered.queued, []); assert.deepEqual(recovered.interrupted, []);
    assert.equal(store.inbox.claim(task.id, binding), undefined);
  } finally { store.close(); files.cleanup(); }
});

test("inbox rejects invalid transitions and does not reactivate completed work", () => {
  const store = new GatewayStore(":memory:");
  try {
    store.acquireRuntimeLock();
    const task = store.inbox.enqueue(message("m"), binding)!;
    assert.throws(() => store.inbox.dispatched(task.id, "session", "hash"), /状态/);
    assert.throws(() => store.inbox.finish(task.id, "completed"), /状态/);
    store.inbox.claim(task.id, binding); store.inbox.finish(task.id, "completed");
    assert.throws(() => store.inbox.finish(task.id, "failed"), /状态/);
    assert.equal(store.inbox.claim(task.id, binding), undefined);
  } finally { store.close(); }
});

test("metadata tampering is rejected and a queued-only database cannot replace a missing encryption key", () => {
  const files = fixture(); let store = new GatewayStore(files.path);
  try {
    store.acquireRuntimeLock(); store.inbox.enqueue(message("m"), binding); store.close();
    const db = new DatabaseSync(files.path);
    db.prepare("UPDATE gateway_message_inbox SET agent_id = 'other'").run(); db.close();
    store = new GatewayStore(files.path); store.acquireRuntimeLock();
    assert.throws(() => store.inbox.recover("lark", "cli"), /解密失败/);
    store.close(); unlinkSync(`${files.path}.credential-key`);
    store = new GatewayStore(files.path); store.acquireRuntimeLock();
    assert.throws(() => store.inbox.recover("lark", "cli"), /密钥/);
  } finally { store.close(); files.cleanup(); }
});

test("one corrupt pending record rolls back recovery instead of partially changing valid records", () => {
  const files = fixture(); let store = new GatewayStore(files.path);
  try {
    store.acquireRuntimeLock();
    const first = store.inbox.enqueue(message("first"), binding)!;
    store.inbox.claim(first.id, binding);
    const second = store.inbox.enqueue(message("second"), binding)!;
    store.close();
    const db = new DatabaseSync(files.path);
    db.prepare("UPDATE gateway_message_inbox SET secret = 'corrupt' WHERE id = ?").run(second.id); db.close();
    store = new GatewayStore(files.path); store.acquireRuntimeLock();
    assert.throws(() => store.inbox.recover("lark", "cli"), /解密失败/);
    const inspect = new DatabaseSync(files.path);
    assert.equal(inspect.prepare("SELECT state FROM gateway_message_inbox WHERE id = ?").get(first.id)!.state, "preparing");
    inspect.close();
  } finally { store.close(); files.cleanup(); }
});

test("an exited real process leaves ordered pending tasks and uncertain dispatched work", () => {
  const files = fixture();
  try {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
      const store = new GatewayStore(${JSON.stringify(files.path)}); store.acquireRuntimeLock();
      const binding = ${JSON.stringify(binding)};
      const first = store.inbox.enqueue(${JSON.stringify(message("first"))}, binding);
      store.inbox.claim(first.id, binding); store.inbox.dispatched(first.id, "session", "hash");
      store.inbox.enqueue(${JSON.stringify(message("later"))}, binding);
      process.exit(0);
    `], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const store = new GatewayStore(files.path);
    try {
      store.acquireRuntimeLock(); const recovered = store.inbox.recover("lark", "cli");
      assert.deepEqual(recovered.queued.map(item => item.message.messageId), ["later"]);
      assert.deepEqual(recovered.interrupted.map(item => item.message.messageId), ["first"]);
    } finally { store.close(); }
  } finally { files.cleanup(); }
});
