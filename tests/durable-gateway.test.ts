import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Gateway, toConversationKey, type IncomingMessage, type GatewayOptions } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import { readOnlyEvidence } from "./helpers/run-evidence.ts";

const message = (id: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({ channelType: "lark", installationId: "cli",
  tenantId: "tenant", senderId: "user", conversationId: "chat", conversationType: "direct", threadId: "", rootMessageId: "",
  parentMessageId: "", messageId: id, eventId: id, text: id, createTime: 1, resources: [], mentionedBot: false, ...extra });
const options: GatewayOptions = { agentId: "agent", environmentId: "env", vaultId: "bot-vault", appId: "cli",
  platformAccess: true, sharedGroupSessions: true, durableQueue: true, timeoutMs: 1000, sessionCompaction: false };
const authRequest = { identity: "user", errorType: "authentication", subtype: "token_missing", domain: "calendar" } as const;
const done = () => ({ terminal: "idle" as const, messages: ["done"] });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(check: () => boolean) { for (let n = 0; n < 80 && !check(); n++) await flush(); assert.ok(check()); }
const text = (input: string) => input.match(/<current_request>\n([\s\S]*?)\n<\/current_request>/)?.[1] || input;

test("durable Gateway persists acceptance before execution and keeps shared group FIFO and reactions", async () => {
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock();
  const gate = deferred(), runs: string[] = [], reactions: string[] = []; let creates = 0;
  const gateway = new Gateway(store, { createSession: async () => `session-${++creates}`, run: async (_id, input) => {
    runs.push(text(input)); if (runs.length === 1) await gate.promise; return done();
  } }, async () => {}, { ...options,
    addReaction: async (m, emoji) => { reactions.push(`add:${m.messageId}:${emoji}`); return `${m.messageId}:${emoji}`; },
    removeReaction: async (_m, id) => { reactions.push(`remove:${id}`); }, getUserVaultIds: async () => { throw new Error("group UAT leak"); } });
  try {
    const first = message("first", { conversationType: "group", mentionedBot: true });
    const second = message("second", { conversationType: "group", mentionedBot: true, senderId: "other" });
    assert.equal(gateway.accept(first), true); assert.equal(gateway.accept(second), true);
    assert.deepEqual(store.recoverMessages("lark", "cli").queued.map(t => t.message.messageId), ["first", "second"]);
    await until(() => runs.length === 1);
    assert.equal(store.inbox.findMessage(first)!.state, "dispatched");
    assert.ok(reactions.includes("add:second:OnIt"));
    assert.equal(gateway.accept({ ...first, eventId: "duplicate" }), false);
    gate.resolve(); await until(() => store.inbox.findMessage(second)?.state === "completed");
    assert.deepEqual(runs, ["first", "second"]); assert.equal(creates, 1);
    assert.ok(reactions.indexOf("remove:second:OnIt") < reactions.indexOf("add:second:Get"));
    assert.ok(reactions.includes("remove:first:Get")); assert.ok(reactions.includes("remove:second:Get"));
  } finally { gate.resolve(); store.close(); }
});

test("durable Gateway preserves independent Thread and direct scopes and ignores unmentioned messages", async () => {
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock(); const gate = deferred(), runs: string[] = [];
  let sessions = 0;
  const gateway = new Gateway(store, { createSession: async () => `session-${++sessions}`, run: async (_id, input) => {
    runs.push(text(input)); if (text(input) === "group") await gate.promise; return done();
  } }, async () => {}, options);
  try {
    assert.equal(gateway.accept(message("background", { conversationType: "group" })), false);
    assert.equal(store.inbox.findMessage(message("background")), undefined);
    gateway.accept(message("group", { conversationType: "group", mentionedBot: true }));
    gateway.accept(message("thread", { conversationType: "group", mentionedBot: true, threadId: "thread" }));
    const direct = message("direct", { conversationId: "dm" }); gateway.accept(direct);
    await until(() => store.inbox.findMessage(direct)?.state === "completed");
    assert.deepEqual(new Set(runs), new Set(["group", "thread", "direct"]));
    gate.resolve(); await until(() => store.inbox.findMessage(message("group", { conversationType: "group", mentionedBot: true }))?.state === "completed");
  } finally { gate.resolve(); store.close(); }
});

test("unknown MA execution blocks followers but not other scopes or authorization status controls", async () => {
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock(); const runs: string[] = [], replies: string[] = [];
  let creates = 0;
  const gateway = new Gateway(store, { createSession: async () => `session-${++creates}`, run: async (_id, input) => {
    runs.push(text(input)); if (text(input) === "unknown") throw new Error("network after submission"); return done();
  } }, async (_m, reply) => { if (reply.type === "text") replies.push(reply.text); }, { ...options, authorizationStatus: () => "local-status" });
  try {
    gateway.accept(message("unknown")); gateway.accept(message("later"));
    const other = message("other", { conversationId: "other-chat" }); gateway.accept(other);
    await until(() => store.inbox.findMessage(message("unknown"))?.state === "uncertain" && store.inbox.findMessage(other)?.state === "completed");
    gateway.accept(message("status", { text: "/auth status" })); await until(() => replies.includes("local-status"));
    gateway.setAuthorizationWaiting([message("unknown")], "unrelated-flow", false); await flush();
    assert.deepEqual(new Set(runs), new Set(["unknown", "other"]));
    assert.equal(store.inbox.findMessage(message("later"))!.state, "queued");
  } finally { store.close(); }
});

test("queued message is an immutable snapshot and survives Gateway reconstruction before new arrivals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-durable-gateway-")), path = join(dir, "gateway.db");
  let store = new GatewayStore(path); store.acquireRuntimeLock(); const calls: string[] = [];
  try {
    const idle = new Gateway(store, { createSession: async () => "session", run: async () => { throw new Error("paused"); } }, async () => {}, options);
    const original = message("first"); idle.setAuthorizationWaiting([original], "test-pause", true);
    idle.accept(original); original.text = "mutated"; store.close();
    store = new GatewayStore(path); store.acquireRuntimeLock();
    const restarted = new Gateway(store, { createSession: async () => "session", run: async (_s, input) => { calls.push(text(input)); return done(); } }, async () => {}, options);
    restarted.recoverPendingMessages("lark", "cli"); restarted.recoverPendingMessages("lark", "cli");
    const next = message("next"); restarted.accept(next);
    await until(() => store.inbox.findMessage(next)?.state === "completed");
    assert.deepEqual(calls, ["first", "next"]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("configuration changes block recovered tasks without creating another Agent Session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-durable-config-")), path = join(dir, "gateway.db");
  let store = new GatewayStore(path); store.acquireRuntimeLock(); let creates = 0; const replies: string[] = [];
  try {
    const first = new Gateway(store, { createSession: async () => "session", run: async () => done() }, async () => {}, options);
    first.setAuthorizationWaiting([message("first")], "pause", true); first.accept(message("first")); store.close();
    store = new GatewayStore(path); store.acquireRuntimeLock();
    const restarted = new Gateway(store, { createSession: async () => { creates++; return "other-session"; }, run: async () => done() },
      async (_m, r) => { if (r.type === "text") replies.push(r.text); }, { ...options, agentId: "other-agent" });
    restarted.recoverPendingMessages("lark", "cli"); await until(() => replies.length > 0);
    assert.equal(creates, 0); assert.equal(store.inbox.findMessage(message("first"))!.state, "queued");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("OAuth continuation uses the original durable task and Session before followers", async () => {
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock(); const runs: string[] = [], sessions: string[] = []; let gateway: Gateway;
  const first = message("first"), later = message("later");
  gateway = new Gateway(store, { createSession: async () => "original", run: async (s, input) => {
    sessions.push(s); runs.push(text(input)); return { ...done(), ...(runs.length === 1 ? { authorizationRequired: authRequest, evidence: readOnlyEvidence() } : {}) };
  }, getSessionStats: async () => ({ status: "idle" as const, eventCount: 3 }) }, async () => {}, { ...options,
    getUserVaultIds: async () => ["user-vault"], ensureAuthorization: async m => { gateway.setAuthorizationWaiting([m], "flow", true); return false; } });
  try {
    gateway.accept(first); gateway.accept(later); await until(() => store.inbox.findMessage(first)?.state === "awaiting_authorization"); await flush();
    assert.equal(runs.length, 1); gateway.resumeAfterAuthorization(first, "user-vault");
    gateway.setAuthorizationWaiting([first], "flow", false);
    await until(() => store.inbox.findMessage(later)?.state === "completed");
    assert.equal(runs.length, 3); assert.notEqual(runs[1], "first"); assert.equal(runs[2], "later");
    assert.deepEqual(sessions, ["original", "original", "original"]);
    assert.equal(store.inbox.findMessage(first)!.state, "completed");
  } finally { store.close(); }
});

test("cancelling OAuth releases durable followers without replaying the cancelled request", async () => {
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock(); const runs: string[] = []; let gateway: Gateway;
  const first = message("first"), later = message("later");
  gateway = new Gateway(store, { createSession: async () => "session", run: async (_s, input) => {
    runs.push(text(input)); return { ...done(), ...(runs.length === 1 ? { authorizationRequired: authRequest, evidence: readOnlyEvidence() } : {}) };
  } }, async () => {}, { ...options, ensureAuthorization: async m => { gateway.setAuthorizationWaiting([m], "flow", true); return false; },
    cancelAuthorization: () => { store.finishAuthorizationRecovery(first, "cancelled"); gateway.setAuthorizationWaiting([first], "flow", false); return true; } });
  try {
    gateway.accept(first); gateway.accept(later); await until(() => store.inbox.findMessage(first)?.state === "awaiting_authorization"); await flush();
    gateway.accept(message("cancel", { text: "/auth cancel" }));
    await until(() => store.inbox.findMessage(later)?.state === "completed");
    assert.deepEqual(runs, ["first", "later"]); assert.equal(store.inbox.findMessage(first)!.state, "failed");
  } finally { store.close(); }
});

test("explicit new bypasses an OAuth wait but not ordinary FIFO and preserves pending followers", async () => {
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock(); const runs: string[] = []; let gateway: Gateway, creates = 0;
  const first = message("first"), later = message("later"), reset = message("reset", { text: "/new" });
  gateway = new Gateway(store, { createSession: async () => `session-${++creates}`, run: async (s, input) => {
    runs.push(`${s}:${text(input)}`); return { ...done(), ...(runs.length === 1 ? { authorizationRequired: authRequest, evidence: readOnlyEvidence() } : {}) };
  } }, async () => {}, { ...options, ensureAuthorization: async m => { gateway.setAuthorizationWaiting([m], "flow", true); return false; },
    cancelAuthorization: () => { store.finishAuthorizationRecovery(first, "cancelled"); gateway.setAuthorizationWaiting([first], "flow", false); return true; } });
  try {
    gateway.accept(first); gateway.accept(later); await until(() => store.inbox.findMessage(first)?.state === "awaiting_authorization"); await flush();
    gateway.accept(reset); await until(() => store.inbox.findMessage(later)?.state === "completed");
    assert.deepEqual(runs, ["session-1:first", "session-2:later"]);
    assert.equal(store.inbox.findMessage(reset)!.state, "completed");
    assert.equal(store.getSession(toConversationKey(first, true)), "session-2");
  } finally { store.close(); }
});

test("actual Gateway process exit preserves queued arrivals and restart drains them exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-gateway-exit-")), path = join(dir, "gateway.db");
  try {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
      import { Gateway } from ${JSON.stringify(new URL("../src/gateway.ts", import.meta.url).href)};
      const store = new GatewayStore(${JSON.stringify(path)}); store.acquireRuntimeLock();
      const gateway = new Gateway(store, { createSession: async () => { throw new Error('must stay queued'); }, run: async () => { throw new Error('must stay queued'); } }, async () => {}, ${JSON.stringify(options)});
      gateway.setAuthorizationWaiting([${JSON.stringify(message("first"))}], 'test-pause', true);
      gateway.accept(${JSON.stringify(message("first"))}); gateway.accept(${JSON.stringify(message("second"))});
      process.exit(0);
    `], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const store = new GatewayStore(path); store.acquireRuntimeLock(); const calls: string[] = [];
    try {
      const gateway = new Gateway(store, { createSession: async () => "session", run: async (_s, input) => { calls.push(text(input)); return done(); } }, async () => {}, options);
      gateway.recoverPendingMessages("lark", "cli"); assert.equal(gateway.accept(message("first")), false);
      await until(() => store.inbox.findMessage(message("second"))?.state === "completed");
      assert.deepEqual(calls, ["first", "second"]);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dispatch failure during OAuth continuation blocks subsequent tasks without starting another Session", async () => {
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock(); const runs: string[] = []; let gateway: Gateway;
  const first = message("first"), later = message("later");
  gateway = new Gateway(store, { createSession: async () => "session", run: async (_s, input) => {
    runs.push(text(input)); if (runs.length > 1) throw new Error("continuation outcome unknown");
    return { ...done(), authorizationRequired: authRequest, evidence: readOnlyEvidence() };
  } }, async () => {}, { ...options, getUserVaultIds: async () => ["user-vault"],
    ensureAuthorization: async m => { gateway.setAuthorizationWaiting([m], "flow", true); return false; } });
  try {
    gateway.accept(first); gateway.accept(later); await until(() => store.inbox.findMessage(first)?.state === "awaiting_authorization"); await flush();
    gateway.resumeAfterAuthorization(first, "user-vault"); gateway.setAuthorizationWaiting([first], "flow", false);
    await until(() => store.inbox.findMessage(first)?.state === "uncertain"); await flush();
    assert.equal(runs.length, 2); assert.equal(store.inbox.findMessage(later)!.state, "queued");
    assert.equal(store.inbox.findMessage(first)!.sessionId, "session");
  } finally { store.close(); }
});

test("terminal OAuth rejection settles the task and releases followers without automatic business replay", async () => {
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock(); const runs: string[] = []; let gateway: Gateway;
  const first = message("first"), later = message("later");
  gateway = new Gateway(store, { createSession: async () => "session", run: async (_s, input) => {
    runs.push(text(input)); return { ...done(), ...(runs.length === 1 ? { authorizationRequired: authRequest } : {}) };
  } }, async () => {}, { ...options, ensureAuthorization: async m => { gateway.setAuthorizationWaiting([m], "flow", true); return false; } });
  try {
    gateway.accept(first); gateway.accept(later); await until(() => store.inbox.findMessage(first)?.state === "awaiting_authorization"); await flush();
    store.finishAuthorizationRecovery(first, "expired"); gateway.setAuthorizationWaiting([first], "flow", false);
    await until(() => store.inbox.findMessage(later)?.state === "completed");
    assert.deepEqual(runs, ["first", "later"]); assert.equal(store.inbox.findMessage(first)!.state, "failed");
  } finally { store.close(); }
});

test("durable mode rejects legacy handoff and cannot be started without exclusive database ownership", () => {
  const store = new GatewayStore(":memory:");
  try {
    const ark = { createSession: async () => "session", run: async () => done() };
    assert.throws(() => new Gateway(store, ark, async () => {}, options), /运行锁/);
    store.acquireRuntimeLock();
    assert.throws(() => new Gateway(store, ark, async () => {}, { ...options, perMessageSessions: true }), /per-message/);
    const gateway = new Gateway(store, ark, async () => {}, options);
    assert.throws(() => gateway.resumeWithHandoff(message("m")), /handoff/);
    assert.throws(() => gateway.resume(message("m")), /重发/);
  } finally { store.close(); }
});

for (const status of ["running", "failed", "unavailable"] as const) {
test(`authorization readiness cannot unblock durable work when MA status is ${status}`, async () => {
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock(); let runs = 0, gateway: Gateway;
  const first = message("first"), later = message("later");
  gateway = new Gateway(store, { createSession: async () => "session", run: async () => { runs++; return { ...done(), authorizationRequired: authRequest, evidence: readOnlyEvidence() }; },
    getSessionStats: async () => { if (status === "unavailable") throw new Error("status unavailable"); return { status, eventCount: 3 }; }
  }, async () => {}, { ...options, getUserVaultIds: async () => ["user-vault"],
    ensureAuthorization: async m => { gateway.setAuthorizationWaiting([m], "flow", true); return false; } });
  try {
    gateway.accept(first); gateway.accept(later); await until(() => store.inbox.findMessage(first)?.state === "awaiting_authorization"); await flush();
    gateway.resumeAfterAuthorization(first, "user-vault"); gateway.setAuthorizationWaiting([first], "flow", false);
    await until(() => store.inbox.findMessage(first)?.state === "uncertain"); await flush();
    assert.equal(runs, 1); assert.equal(store.inbox.findMessage(later)!.state, "queued");
  } finally { store.close(); }
});
}

test("durable processing preserves stream snapshots and does not release followers before card completion", async () => {
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock(); const gate = deferred(), snapshots: string[] = []; let runs = 0;
  const first = message("first"), later = message("later");
  const gateway = new Gateway(store, { createSession: async () => "session", run: async (_s, _input, _timeout, _progress, onDelta) => {
    runs++; await onDelta?.("甲"); await onDelta?.("甲乙"); return { ...done(), messages: ["甲乙丙"] };
  } }, async () => {}, { ...options, streamReply: async (m, producer) => {
    await producer(async snapshot => { snapshots.push(snapshot); }); if (m.messageId === "first") await gate.promise;
  } });
  try {
    gateway.accept(first); gateway.accept(later); await until(() => snapshots.length === 3);
    assert.deepEqual(snapshots, ["甲", "甲乙", "甲乙丙"]);
    assert.equal(store.inbox.findMessage(first)!.state, "dispatched"); assert.equal(runs, 1);
    gate.resolve(); await until(() => store.inbox.findMessage(later)?.state === "completed");
    assert.equal(runs, 2);
  } finally { gate.resolve(); store.close(); }
});

test("actual Gateway exit inside MA dispatch cannot replay its task or release same-scope followers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-gateway-dispatch-exit-")), path = join(dir, "gateway.db");
  try {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
      import { Gateway } from ${JSON.stringify(new URL("../src/gateway.ts", import.meta.url).href)};
      const store = new GatewayStore(${JSON.stringify(path)}); store.acquireRuntimeLock();
      const gateway = new Gateway(store, { createSession: async () => 'session-before-exit', run: async () => process.exit(0) }, async () => {}, ${JSON.stringify(options)});
      gateway.accept(${JSON.stringify(message("first"))}); gateway.accept(${JSON.stringify(message("second"))});
    `], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const store = new GatewayStore(path); store.acquireRuntimeLock(); const calls: string[] = [];
    try {
      const gateway = new Gateway(store, { createSession: async () => "other-session", run: async (_s, input) => { calls.push(text(input)); return done(); } }, async () => {}, options);
      gateway.recoverPendingMessages("lark", "cli");
      const other = message("other", { conversationId: "other-chat" }); gateway.accept(other);
      await until(() => store.inbox.findMessage(other)?.state === "completed");
      assert.deepEqual(calls, ["other"]);
      assert.equal(store.inbox.findMessage(message("first"))!.state, "uncertain");
      assert.equal(store.inbox.findMessage(message("first"))!.sessionId, "session-before-exit");
      assert.equal(store.inbox.findMessage(message("second"))!.state, "queued");
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
