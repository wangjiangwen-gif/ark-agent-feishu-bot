import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { EmployeeAuthorizationManager } from "../src/employee-auth.ts";
import { Gateway, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import { FeishuOAuth, OAuthError, type OAuthTokens } from "../src/oauth.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const message = (id = "m1"): IncomingMessage => ({ channelType: "lark", installationId: "cli", tenantId: "tenant",
  conversationId: "chat", conversationType: "direct", senderId: "user", eventId: id, messageId: id, text: "查看日程",
  threadId: "", rootMessageId: "", parentMessageId: "", createTime: 1, resources: [], mentionedBot: false });
const request = { identity: "user", errorType: "authentication", subtype: "token_missing", domain: "calendar" } as const;
const tokens = (): OAuthTokens => ({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 600_000 });
const device = () => ({ deviceCode: "code", verificationUrl: "https://example.test/auth", expiresAt: Date.now() + 60_000, intervalMs: 1000 });
function fixture(t: TestContext, overrides: Record<string, unknown> = {}, write?: () => Promise<void>) {
  const store = new GatewayStore(":memory:");
  const poll = deferred<OAuthTokens>();
  const notices: string[] = [], resumed: string[] = [], cards: string[] = [], writes: string[] = [];
  const auth = new EmployeeAuthorizationManager(store, {
    listVaults: async () => [], createVault: async () => "vault", listCredentials: async () => [],
    createEnvironmentVariableCredential: async () => "credential",
    updateEnvironmentCredential: async () => { writes.push("write"); await write?.(); }
  }, { applicationId: "cli", begin: async () => device(), poll: async () => poll.promise,
    getUserIdentity: async () => ({ openId: "user", tenantKey: "tenant" }), ...overrides } as never,
  async m => { cards.push(m.messageId); }, m => { resumed.push(m.messageId); },
  { notify: async (_m, text) => { notices.push(text); } });
  t.after(() => { auth.close(); store.close(); });
  store.startAuthorizationRecovery(message(), "original");
  return { store, poll, notices, resumed, cards, writes, auth };
}

test("cancel during begin prevents a late card and token polling", async t => {
  const begin = deferred<ReturnType<typeof device>>(); let polls = 0;
  const f = fixture(t, { begin: () => begin.promise, poll: async () => { polls++; return tokens(); } });
  const starting = f.auth.ensure(message(), request);
  assert.equal(f.auth.cancel(message()), true);
  begin.resolve(device()); await starting;
  assert.deepEqual(f.cards, []); assert.equal(polls, 0);
  assert.equal(f.store.getAuthorizationRecovery(message())?.state, "cancelled");
});

test("cancel rejects stale token completion and does not cancel another identity", async t => {
  const f = fixture(t);
  await f.auth.ensure(message(), request);
  assert.equal(f.auth.cancel({ ...message(), senderId: "other" }), false);
  assert.equal(f.auth.cancel({ ...message(), conversationType: "group" }), false);
  assert.equal(f.auth.cancel(message()), true);
  f.poll.resolve(tokens()); await flush();
  assert.deepEqual(f.writes, []); assert.deepEqual(f.resumed, []);
  assert.equal(f.store.claimAuthorizationRecovery(message()), false);
});

test("cancel during credential synchronization prevents resume without claiming token revocation", async t => {
  const write = deferred<void>();
  const f = fixture(t, {}, () => write.promise);
  await f.auth.ensure(message(), request); f.poll.resolve(tokens()); await flush();
  assert.equal(f.writes.length, 1);
  assert.equal(f.auth.cancel(message()), true);
  write.resolve(); await flush();
  assert.deepEqual(f.resumed, []);
  assert.equal(f.store.credentials.get({ channelType: "lark", installationId: "cli", tenantId: "tenant", openId: "user" })?.status, "ready");
  assert.equal(f.store.getAuthorizationRecovery(message())?.state, "cancelled");
});

test("expired authorization is reported once and late token completion is ignored", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const f = fixture(t);
  await f.auth.ensure(message(), request);
  t.mock.timers.tick(60_000); await flush();
  f.poll.resolve(tokens()); await flush();
  assert.equal(f.store.getAuthorizationRecovery(message())?.state, "expired");
  assert.equal(f.notices.length, 1); assert.match(f.notices[0], /超时|过期/);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.resumed, []);
});

test("denied authorization notifies the user and finishes every joined request", async t => {
  const poll = deferred<OAuthTokens>();
  const f = fixture(t, { poll: async () => { await poll.promise; throw new OAuthError("denied"); } });
  f.store.startAuthorizationRecovery(message("m2"), "original");
  await f.auth.ensure(message(), request); await f.auth.ensure(message("m2"), request);
  poll.resolve(tokens()); await flush();
  assert.equal(f.notices.length, 1); assert.match(f.notices[0], /拒绝/);
  assert.equal(f.store.getAuthorizationRecovery(message())?.state, "failed");
  assert.equal(f.store.getAuthorizationRecovery(message("m2"))?.state, "failed");
});

test("old cancelled completion cannot delete a replacement flow", async t => {
  const old = deferred<OAuthTokens>(), next = deferred<OAuthTokens>(); let count = 0;
  const f = fixture(t, { poll: () => ++count === 1 ? old.promise : next.promise });
  await f.auth.ensure(message(), request); f.auth.cancel(message());
  await f.auth.ensure(message("m2"), request);
  old.resolve(tokens()); await flush();
  assert.equal(f.auth.cancel(message("m2")), true);
  next.resolve(tokens()); await flush();
  assert.deepEqual(f.resumed, []); assert.deepEqual(f.writes, []);
});

