import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { EmployeeAuthorizationManager } from "../src/employee-auth.ts";
import { GatewayStore } from "../src/store.ts";
import { FeishuOAuth } from "../src/oauth.ts";
import type { AuthorizationPhase } from "../src/authorization-state.ts";
import type { IncomingMessage } from "../src/gateway.ts";

const identity = { channelType: "lark", installationId: "cli", tenantId: "tenant", openId: "user" };
const message: IncomingMessage = { channelType: "lark", installationId: "cli", tenantId: "tenant", senderId: "user", conversationType: "direct",
  conversationId: "chat", threadId: "", rootMessageId: "", parentMessageId: "", eventId: "event", messageId: "message",
  text: "查看日程", resources: [], createTime: 1, mentionedBot: false };
const request = { identity: "user", errorType: "authentication", subtype: "token_missing", domain: "calendar" } as const;
const tokens = () => ({ accessToken: "persisted-access", refreshToken: "persisted-refresh", expiresAt: Date.now() + 600_000 });
const device = () => ({ deviceCode: "persisted-device", verificationUrl: "https://example.test/auth", expiresAt: Date.now() + 600_000, intervalMs: 1000 });
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "arkagent-auth-restart-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "gateway.db");
}
function seed(store: GatewayStore, phase: AuthorizationPhase) {
  store.startAuthorizationRecovery(message, "original");
  const flow = store.authorizations.create(identity, [message]);
  return store.authorizations.save(identity, flow, { phase, device: device(), tokens: tokens(), expiresAt: Date.now() + 600_000 });
}
function binding(store: GatewayStore, status: "ready" | "sync_pending" = "sync_pending") {
  store.credentials.save(identity, { vaultId: "vault", credentialId: "credential", status,
    refreshToken: tokens().refreshToken, pendingAccessToken: status === "sync_pending" ? tokens().accessToken : undefined,
    expiresAt: tokens().expiresAt, scopes: ["calendar:read"] }, 0);
}
function manager(store: GatewayStore, overrides: Record<string, unknown> = {}, write?: () => Promise<void>) {
  const notices: string[] = [], resumes: string[] = [], updates: string[] = [], cards: string[] = [];
  const auth = new EmployeeAuthorizationManager(store, {
    listVaults: async () => [], createVault: async () => "vault", listCredentials: async () => [],
    createEnvironmentVariableCredential: async () => "credential",
    updateEnvironmentCredential: async (_vault, _credential, accessToken) => { updates.push(accessToken); await write?.(); }
  }, { applicationId: "cli", begin: async () => { throw new Error("不得重新发起授权"); },
    poll: async () => { throw new Error("不得重复交换Token"); }, getUserIdentity: async () => ({ openId: "user", tenantKey: "tenant" }), ...overrides } as never,
  async () => { cards.push("card"); }, m => { if (store.claimAuthorizationRecovery(m)) resumes.push(m.messageId); },
  { notify: async (_m, text) => { notices.push(text); } });
  return { auth, notices, resumes, updates, cards };
}

test("confirmed pending device flow resumes polling after reopening without another card", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const path = fixture(t); let store = new GatewayStore(path); store.acquireRuntimeLock();
  store.startAuthorizationRecovery(message, "original");
  const firstClient = new FeishuOAuth("cli", "secret", async url => String(url).includes("device_authorization")
    ? new Response(JSON.stringify({ device_code: "device", verification_uri_complete: "https://example.test/auth", expires_in: 600, interval: 1 }))
    : new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }));
  const first = manager(store, { begin: firstClient.begin.bind(firstClient), poll: firstClient.poll.bind(firstClient) });
  await first.auth.ensure(message, request); await flush();
  assert.equal(store.authorizations.get(identity)?.phase, "waiting");
  assert.equal(store.authorizations.get(identity)?.nextPollAt, 11_000);
  first.auth.close(); store.close(); store = new GatewayStore(path); store.acquireRuntimeLock();
  let polls = 0;
  const nextClient = new FeishuOAuth("cli", "secret", async () => {
    polls++; return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200 }));
  });
  const second = manager(store, { poll: nextClient.poll.bind(nextClient) });
  try {
    assert.equal(second.auth.restore(), 1); assert.equal(second.auth.restore(), 0);
    t.mock.timers.tick(999); await flush(); assert.equal(polls, 0);
    t.mock.timers.tick(1); await flush();
    assert.equal(polls, 1); assert.deepEqual(second.cards, []);
    assert.deepEqual(second.resumes, ["message"]); assert.deepEqual(second.updates, ["new-access"]);
    assert.equal(store.authorizations.get(identity)?.phase, "completed");
  } finally { second.auth.close(); store.close(); }
});

