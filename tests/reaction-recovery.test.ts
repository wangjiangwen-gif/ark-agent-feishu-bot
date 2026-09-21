import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as flush } from "node:timers/promises";
import { GatewayStore } from "../src/store.ts";
import { Gateway, type GatewayOptions } from "../src/gateway.ts";
import type { ChannelMessage } from "../src/channel.ts";
import { LarkChannelAdapter, type LarkChannelPort } from "../src/lark-channel.ts";

const message = (id = "first"): ChannelMessage => ({ channelType: "lark", installationId: "cli", tenantId: "tenant", senderId: "user",
  conversationId: "chat", conversationType: "group", threadId: "", rootMessageId: "", parentMessageId: "", messageId: id,
  eventId: id, createTime: 1, text: id, resources: [], mentionedBot: true });
const binding = { scope: "scope", agentId: "agent", configFingerprint: "config" };
const options: GatewayOptions = { agentId: "agent", environmentId: "env", vaultId: "bot-vault", appId: "cli", platformAccess: true,
  sharedGroupSessions: true, durableQueue: true, timeoutMs: 1000, sessionCompaction: false };
async function until(check: () => boolean) { for (let n = 0; n < 100 && !check(); n++) await flush(); assert.ok(check()); }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ark-reactions-")), path = join(dir, "gateway.db");
  const store = new GatewayStore(path); store.acquireRuntimeLock();
  return { store, path, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("reaction receipt is encrypted, survives restart, and does not change task revision", () => {
  const f = fixture();
  try {
    const task = f.store.receiveMessage(message(), binding)!;
    const receipt = f.store.reactions.begin(message(), "OnIt");
    f.store.reactions.activate(receipt.id, "private-reaction-id");
    assert.equal(f.store.inbox.findMessage(message())!.revision, task.revision);
    assert.equal(readFileSync(f.path).includes(Buffer.from("private-reaction-id")), false);
    f.store.close(); const reopened = new GatewayStore(f.path); reopened.acquireRuntimeLock();
    try {
      const [saved] = reopened.reactions.pending("lark", "cli");
      assert.deepEqual(reopened.reactions.pending("lark", "other-app"), []);
      assert.equal(saved.receipt.reactionId, "private-reaction-id");
      assert.equal(saved.message.messageId, "first");
      const removing = reopened.reactions.startRemoval(saved.receipt.id);
      reopened.reactions.finishRemoval(removing);
      assert.deepEqual(reopened.reactions.pending("lark", "cli"), []);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test("unknown creation is retained but not guessed for cleanup; active current work is excluded", () => {
  const f = fixture();
  try {
    f.store.receiveMessage(message(), binding);
    f.store.reactions.begin(message(), "OnIt");
    const active = f.store.reactions.begin(message(), "Get"); f.store.reactions.activate(active.id, "known");
    assert.deepEqual(f.store.reactions.pending("lark", "cli"), []);
    f.store.close(); const reopened = new GatewayStore(f.path); reopened.acquireRuntimeLock();
    try { assert.deepEqual(reopened.reactions.pending("lark", "cli").map(x => x.receipt.reactionId), ["known"]); }
    finally { reopened.close(); }
  } finally { f.close(); }
});

test("an unresolved emoji cannot be recreated while old cleanup may still remove the same platform ID", () => {
  const f = fixture();
  try {
    f.store.receiveMessage(message(), binding);
    const r = f.store.reactions.begin(message(), "Get");
    assert.throws(() => f.store.reactions.begin(message(), "Get"));
    f.store.reactions.activate(r.id, "rid");
    f.store.reactions.startRemoval(r.id);
    assert.throws(() => f.store.reactions.begin(message(), "Get"));
  } finally { f.close(); }
});

test("reaction checkpoints reject foreign identity, invalid IDs, stale completion, and missing runtime lock", () => {
  const f = fixture();
  try {
    f.store.receiveMessage(message(), binding);
    assert.throws(() => f.store.reactions.begin({ ...message(), senderId: "other" }, "Get"));
    assert.throws(() => f.store.reactions.begin(message(), "arbitrary"));
    const r = f.store.reactions.begin(message(), "Get");
    assert.throws(() => f.store.reactions.activate(r.id, ""));
    f.store.reactions.activate(r.id, "rid");
    assert.throws(() => f.store.reactions.activate(r.id, "other"));
    const first = f.store.reactions.startRemoval(r.id), second = f.store.reactions.startRemoval(r.id);
    assert.throws(() => f.store.reactions.finishRemoval(first)); f.store.reactions.finishRemoval(second);
    const unlocked = new GatewayStore(f.path);
    try { assert.throws(() => unlocked.reactions.pending("lark", "cli")); } finally { unlocked.close(); }
  } finally { f.close(); }
});

test("Gateway persists reactions, retains failed cleanup after completion, and retries only cleanup", async () => {
  const f = fixture(); let runs = 0, removals = 0, fail = true;
  const gateway = new Gateway(f.store, { createSession: async () => "session", run: async () => { runs++; return { terminal: "idle", messages: ["done"] }; } }, async () => {}, {
    ...options, addReaction: async () => "rid", removeReaction: async () => { removals++; if (fail) throw new Error("private-error"); }
  });
  try {
    gateway.accept(message()); await until(() => f.store.inbox.findMessage(message())?.state === "completed");
    assert.equal(f.store.reactions.pending("lark", "cli").length, 1);
    fail = false; await gateway.recoverPendingReactions("lark", "cli");
    assert.equal(runs, 1); assert.equal(removals, 2); assert.deepEqual(f.store.reactions.pending("lark", "cli"), []);
  } finally { f.close(); }
});

test("repeated recovery joins one cleanup and never queries or submits MA", async () => {
  const f = fixture(); let removals = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const task = f.store.receiveMessage(message(), binding)!; f.store.inbox.claim(task.id, binding);
    const r = f.store.reactions.begin(message(), "Get"); f.store.reactions.activate(r.id, "rid"); f.store.finishMessage(task.id, "failed");
    const gateway = new Gateway(f.store, { createSession: async () => { throw new Error("no MA"); }, run: async () => { throw new Error("no MA"); } }, async () => {}, {
      ...options, removeReaction: async () => { removals++; await gate; }
    });
    const a = gateway.recoverPendingReactions("lark", "cli"), b = gateway.recoverPendingReactions("lark", "cli");
    await until(() => removals === 1); release(); await Promise.all([a, b]);
    assert.equal(removals, 1); assert.equal(f.store.inbox.findMessage(message())!.state, "uncertain");
    assert.deepEqual(f.store.reactions.pending("lark", "other"), []);
  } finally { release?.(); f.close(); }
});

test("actual Gateway exit after Get confirmation restores only old reactions without replaying uncertain work", async () => {
  const f = fixture(); f.store.close();
  try {
    const script = `
      import { GatewayStore } from './src/store.ts';
      import { Gateway } from './src/gateway.ts';
      const store = new GatewayStore(${JSON.stringify(f.path)}); store.acquireRuntimeLock();
      const activate = store.reactions.activate.bind(store.reactions);
      store.reactions.activate = (id, rid) => { const result = activate(id, rid); if (result.emoji === 'Get') process.exit(0); return result; };
      const gateway = new Gateway(store, { createSession: async () => { throw new Error('must not create'); }, run: async () => { throw new Error('must not run'); } }, async () => {}, {
        ...${JSON.stringify(options)}, addReaction: async (m, emoji) => m.messageId + ':' + emoji, removeReaction: async () => {}
      });
      gateway.accept(${JSON.stringify(message())}); gateway.accept(${JSON.stringify(message("second"))});
      setTimeout(() => process.exit(2), 3000);
    `;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    const reopened = new GatewayStore(f.path); reopened.acquireRuntimeLock(); const removed: string[] = []; let runs = 0;
    try {
      const gateway = new Gateway(reopened, { createSession: async () => { runs++; throw new Error("no creation"); }, run: async () => { runs++; throw new Error("no replay"); } }, async () => {}, {
        ...options, removeReaction: async (_m, id) => { removed.push(id); }
      });
      gateway.recoverPendingMessages("lark", "cli");
      await until(() => removed.length === 2); await flush();
      assert.deepEqual(new Set(removed), new Set(["first:Get", "second:OnIt"]));
      assert.equal(runs, 0); assert.equal(reopened.inbox.findMessage(message())!.state, "uncertain");
      assert.equal(reopened.inbox.findMessage(message("second"))!.state, "queued");
      assert.deepEqual(reopened.reactions.pending("lark", "cli"), []);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test("corrupt and cross-task reaction metadata prevents cleanup before calling the channel", async () => {
  const f = fixture(); const db = new DatabaseSync(f.path); let removes = 0;
  try {
    const task = f.store.receiveMessage(message(), binding)!; f.store.inbox.claim(task.id, binding);
    const other = f.store.receiveMessage(message("other"), binding)!;
    const receipt = f.store.reactions.begin(message(), "Get"); f.store.reactions.activate(receipt.id, "rid");
    f.store.finishMessage(task.id, "failed");
    db.prepare("UPDATE gateway_reaction_receipts SET task_id=? WHERE id=?").run(other.id, receipt.id);
    // 旧owner进入恢复范围，但密文绑定原任务，不能借表格字段换删除目标。
    db.prepare("UPDATE gateway_reaction_receipts SET owner='other-owner' WHERE id=?").run(receipt.id);
    const gateway = new Gateway(f.store, { createSession: async () => "unused", run: async () => { throw new Error("unused"); } }, async () => {}, {
      ...options, removeReaction: async () => { removes++; }
    });
    await assert.rejects(gateway.recoverPendingReactions("lark", "cli"), /检查点损坏/);
    assert.equal(removes, 0);
  } finally { db.close(); f.close(); }
});

test("failed receipt persistence prevents adding an untracked reaction", async () => {
  const f = fixture(); const db = new DatabaseSync(f.path); let adds = 0, runs = 0;
  try {
    db.exec("CREATE TRIGGER fail_reaction BEFORE INSERT ON gateway_reaction_receipts BEGIN SELECT RAISE(ABORT, 'injected'); END");
    const gateway = new Gateway(f.store, { createSession: async () => "session", run: async () => { runs++; return { terminal: "idle", messages: ["done"] }; } }, async () => {}, {
      ...options, addReaction: async () => { adds++; return "rid"; }, removeReaction: async () => {}
    });
    gateway.accept(message()); await until(() => f.store.inbox.findMessage(message())?.state === "completed");
    assert.equal(adds, 0); assert.equal(runs, 1);
  } finally { db.close(); f.close(); }
});

test("unknown creation is adopted from a verified lookup and only that ID is deleted", async () => {
  const f = fixture(); const removed: string[] = []; let queried = 0;
  try {
    const task = f.store.receiveMessage(message(), binding)!; f.store.inbox.claim(task.id, binding);
    f.store.reactions.begin(message(), "Get"); f.store.finishMessage(task.id, "failed");
    const gateway = new Gateway(f.store, { createSession: async () => { throw new Error("no MA"); }, run: async () => { throw new Error("no MA"); } }, async () => {}, {
      ...options, inspectReaction: async (m, q) => { queried++; assert.equal(m.messageId, "first"); assert.equal(q.emoji, "Get"); assert.ok(q.createdAt); return { status: "present", reactionId: "recovered-id" }; },
      removeReaction: async (_m, id) => { removed.push(id); }
    });
    await gateway.recoverPendingReactions("lark", "cli");
    assert.equal(queried, 1); assert.deepEqual(removed, ["recovered-id"]);
    assert.deepEqual(f.store.reactions.pending("lark", "cli", true), []);
    assert.equal(f.store.inbox.findMessage(message())!.state, "uncertain");
  } finally { f.close(); }
});

test("lost deletion response is resolved by absence without repeating DELETE", async () => {
  const f = fixture(); let removed = 0;
  try {
    const task = f.store.receiveMessage(message(), binding)!; f.store.inbox.claim(task.id, binding);
    const r = f.store.reactions.begin(message(), "Get"); f.store.reactions.activate(r.id, "rid");
    f.store.reactions.startRemoval(r.id); f.store.finishMessage(task.id, "failed");
    const gateway = new Gateway(f.store, { createSession: async () => "unused", run: async () => { throw new Error("no MA"); } }, async () => {}, {
      ...options, inspectReaction: async () => ({ status: "absent" }), removeReaction: async () => { removed++; }
    });
    await gateway.recoverPendingReactions("lark", "cli");
    assert.equal(removed, 0); assert.deepEqual(f.store.reactions.pending("lark", "cli"), []);
  } finally { f.close(); }
});

for (const status of ["absent", "unknown", "throws"] as const) {
  test(`unknown creation stays recoverable after lookup ${status}`, async () => {
    const f = fixture(); let removed = 0;
    try {
      const task = f.store.receiveMessage(message(), binding)!; f.store.inbox.claim(task.id, binding);
      f.store.reactions.begin(message(), "Get"); f.store.finishMessage(task.id, "failed");
      const gateway = new Gateway(f.store, { createSession: async () => "unused", run: async () => { throw new Error("no MA"); } }, async () => {}, {
        ...options, inspectReaction: async () => { if (status === "throws") throw new Error("private-error"); return { status }; }, removeReaction: async () => { removed++; }
      });
      await gateway.recoverPendingReactions("lark", "cli");
      assert.equal(removed, 0); assert.equal(f.store.reactions.pending("lark", "cli", true)[0].receipt.phase, "creating");
    } finally { f.close(); }
  });
}

test("reaction inspection cannot overwrite a newer checkpoint or adopt a different known ID", () => {
  const f = fixture();
  try {
    const task = f.store.receiveMessage(message(), binding)!; f.store.inbox.claim(task.id, binding);
    const r = f.store.reactions.begin(message(), "Get"), active = f.store.reactions.activate(r.id, "rid");
    assert.throws(() => f.store.reactions.recordInspection(r, { status: "present", reactionId: "other" }));
    assert.throws(() => f.store.reactions.recordInspection(active, { status: "present", reactionId: "other" }));
    assert.throws(() => f.store.reactions.finishAbsent(active));
    const checked = f.store.reactions.recordInspection(active, { status: "absent" });
    f.store.reactions.finishAbsent(checked);
    assert.throws(() => f.store.reactions.finishAbsent(checked));
  } finally { f.close(); }
});

test("unknown queued reactions from an old owner remain discoverable after an absent lookup", () => {
  const f = fixture();
  try {
    f.store.receiveMessage(message(), binding); f.store.reactions.begin(message(), "OnIt");
    f.store.close(); const reopened = new GatewayStore(f.path); reopened.acquireRuntimeLock();
    try {
      const saved = reopened.reactions.pending("lark", "cli", true)[0].receipt;
      reopened.reactions.recordInspection(saved, { status: "absent" });
      assert.equal(reopened.reactions.pending("lark", "cli", true).length, 1);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test("native adapter and Gateway resolve accepted creation plus lost deletion acknowledgement", async () => {
  const f = fixture(); let present = true, gets = 0, deletes = 0;
  try {
    const task = f.store.receiveMessage(message(), binding)!; f.store.inbox.claim(task.id, binding);
    const r = f.store.reactions.begin(message(), "Get"); f.store.finishMessage(task.id, "failed");
    const port = { rawClient: { im: { v1: { messageReaction: {
      list: async p => {
        gets++; assert.equal(p.path.message_id, "first");
        return { code: 0, data: { has_more: false, items: present ? [{ reaction_id: "rid", operator: { operator_type: "app", operator_id: "cli" },
          reaction_type: { emoji_type: "Get" }, action_time: String(r.createdAt! + 1) }] : [] } };
      },
      delete: async p => { deletes++; assert.equal(p.path.reaction_id, "rid"); present = false; throw new Error("response lost after removal"); }
    } } } } } as unknown as LarkChannelPort;
    const adapter = new LarkChannelAdapter({ appId: "cli", appSecret: "unused", channel: port });
    const gateway = new Gateway(f.store, { createSession: async () => { throw new Error("no MA"); }, run: async () => { throw new Error("no MA"); } }, async () => {}, {
      ...options, inspectReaction: adapter.inspectReaction.bind(adapter), removeReaction: adapter.removeReaction.bind(adapter)
    });
    await gateway.recoverPendingReactions("lark", "cli");
    assert.equal(f.store.reactions.pending("lark", "cli")[0].receipt.phase, "removing");
    await gateway.recoverPendingReactions("lark", "cli");
    assert.equal(gets, 2); assert.equal(deletes, 1);
    assert.deepEqual(f.store.reactions.pending("lark", "cli", true), []);
    assert.equal(f.store.inbox.findMessage(message())!.state, "uncertain");
  } finally { f.close(); }
});

test("concurrent recovery coalesces the lookup as well as deletion", async () => {
  const f = fixture(); let queried = 0, deleted = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const task = f.store.receiveMessage(message(), binding)!; f.store.inbox.claim(task.id, binding);
    const r = f.store.reactions.begin(message(), "Get"); f.store.reactions.activate(r.id, "rid"); f.store.finishMessage(task.id, "failed");
    const gateway = new Gateway(f.store, { createSession: async () => "unused", run: async () => { throw new Error("no MA"); } }, async () => {}, {
      ...options, inspectReaction: async () => { queried++; await gate; return { status: "present", reactionId: "rid" }; }, removeReaction: async () => { deleted++; }
    });
    const a = gateway.recoverPendingReactions("lark", "cli"), b = gateway.recoverPendingReactions("lark", "cli");
    await until(() => queried === 1); release(); await Promise.all([a, b]);
    assert.equal(queried, 1); assert.equal(deleted, 1);
  } finally { release?.(); f.close(); }
});

test("checkpoint changed while querying prevents stale absence from clearing a live receipt", async () => {
  const f = fixture(); let deleted = 0;
  try {
    const task = f.store.receiveMessage(message(), binding)!; f.store.inbox.claim(task.id, binding);
    const r = f.store.reactions.begin(message(), "Get"); f.store.reactions.activate(r.id, "rid"); f.store.finishMessage(task.id, "failed");
    const gateway = new Gateway(f.store, { createSession: async () => "unused", run: async () => { throw new Error("no MA"); } }, async () => {}, {
      ...options, inspectReaction: async () => { f.store.reactions.startRemoval(r.id); return { status: "absent" }; }, removeReaction: async () => { deleted++; }
    });
    await gateway.recoverPendingReactions("lark", "cli");
    assert.equal(deleted, 0); assert.equal(f.store.reactions.pending("lark", "cli").length, 1);
  } finally { f.close(); }
});
