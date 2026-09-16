import test from "node:test";
import assert from "node:assert/strict";
import { EmployeeAuthorizationManager } from "../src/employee-auth.ts";
import { GatewayStore } from "../src/store.ts";
import { OAuthError } from "../src/oauth.ts";
import { validatePreparedAuthorization } from "../src/prepared-authorization.ts";

const identity = { channelType: "lark", installationId: "cli", tenantId: "tenant", openId: "user" };
const message = { channelType: "lark", installationId: "cli", tenantId: "tenant", senderId: "user", conversationId: "chat",
  conversationType: "direct" as const, threadId: "", rootMessageId: "", parentMessageId: "", messageId: "m", eventId: "e",
  text: "查看日程", resources: [], createTime: 100, mentionedBot: false };
function fixture(t: any, refresh?: () => Promise<any>) {
  const store = new GatewayStore(":memory:");
  const calls = { create: 0, refresh: 0, sync: 0 };
  const manager = new EmployeeAuthorizationManager(store, {
    listVaults: async () => [], createVault: async () => { calls.create++; return "user-vault"; }, listCredentials: async () => [],
    createEnvironmentVariableCredential: async () => { calls.create++; return "credential"; },
    updateEnvironmentCredential: async () => { calls.sync++; }
  }, { applicationId: "cli", refresh: async () => { calls.refresh++; return refresh ? refresh() : {
    accessToken: "new-access", refreshToken: "new-refresh", expiresAt: Date.now() + 3600000, scopes: ["calendar:read"] }; } } as never,
  async () => assert.fail("不应发授权卡"), () => assert.fail("不应重放业务"));
  t.after(() => { manager.close(); store.close(); });
  return { store, manager, calls };
}
function ready(store: GatewayStore) { return store.credentials.save(identity, { vaultId: "user-vault", credentialId: "credential",
  status: "ready", expiresAt: Date.now() + 3600000, scopes: ["calendar:read"], refreshToken: "refresh" }, 0); }

test("user preparation freezes verified binding without exposing tokens", async t => {
  const { manager, calls } = fixture(t);
  const proof = await manager.prepareUserTurn(message);
  validatePreparedAuthorization(proof);
  assert.deepEqual(proof.identity, identity);
  assert.equal(proof.vaultId, "user-vault");
  assert.equal(proof.flowId, null);
  assert.equal(manager.matchesPreparedAuthorization(message, proof), true);
  assert.deepEqual(calls, { create: 2, refresh: 0, sync: 0 });
  assert.doesNotMatch(JSON.stringify(proof), /Token|AUTH_PENDING|refresh/);
});

test("prepared credential refresh keeps authorization generation and uses no provisioning", async t => {
  const { manager, store, calls } = fixture(t); ready(store);
  const proof = await manager.prepareUserTurn(message);
  const state = store.credentials.get(identity)!;
  store.credentials.save(identity, { ...state, expiresAt: 1 }, state.revision);
  await manager.refreshPreparedAuthorization(message, proof);
  assert.equal(manager.matchesPreparedAuthorization(message, proof), true);
  assert.equal(store.credentials.get(identity)?.authorizationGeneration, proof.generation);
  assert.deepEqual(calls, { create: 0, refresh: 1, sync: 1 });
});

for (const change of ["application", "tenant", "user", "generation", "vault", "scope", "flow", "active-flow"] as const) {
  test(`prepared authorization rejects changed ${change} before credential writes`, async t => {
    const { manager, store, calls } = fixture(t); ready(store);
    const flow = change === "active-flow" ? store.authorizations.create(identity, [message]) : undefined;
    if (flow) store.authorizations.save(identity, flow, { phase: "cancelled" });
    const proof = await manager.prepareUserTurn(message);
    let incoming = message;
    if (change === "application") incoming = { ...message, installationId: "another" };
    if (change === "tenant") incoming = { ...message, tenantId: "another" };
    if (change === "user") incoming = { ...message, senderId: "another" };
    if (["generation", "vault", "scope"].includes(change)) {
      const state = store.credentials.get(identity)!;
      store.credentials.save(identity, { ...state, ...(change === "vault" ? { vaultId: "replacement" } : {}),
        ...(change === "scope" ? { scopes: [] } : {}) }, state.revision, change === "generation");
    }
    if (change === "flow" || change === "active-flow") store.authorizations.create(identity, [{ ...message, messageId: "new-flow" }]);
    assert.equal(manager.matchesPreparedAuthorization(incoming, proof), false);
    await assert.rejects(manager.refreshPreparedAuthorization(incoming, proof));
    assert.deepEqual(calls, { create: 0, refresh: 0, sync: 0 });
  });
}

test("active authorization blocks fresh preparation in another direct conversation", async t => {
  const { manager, store, calls } = fixture(t); ready(store);
  store.authorizations.create(identity, [message]);
  await assert.rejects(manager.prepareUserTurn({ ...message, conversationId: "other-chat" }), /授权/);
  assert.deepEqual(calls, { create: 0, refresh: 0, sync: 0 });
});