test("in-flight exchanges and unknown card delivery are not retried on restart", async t => {
  const path = fixture(t);
  for (const phase of ["starting", "card_pending", "polling"] as const) {
    let store = new GatewayStore(path); seed(store, phase); store.close();
    store = new GatewayStore(path); store.acquireRuntimeLock(); const f = manager(store);
    try {
      assert.equal(f.auth.restore(), 1); await flush();
      assert.equal(store.authorizations.get(identity)?.phase, "uncertain");
      assert.equal(store.getAuthorizationRecovery(message)?.state, "blocked");
      assert.deepEqual(f.resumes, []); assert.deepEqual(f.cards, []); assert.deepEqual(f.updates, []);
      assert.equal(f.notices.length, 1); assert.match(f.notices[0], /未重复交换/);
    } finally { f.auth.close(); store.close(); }
  }
});

test("persisted unverified token is checked against identity before any MA write", async t => {
  for (const valid of [true, false]) {
    const path = fixture(t); let store = new GatewayStore(path); seed(store, "verifying"); store.close();
    store = new GatewayStore(path); store.acquireRuntimeLock();
    const f = manager(store, { getUserIdentity: async () => ({ openId: valid ? "user" : "wrong", tenantKey: "tenant" }) });
    try {
      f.auth.restore(); await flush();
      assert.deepEqual(f.updates, valid ? ["persisted-access"] : []);
      assert.deepEqual(f.resumes, valid ? ["message"] : []);
      assert.equal(store.authorizations.get(identity)?.phase, valid ? "completed" : "failed");
    } finally { f.auth.close(); store.close(); }
  }
});

test("MA synchronization failure is durable and restart only retries the same credential value", async t => {
  const path = fixture(t); let store = new GatewayStore(path); store.acquireRuntimeLock(); seed(store, "sync_pending"); binding(store);
  const first = manager(store, {}, async () => { throw new Error("MA unavailable"); });
  first.auth.restore(); await flush();
  assert.equal(store.authorizations.get(identity)?.phase, "sync_pending");
  assert.equal(store.getAuthorizationRecovery(message)?.state, "waiting");
  assert.deepEqual(first.resumes, []);
  first.auth.close(); store.close(); store = new GatewayStore(path); store.acquireRuntimeLock();
  const second = manager(store);
  try {
    second.auth.restore(); await flush();
    assert.deepEqual(second.updates, ["persisted-access"]); assert.deepEqual(second.resumes, ["message"]);
    assert.equal(store.authorizations.get(identity)?.phase, "completed");
  } finally { second.auth.close(); store.close(); }
});

test("already claimed business recovery is not dispatched again after authorization restart", async t => {
  const path = fixture(t); let store = new GatewayStore(path); seed(store, "ready"); binding(store, "ready");
  store.claimAuthorizationRecovery(message); store.close();
  store = new GatewayStore(path); store.acquireRuntimeLock(); const f = manager(store);
  try {
    f.auth.restore(); await flush();
    assert.deepEqual(f.resumes, []); assert.deepEqual(f.updates, []);
    assert.equal(f.notices.length, 1); assert.match(f.notices[0], /结果尚未确认/);
  } finally { f.auth.close(); store.close(); }
});

test("restore requires the runtime lock and leaves other applications untouched", async () => {
  const store = new GatewayStore(":memory:");
  const other = { ...identity, installationId: "other" };
  store.authorizations.create(other, [{ ...message, installationId: "other" }]);
  const f = manager(store);
  try {
    assert.throws(() => f.auth.restore(), /运行锁/);
    store.acquireRuntimeLock(); assert.equal(f.auth.restore(), 0);
    assert.equal(store.authorizations.get(other)?.phase, "starting");
  } finally { f.auth.close(); store.close(); }
});

test("expired flow on restart does not poll or create a card", async t => {
  const path = fixture(t); let store = new GatewayStore(path);
  const flow = seed(store, "waiting"); store.authorizations.save(identity, flow, { expiresAt: 1 }); store.close();
  store = new GatewayStore(path); store.acquireRuntimeLock(); const f = manager(store);
  try {
    f.auth.restore(); await flush();
    assert.equal(store.authorizations.get(identity)?.phase, "expired");
    assert.deepEqual(f.resumes, []); assert.deepEqual(f.cards, []); assert.equal(f.notices.length, 1);
  } finally { f.auth.close(); store.close(); }
});

