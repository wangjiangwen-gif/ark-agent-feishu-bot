import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EmployeeAuthorizationManager } from "../src/employee-auth.ts";
import { GatewayStore } from "../src/store.ts";
import { OAuthError } from "../src/oauth.ts";

const identity = { channelType: "lark", installationId: "cli", tenantId: "tenant", openId: "user" };
const message = { ...identity, senderId: identity.openId, conversationId: "chat", conversationType: "direct" as const,
  threadId: "", rootMessageId: "", parentMessageId: "", messageId: "m", eventId: "e", text: "查看日程",
  resources: [], createTime: 100, mentionedBot: false };
function fixture(t: any, refresh?: () => Promise<any>) {
  const store = new GatewayStore(":memory:");
  const calls = { list: 0, create: 0, refresh: 0, sync: 0 };
  const manager = new EmployeeAuthorizationManager(store, {
    listVaults: async () => { calls.list++; return []; },
    createVault: async () => { calls.create++; return "user-vault"; },
    listCredentials: async () => { calls.list++; return []; },
    createEnvironmentVariableCredential: async () => { calls.create++; return "credential"; },
    updateEnvironmentCredential: async () => { calls.sync++; }
  }, { applicationId: "cli", refresh: async () => { calls.refresh++; return refresh ? refresh() : {
    accessToken: "new-access", refreshToken: "new-refresh", expiresAt: Date.now() + 3600000, scopes: ["calendar:read"] }; } } as never,
  async () => assert.fail("不能发授权卡"), () => assert.fail("不能重放业务"));
  t.after(() => { manager.close(); store.close(); });
  return { store, manager, calls };
}
function ready(store: GatewayStore) { return store.credentials.save(identity, { vaultId: "user-vault", credentialId: "credential",
  status: "ready", expiresAt: Date.now() + 3600000, scopes: ["calendar:read"], refreshToken: "refresh" }, 0); }

test("capture freezes an unbound operation locally before any provisioning", t => {
  const { manager, store, calls } = fixture(t);
  const intent = manager.captureUserTurn(message);
  assert.equal(intent.kind, "provisioning");
  assert.deepEqual(intent.identity, identity);
  assert.equal(intent.flowId, null);
  assert.equal(store.credentialProvisioning.get(identity), undefined);
  assert.equal(manager.matchesUserTurnIntent(message, intent), true);
  assert.deepEqual(calls, { list: 0, create: 0, refresh: 0, sync: 0 });
  assert.doesNotMatch(JSON.stringify(intent), /Token|AUTH_PENDING|refresh/);
});

test("first preparation follows the captured operation and atomically records the initial generation", async t => {
  const { manager, store, calls } = fixture(t);
  const intent = manager.captureUserTurn(message);
  const proof = await manager.prepareUserTurn(message, intent);
  const journal = store.credentialProvisioning.get(identity)!;
  assert.equal(journal.operationId, intent.kind === "provisioning" ? intent.operationId : "wrong");
  assert.equal(journal.initialAuthorizationGeneration, proof.generation);
  assert.equal(manager.matchesUserTurnIntent(message, intent), true);
  assert.deepEqual(await manager.recoverUserTurn(message, intent), proof);
  assert.deepEqual(calls, { list: 2, create: 2, refresh: 0, sync: 0 });
});

test("a capture before journal persistence resumes only the original operation", async t => {
  const { manager, store } = fixture(t);
  const intent = structuredClone(manager.captureUserTurn(message));
  const proof = await manager.recoverUserTurn(message, intent);
  assert.equal(store.credentialProvisioning.get(identity)?.operationId, intent.kind === "provisioning" ? intent.operationId : "wrong");
  assert.equal(manager.matchesPreparedAuthorization(message, proof, true), true);
});

test("bound capture reuses its exact authorization generation through normal refresh", async t => {
  const { manager, store, calls } = fixture(t); const state = ready(store);
  store.credentials.save(identity, { ...state, expiresAt: 1 }, state.revision);
  const intent = manager.captureUserTurn(message);
  assert.equal(intent.kind, "bound");
  const proof = await manager.recoverUserTurn(message, intent);
  assert.equal(proof.generation, state.authorizationGeneration);
  assert.deepEqual(calls, { list: 0, create: 0, refresh: 1, sync: 1 });
});