test("close aborts outstanding work but preserves the durable recovery phase", async t => {
  const f = fixture(t);
  await f.auth.ensure(message(), request); f.auth.close();
  f.poll.resolve(tokens()); await flush();
  assert.deepEqual(f.resumed, []); assert.deepEqual(f.writes, []);
  assert.equal(f.store.getAuthorizationRecovery(message())?.state, "waiting");
  assert.equal(f.store.authorizations.get({ channelType: "lark", installationId: "cli", tenantId: "tenant", openId: "user" })?.phase, "waiting");
});

test("closing database during MA synchronization leaves no late resume or database access", async t => {
  const write = deferred<void>();
  const f = fixture(t, {}, () => write.promise);
  await f.auth.ensure(message(), request); f.poll.resolve(tokens()); await flush();
  assert.equal(f.writes.length, 1);
  f.auth.close(); f.store.close(); write.resolve(); await flush();
  assert.deepEqual(f.resumed, []); assert.deepEqual(f.notices, []);
});

test("Gateway authorization cancel bypasses its busy scope queue and is deduplicated", async () => {
  const store = new GatewayStore(":memory:");
  const run = deferred<{ terminal: "idle"; messages: string[] }>();
  const replies: string[] = []; let cancelled = 0, runs = 0;
  const gateway = new Gateway(store, { createSession: async () => "s", run: async () => { runs++; return run.promise; } },
    async (_m, outbound) => { if (outbound.type === "text") replies.push(outbound.text); },
    { agentId: "a", environmentId: "e", vaultId: "v", timeoutMs: 1000, platformAccess: true,
      cancelAuthorization: () => { cancelled++; return true; } });
  gateway.accept(message()); await flush();
  const cancel = { ...message("cancel"), text: "/auth cancel" };
  assert.equal(gateway.accept(cancel), true); assert.equal(gateway.accept(cancel), false);
  await flush();
  assert.equal(cancelled, 1); assert.equal(runs, 1);
  assert.ok(replies.some(text => text.includes("不等于撤销")));
  run.resolve({ terminal: "idle", messages: ["完成"] }); await flush(); store.close();
});

test("cancelled and expired recovery checkpoints survive reopening and reject late callbacks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "arkagent-auth-lifecycle-"));
  const path = join(directory, "gateway.db");
  let store = new GatewayStore(path);
  try {
    for (const state of ["cancelled", "expired"] as const) {
      store.startAuthorizationRecovery(message(state), "original");
      store.finishAuthorizationRecovery(message(state), state);
    }
    store.close(); store = new GatewayStore(path);
    let runs = 0;
    const gateway = new Gateway(store, { createSession: async () => { throw new Error("must not create"); },
      run: async () => { runs++; return { terminal: "idle", messages: [] }; } }, async () => undefined,
    { agentId: "a", environmentId: "e", vaultId: "v", timeoutMs: 1000, platformAccess: true });
    for (const state of ["cancelled", "expired"] as const) {
      assert.equal(store.getAuthorizationRecovery(message(state))?.state, state);
      gateway.resumeAfterAuthorization(message(state), "user-vault");
    }
    await flush(); assert.equal(runs, 0);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Gateway and real OAuth client cancel the whole mocked chain without replaying a late token", async () => {
  const store = new GatewayStore(":memory:");
  const response = deferred<Response>(), polling = deferred<void>(), card = deferred<void>();
  let creates = 0, runs = 0, updates = 0, exchanges = 0;
  const removed: string[] = [], replies: string[] = [];
  let gateway: Gateway;
  const ark = {
    listVaults: async () => [], createVault: async () => "user-vault", listCredentials: async () => [],
    createEnvironmentVariableCredential: async () => "user-credential", updateEnvironmentCredential: async () => { updates++; },
    createSession: async () => { creates++; return "original"; },
    run: async () => { runs++; return { terminal: "idle" as const, messages: [], authorizationRequired: request }; }
  };
  const oauth = new FeishuOAuth("cli", "secret", async (url) => {
    if (String(url).includes("device_authorization")) return new Response(JSON.stringify({
      device_code: "device", verification_uri_complete: "https://example.test/auth", expires_in: 600, interval: 5
    }));
    if (String(url).includes("/oauth/token")) { exchanges++; polling.resolve(); return response.promise; }
    throw new Error("取消后不能校验或使用迟到Token");
  });
  const auth = new EmployeeAuthorizationManager(store, ark, oauth, async () => { card.resolve(); },
    (m, vault) => gateway.resumeAfterAuthorization(m, vault));
  gateway = new Gateway(store, ark, async (_m, outbound) => { if (outbound.type === "text") replies.push(outbound.text); }, {
    agentId: "a", environmentId: "e", vaultId: "bot-vault", timeoutMs: 1000, platformAccess: true,
    getUserVaultIds: m => auth.vaultIds(m), ensureAuthorization: (m, r) => auth.ensure(m, r),
    cancelAuthorization: m => auth.cancel(m), addReaction: async m => m.messageId,
    removeReaction: async (_m, id) => { removed.push(id); }
  });
  try {
    gateway.accept(message()); await card.promise; await polling.promise; await flush();
    gateway.accept({ ...message("cancel"), text: "/auth cancel" }); await flush();
    // 模拟服务端已交换成功，即便本机取消也可能有迟到响应。
    response.resolve(new Response(JSON.stringify({ access_token: "late", refresh_token: "late-r", expires_in: 7200 })));
    await flush();
    assert.equal(store.getAuthorizationRecovery(message())?.state, "cancelled");
    assert.deepEqual({ creates, runs, updates, exchanges }, { creates: 1, runs: 1, updates: 0, exchanges: 1 });
    assert.deepEqual(removed, ["m1"]);
    assert.ok(replies.some(text => text.includes("已取消")));
  } finally { auth.close(); store.close(); }
});
