import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { Gateway, KeyedQueue, toConversationKey, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import { EmployeeAuthorizationManager } from "../src/employee-auth.ts";
import { OAuthError, type OAuthTokens } from "../src/oauth.ts";
import { readOnlyEvidence } from "./helpers/run-evidence.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const message = (id: string, user = "user"): IncomingMessage => ({ channelType: "lark", installationId: "cli", tenantId: "tenant",
  conversationId: `chat-${user}`, conversationType: "direct", senderId: user, eventId: id, messageId: id, text: id,
  threadId: "", rootMessageId: "", parentMessageId: "", createTime: 1, resources: [], mentionedBot: false });
const request = { identity: "user", errorType: "authentication", subtype: "token_missing", domain: "calendar" } as const;
const tokens = (): OAuthTokens => ({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 600_000 });

test("paused scope preserves FIFO, permits another scope and resumes authorization before followers", async () => {
  const queue = new KeyedQueue(); const calls: string[] = [];
  queue.pause("a");
  queue.enqueue("a", async () => { calls.push("later-1"); });
  queue.enqueue("a", async () => { calls.push("later-2"); });
  queue.enqueue("b", async () => { calls.push("other"); });
  await flush(); assert.deepEqual(calls, ["other"]);
  queue.enqueue("a", async () => { calls.push("resume"); }, true);
  await flush(); assert.deepEqual(calls, ["other"]);
  queue.resume("a"); await flush();
  assert.deepEqual(calls, ["other", "resume", "later-1", "later-2"]);
});

test("pausing a running scope does not interrupt it and failures do not starve other queued tasks", async () => {
  const queue = new KeyedQueue(); const first = deferred<void>(), calls: string[] = [];
  queue.enqueue("a", async () => { calls.push("first"); await first.promise; });
  queue.enqueue("a", async () => { calls.push("second"); throw new Error("test failure"); });
  queue.enqueue("a", async () => { calls.push("third"); });
  await flush(); queue.pause("a"); first.resolve(); await flush();
  assert.deepEqual(calls, ["first"]);
  queue.resume("a"); await flush();
  assert.deepEqual(calls, ["first", "second", "third"]);
});

test("reset control preserves ordinary FIFO when there is no authorization pause", async () => {
  const queue = new KeyedQueue(); const first = deferred<void>(), calls: string[] = [];
  queue.enqueue("a", async () => { calls.push("first"); await first.promise; });
  queue.enqueue("a", async () => { calls.push("second"); });
  queue.enqueue("a", async () => { calls.push("reset"); }, false, true);
  await flush(); first.resolve(); await flush();
  assert.deepEqual(calls, ["first", "second", "reset"]);
});

for (const durableQueue of [false, true]) {
test(`OAuth wait pauses only its direct scope, removes Get and recovers before already queued messages (durable=${durableQueue})`, async t => {
  const store = new GatewayStore(":memory:"); const poll = deferred<OAuthTokens>();
  if (durableQueue) store.acquireRuntimeLock();
  const runs: string[] = [], reactions: string[] = [], replies: string[] = [];
  let gateway: Gateway, calls = 0;
  const auth = new EmployeeAuthorizationManager(store, {
    listVaults: async () => [], createVault: async () => "user-vault", listCredentials: async () => [],
    createEnvironmentVariableCredential: async () => "credential", updateEnvironmentCredential: async () => undefined
  }, { applicationId: "cli", begin: async () => ({ deviceCode: "code", verificationUrl: "https://example.test", expiresAt: Date.now() + 600_000, intervalMs: 1000 }),
    poll: () => poll.promise, getUserIdentity: async () => ({ openId: "user", tenantKey: "tenant" }) } as never,
  async () => { replies.push("card"); }, (m, vault) => gateway.resumeAfterAuthorization(m, vault), {
    notify: async (_m, text) => { replies.push(text); },
    onStateChange: (messages, flowId, active) => gateway.setAuthorizationWaiting(messages, flowId, active)
  });
  gateway = new Gateway(store, { createSession: async () => `session-${++calls}`,
    run: async (_id, input) => {
      const text = input.match(/<current_request>\n([\s\S]*?)\n<\/current_request>/)![1]; runs.push(text);
      return { terminal: "idle", messages: ["done"], ...(text === "first" && runs.filter(s => s === "first").length === 1 ? { authorizationRequired: request, evidence: readOnlyEvidence() } : {}) };
    }
  }, async (_m, outbound) => { if (outbound.type === "text") replies.push(outbound.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "bot-vault", timeoutMs: 1000, platformAccess: true, dualIdentity: true, durableQueue,
    getUserVaultIds: async m => m.senderId === "user" ? auth.vaultIds(m) : [],
    ensureAuthorization: (m, r) => auth.ensure(m, r), cancelAuthorization: m => auth.cancel(m),
    addReaction: async (m, emoji) => { reactions.push(`add:${m.messageId}:${emoji}`); return m.messageId; },
    removeReaction: async m => { reactions.push(`remove:${m.messageId}`); }
  });
  t.after(() => { auth.close(); store.close(); });
  gateway.accept(message("first")); gateway.accept(message("second")); gateway.accept(message("third"));
  await flush(); await flush();
  assert.deepEqual(runs, ["first"]); assert.deepEqual(replies, ["card"]);
  assert.deepEqual(reactions, ["add:first:Get", "remove:first"]);
  gateway.accept(message("other", "other")); await flush();
  assert.deepEqual(runs, ["first", "other"]);
  poll.resolve(tokens()); await flush(); await flush();
  assert.equal(runs.length, 5);
  assert.deepEqual([runs[0], runs[1], runs[3], runs[4]], ["first", "other", "second", "third"]);
  assert.match(runs[2], /原任务的授权恢复事件/);
  assert.doesNotMatch(runs[2], /first/);
  assert.equal(calls, 2);
});
}

test("terminal authorization states release queued messages and stale completion cannot release a replacement", async () => {
  const store = new GatewayStore(":memory:"); const runs: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => "session", run: async (_id, input) => { runs.push(input); return { terminal: "idle", messages: ["done"] }; } }, async () => undefined,
    { agentId: "agent", environmentId: "env", vaultId: "bot", timeoutMs: 1000, platformAccess: true });
  gateway.setAuthorizationWaiting([message("first")], "old", true);
  gateway.setAuthorizationWaiting([message("first")], "new", true);
  gateway.accept(message("later"));
  gateway.setAuthorizationWaiting([message("first")], "old", false); await flush(); assert.equal(runs.length, 0);
  gateway.setAuthorizationWaiting([message("first")], "new", false); await flush(); assert.equal(runs.length, 1);
  store.close();
});