test("persisted token synchronization resumes without another token exchange", async t => {
  const { manager, store, calls } = fixture(t); const state = ready(store);
  const intent = manager.captureUserTurn(message);
  store.credentials.save(identity, { ...state, status: "sync_pending", pendingAccessToken: "saved-access" }, state.revision);
  const proof = await manager.recoverUserTurn(message, intent);
  assert.equal(proof.generation, state.authorizationGeneration);
  assert.deepEqual(calls, { list: 0, create: 0, refresh: 0, sync: 1 });
});

for (const mode of ["bound", "provisioning"] as const) {
  for (const change of ["flow", "cancelled-flow", "identity", "group", "closed", "generation", "binding", "scope", "refreshing", "refresh_uncertain"] as const) {
    test(`${mode} intent rejects ${change} before remote activity`, async t => {
      const { manager, store, calls } = fixture(t);
      if (mode === "bound") ready(store);
      const intent = manager.captureUserTurn(message);
      if (mode === "provisioning") await manager.prepareUserTurn(message, intent);
      const baseline = { ...calls };
      let incoming = message;
      if (change === "identity") incoming = { ...message, senderId: "other" };
      if (change === "group") incoming = { ...message, conversationType: "group" } as typeof message;
      if (change === "closed") manager.close();
      if (change === "flow" || change === "cancelled-flow") {
        const flow = store.authorizations.create(identity, [message]);
        if (change === "cancelled-flow") store.authorizations.save(identity, flow, { phase: "cancelled" });
      }
      if (["generation", "binding", "scope", "refreshing", "refresh_uncertain"].includes(change)) {
        const state = store.credentials.get(identity)!;
        store.credentials.save(identity, { ...state,
          ...(change === "binding" ? { vaultId: "new-vault", credentialId: "new-credential" } : {}),
          ...(change === "scope" ? { scopes: ["new-scope"] } : {}),
          ...(change === "refreshing" || change === "refresh_uncertain" ? { status: change } : {})
        }, state.revision, change === "generation");
      }
      assert.equal(manager.matchesUserTurnIntent(incoming, intent), false);
      await assert.rejects(manager.recoverUserTurn(incoming, intent));
      assert.deepEqual(calls, baseline);
    });
  }
}

test("unbound intent rejects a different in-flight provisioning operation", async t => {
  const { manager, store, calls } = fixture(t);
  const intent = manager.captureUserTurn(message);
  store.credentialProvisioning.begin(identity, randomUUID());
  assert.equal(manager.matchesUserTurnIntent(message, intent), false);
  await assert.rejects(manager.prepareUserTurn(message, intent));
  assert.deepEqual(calls, { list: 0, create: 0, refresh: 0, sync: 0 });
});

test("provisioning proof cannot adopt a later ready credential even with the same generation", async t => {
  const { manager, store, calls } = fixture(t);
  const intent = manager.captureUserTurn(message);
  await manager.prepareUserTurn(message, intent);
  const state = store.credentials.get(identity)!;
  store.credentials.save(identity, { ...state, status: "ready", refreshToken: "later", expiresAt: Date.now() + 3600000 }, state.revision);
  const baseline = { ...calls };
  assert.equal(manager.matchesUserTurnIntent(message, intent), false);
  await assert.rejects(manager.recoverUserTurn(message, intent));
  assert.deepEqual(calls, baseline);
});

test("confirmed token invalidation cannot generate a replacement proof for a frozen intent", async t => {
  const { manager, store } = fixture(t, async () => { throw new OAuthError("reauth_required", { outcome: "rejected" }); });
  const state = ready(store); store.credentials.save(identity, { ...state, expiresAt: 1 }, state.revision);
  const intent = manager.captureUserTurn(message);
  await assert.rejects(manager.prepareUserTurn(message, intent));
  assert.equal(store.credentials.get(identity)?.status, "reauth_required");
  assert.equal(manager.matchesUserTurnIntent(message, intent), false);
});

test("a new OAuth flow during preflight prevents provisioning", async t => {
  const { manager, store, calls } = fixture(t);
  const intent = manager.captureUserTurn(message);
  (manager as any).ark.listVaults = async () => { calls.list++; store.authorizations.create(identity, [message]); return []; };
  await assert.rejects(manager.prepareUserTurn(message, intent));
  assert.equal(store.credentialProvisioning.get(identity), undefined);
  assert.equal(calls.create, 0);
});