test("a real exited process leaves a recoverable waiting flow and its runtime lock is reclaimed", async t => {
  const path = fixture(t);
  const child = `
    import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    import { EmployeeAuthorizationManager } from ${JSON.stringify(new URL("../src/employee-auth.ts", import.meta.url).href)};
    import { FeishuOAuth } from ${JSON.stringify(new URL("../src/oauth.ts", import.meta.url).href)};
    const store = new GatewayStore(${JSON.stringify(path)}); store.acquireRuntimeLock();
    const message = ${JSON.stringify(message)};
    store.startAuthorizationRecovery(message, "original");
    const oauth = new FeishuOAuth("cli", "secret", async url => String(url).includes("device_authorization")
      ? new Response(JSON.stringify({ device_code: "device", verification_uri_complete: "https://example.test/auth", expires_in: 600, interval: 1 }))
      : new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }));
    const auth = new EmployeeAuthorizationManager(store, {}, oauth, async () => {}, () => {});
    await auth.ensure(message, ${JSON.stringify(request)});
    await new Promise(resolve => setImmediate(resolve));
    if (store.authorizations.get(${JSON.stringify(identity)}).phase !== "waiting") process.exit(2);
    process.exit(0);
  `;
  execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", child], { timeout: 5000, stdio: "pipe" });
  const store = new GatewayStore(path); store.acquireRuntimeLock();
  const f = manager(store, { poll: async () => tokens() });
  try {
    assert.equal(f.auth.restore(), 1); await flush();
    assert.deepEqual(f.resumes, ["message"]); assert.deepEqual(f.cards, []);
    assert.equal(store.getAuthorizationRecovery(message)?.sessionId, "original");
  } finally { f.auth.close(); store.close(); }
});

test("detached MA sync failure can still be cancelled from its persisted flow", async t => {
  const path = fixture(t); const store = new GatewayStore(path); store.acquireRuntimeLock(); seed(store, "sync_pending"); binding(store);
  const f = manager(store, {}, async () => { throw new Error("failed"); });
  try {
    f.auth.restore(); await flush(); assert.equal(f.auth.cancel(message), true);
    assert.equal(store.authorizations.get(identity)?.phase, "cancelled");
    assert.equal(store.getAuthorizationRecovery(message)?.state, "cancelled");
    assert.equal(f.auth.restore(), 0);
  } finally { f.auth.close(); store.close(); }
});

test("expired pending access token refreshes the persisted rotated token on restart", async t => {
  const path = fixture(t); const store = new GatewayStore(path); store.acquireRuntimeLock();
  let flow = seed(store, "sync_pending"); flow = store.authorizations.save(identity, flow, { expiresAt: 1 });
  store.credentials.save(identity, { vaultId: "vault", credentialId: "credential", status: "sync_pending",
    pendingAccessToken: "expired-access", refreshToken: "rotated-refresh", expiresAt: 1, scopes: ["calendar:read"] }, 0);
  const refreshes: string[] = [];
  const f = manager(store, { refresh: async token => { refreshes.push(token); return tokens(); } });
  try {
    f.auth.restore(); await flush();
    assert.deepEqual(refreshes, ["rotated-refresh"]);
    assert.deepEqual(f.updates, ["persisted-access"]); assert.deepEqual(f.resumes, ["message"]);
    assert.equal(store.authorizations.get(identity)?.phase, "completed");
  } finally { f.auth.close(); store.close(); }
});

test("restoring identity verification preserves the original short expiry", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock();
  const flow = seed(store, "verifying");
  store.authorizations.save(identity, flow, { expiresAt: 11_000, tokens: { ...tokens(), expiresAt: 11_000 } });
  let resolveIdentity!: (value: { openId: string; tenantKey: string }) => void;
  const f = manager(store, { getUserIdentity: () => new Promise(resolve => { resolveIdentity = resolve; }) });
  try {
    f.auth.restore(); await flush();
    t.mock.timers.tick(1000); await flush();
    assert.equal(store.authorizations.get(identity)?.phase, "expired");
    resolveIdentity({ openId: "user", tenantKey: "tenant" }); await flush();
    assert.deepEqual(f.updates, []); assert.deepEqual(f.resumes, []);
  } finally { f.auth.close(); store.close(); }
});