for (const action of ["cancel", "new", "denied", "expired"] as const) {
  test(`restored authorization pause is released by ${action} without replaying its original task`, async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
    const store = new GatewayStore(":memory:"); store.acquireRuntimeLock();
    const original = message("original"), identity = { channelType: "lark", installationId: "cli", tenantId: "tenant", openId: "user" };
    store.saveSession(toConversationKey(original), "old-session", "agent", undefined, ["bot", "vault"]);
    store.startAuthorizationRecovery(original, "old-session");
    const flow = store.authorizations.create(identity, [original]);
    store.authorizations.save(identity, flow, { phase: "waiting", expiresAt: 11_000,
      device: { deviceCode: "code", verificationUrl: "https://example.test", expiresAt: 11_000, intervalMs: 100 } });
    const poll = deferred<OAuthTokens>(); const runs: string[] = [], replies: string[] = [];
    let gateway: Gateway;
    const auth = new EmployeeAuthorizationManager(store, {} as never, {
      applicationId: "cli", poll: () => poll.promise
    } as never, async () => { throw new Error("不得重新发卡"); }, (m, vault) => gateway.resumeAfterAuthorization(m, vault), {
      notify: async (_m, text) => { replies.push(text); },
      onStateChange: (messages, id, active) => gateway.setAuthorizationWaiting(messages, id, active)
    });
    gateway = new Gateway(store, { createSession: async () => "new-session", run: async (id, input) => {
      runs.push(`${id}:${input.match(/<current_request>\n([\s\S]*?)\n<\/current_request>/)![1]}`);
      return { terminal: "idle", messages: ["done"] };
    } }, async (_m, outbound) => { if (outbound.type === "text") replies.push(outbound.text); }, {
      agentId: "agent", environmentId: "env", vaultId: "bot", timeoutMs: 1000, platformAccess: true,
      cancelAuthorization: m => auth.cancel(m)
    });
    t.after(() => { auth.close(); store.close(); });
    assert.equal(auth.restore(), 1);
    gateway.accept(message("later")); await flush();
    assert.deepEqual(runs, []);
    if (action === "cancel" || action === "new") gateway.accept({ ...message("control"), text: action === "new" ? "/new" : "/auth cancel" });
    else if (action === "denied") poll.reject(new OAuthError("denied"));
    else t.mock.timers.tick(1000);
    await flush(); await flush();
    assert.deepEqual(runs, [`${action === "new" ? "new-session" : "old-session"}:later`]);
    assert.equal(store.getAuthorizationRecovery(original)?.state, action === "denied" ? "failed" : action === "expired" ? "expired" : "cancelled");
    assert.ok(replies.length >= 1);
    if (action !== "denied") { poll.resolve(tokens()); await flush(); assert.equal(runs.length, 1); }
  });
}

test("group scopes cannot be paused by a user authorization callback", async () => {
  const store = new GatewayStore(":memory:"); let runs = 0;
  const gateway = new Gateway(store, { createSession: async () => "group", run: async () => { runs++; return { terminal: "idle", messages: ["done"] }; } }, async () => undefined,
    { agentId: "agent", environmentId: "env", vaultId: "bot", timeoutMs: 1000, platformAccess: true, sharedGroupSessions: true });
  const incoming = { ...message("group"), conversationType: "group" as const, mentionedBot: true };
  gateway.setAuthorizationWaiting([incoming], "invalid", true); gateway.accept(incoming); await flush();
  assert.equal(runs, 1); store.close();
});

test("mixed-scope load keeps 500 tasks ordered and never overlaps within one scope", async () => {
  const queue = new KeyedQueue();
  const active = new Map<string, number>(), observed = new Map<string, number[]>();
  let globalActive = 0, maxActive = 0, complete = 0;
  const done = deferred<void>();
  for (let scope = 0; scope < 20; scope++) {
    const key = String(scope); observed.set(key, []);
    if (scope % 2 === 0) queue.pause(key);
    for (let i = 0; i < 25; i++) queue.enqueue(key, async () => {
      assert.equal(active.get(key) || 0, 0);
      active.set(key, 1); globalActive++; maxActive = Math.max(maxActive, globalActive);
      observed.get(key)!.push(i); await flush();
      active.set(key, 0); globalActive--;
      if (++complete === 500) done.resolve();
    });
  }
  await flush();
  for (let scope = 0; scope < 20; scope += 2) { assert.deepEqual(observed.get(String(scope)), []); queue.resume(String(scope)); }
  await done.promise;
  assert.ok(maxActive > 1);
  for (const values of observed.values()) assert.deepEqual(values, Array.from({ length: 25 }, (_, i) => i));
});