test("refresh invalidation rotates generation and stops old prepared work", async t => {
  const { manager, store } = fixture(t, async () => { throw new OAuthError("reauth_required", { outcome: "rejected" }); });
  ready(store); const proof = await manager.prepareUserTurn(message);
  const state = store.credentials.get(identity)!; store.credentials.save(identity, { ...state, expiresAt: 1 }, state.revision);
  await assert.rejects(manager.refreshPreparedAuthorization(message, proof), /授权/);
  assert.equal(store.credentials.get(identity)?.status, "reauth_required");
  assert.notEqual(store.credentials.get(identity)?.authorizationGeneration, proof.generation);
});

test("fresh user input still reaches the Bot-only authorization path after confirmed token invalidation", async t => {
  const { manager, store, calls } = fixture(t, async () => { throw new OAuthError("reauth_required", { outcome: "rejected" }); });
  const state = ready(store); store.credentials.save(identity, { ...state, expiresAt: 1 }, state.revision);
  const proof = await manager.prepareUserTurn(message);
  assert.equal(store.credentials.get(identity)?.status, "reauth_required");
  assert.equal(manager.matchesPreparedAuthorization(message, proof, true), true);
  assert.deepEqual(calls, { create: 0, refresh: 1, sync: 1 });
});

test("OAuth credential staging changes authorization generation atomically", async t => {
  const { manager, store } = fixture(t); ready(store); const proof = await manager.prepareUserTurn(message);
  let flow = store.authorizations.create(identity, [message]);
  flow = store.authorizations.save(identity, flow, { phase: "verifying" });
  store.stageAuthorizationCredential(flow, { accessToken: "oauth-access", refreshToken: "oauth-refresh", expiresAt: Date.now() + 3600000 }, ["calendar:read"]);
  assert.notEqual(store.credentials.get(identity)?.authorizationGeneration, proof.generation);
  assert.equal(manager.matchesPreparedAuthorization(message, proof), false);
});

test("unknown token refresh remains stopped without another OAuth exchange", async t => {
  const { manager, store, calls } = fixture(t); ready(store); const proof = await manager.prepareUserTurn(message);
  const state = store.credentials.get(identity)!;
  store.credentials.save(identity, { ...state, status: "refresh_uncertain" }, state.revision);
  await assert.rejects(manager.refreshPreparedAuthorization(message, proof));
  assert.equal(calls.refresh, 0);
});

test("pending credential synchronization resumes with the exact rotated value", async t => {
  const { manager, store, calls } = fixture(t); ready(store); const proof = await manager.prepareUserTurn(message);
  const state = store.credentials.get(identity)!;
  store.credentials.save(identity, { ...state, status: "sync_pending", pendingAccessToken: "rotated-access" }, state.revision);
  await manager.refreshPreparedAuthorization(message, proof);
  assert.equal(store.credentials.get(identity)?.status, "ready");
  assert.deepEqual(calls, { create: 0, refresh: 0, sync: 1 });
});

test("group messages cannot capture or refresh a personal credential", async t => {
  const { manager, store, calls } = fixture(t); ready(store); const proof = await manager.prepareUserTurn(message);
  const group = { ...message, conversationType: "group" as const };
  await assert.rejects(manager.prepareUserTurn(group));
  await assert.rejects(manager.refreshPreparedAuthorization(group, proof));
  assert.equal(manager.matchesPreparedAuthorization(group, proof), false);
  assert.deepEqual(calls, { create: 0, refresh: 0, sync: 0 });
});

test("fresh preparation cannot adopt an OAuth flow started and cancelled during token maintenance", async t => {
  let store: GatewayStore;
  const setup = fixture(t, async () => {
    const flow = store.authorizations.create(identity, [message]);
    store.authorizations.save(identity, flow, { phase: "cancelled" });
    return { accessToken: "new", refreshToken: "new", expiresAt: Date.now() + 3600000 };
  });
  store = setup.store;
  const state = ready(store); store.credentials.save(identity, { ...state, expiresAt: 1 }, state.revision);
  await assert.rejects(setup.manager.prepareUserTurn(message), /授权/);
});

test("already bound user preparation uses one credential lease and concurrent turns refresh only once", async t => {
  const { manager, store, calls } = fixture(t); const state = ready(store);
  store.credentials.save(identity, { ...state, expiresAt: 1 }, state.revision);
  let leases = 0; const acquire = store.credentials.acquire.bind(store.credentials);
  store.credentials.acquire = (...args) => { leases++; return acquire(...args); };
  const proofs = await Promise.all([manager.prepareUserTurn(message), manager.prepareUserTurn({ ...message, messageId: "second" })]);
  assert.equal(leases, 2, "每轮只领取一次身份维护租约，不能重复空事务");
  assert.deepEqual(proofs[0], proofs[1]);
  assert.deepEqual(calls, { create: 0, refresh: 1, sync: 1 });
});

test("authorization changed while waiting for the credential lease does not refresh the replacement", async t => {
  const { manager, store, calls } = fixture(t); const state = ready(store);
  store.credentials.save(identity, { ...state, expiresAt: 1 }, state.revision);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const holder = (manager as any).exclusive(identity, () => pending);
  const attempted = assert.rejects(manager.prepareUserTurn(message), /授权/);
  const flow = store.authorizations.create(identity, [message]);
  store.authorizations.save(identity, flow, { phase: "cancelled" });
  release(); await holder; await attempted;
  assert.deepEqual(calls, { create: 0, refresh: 0, sync: 0 });
});
