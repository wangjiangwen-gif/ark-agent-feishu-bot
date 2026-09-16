import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { EmployeeAuthorizationManager } from "../src/employee-auth.ts";
import { Gateway, toConversationKey, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import type { PreparedAuthorization, UserCredentialLifecycle } from "../src/prepared-authorization.ts";

const identity = { channelType: "lark", installationId: "cli-boundary", tenantId: "tenant", openId: "alice" };
const incoming = (): IncomingMessage => ({ ...identity, senderId: identity.openId, conversationId: "direct-chat", conversationType: "direct",
  threadId: "", rootMessageId: "", parentMessageId: "", messageId: "message", eventId: "event", text: "处理原任务",
  createTime: 100, resources: [], mentionedBot: false });
const stamp: PreparedAuthorization = { version: 1, identity, generation: "10000000-0000-4000-8000-000000000001",
  vaultId: "alice-vault", credentialId: "alice-credential", flowId: null };
const finished = { terminal: "idle" as const, messages: ["完成"] };
const options = { agentId: "agent", environmentId: "env", vaultId: "bot-vault", appId: identity.installationId,
  platformAccess: true, sharedGroupSessions: true, dualIdentity: true, timeoutMs: 1000, progressDelayMs: 60000 };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(yes => { release = yes; });
  return { promise, release };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await flush();
  assert.ok(check(), "测试必须等待原任务真正完成处理");
}
function provider(overrides: Partial<UserCredentialLifecycle> = {}): UserCredentialLifecycle {
  return { revision: "test-v1", prepare: async () => structuredClone(stamp), refresh: async () => {}, matches: () => true, ...overrides };
}
function authFixture(t: { after: (callback: () => void) => void }, hooks: { list?: () => Promise<unknown>; refresh?: () => Promise<unknown> } = {}) {
  const store = new GatewayStore(":memory:");
  const counts = { provisioning: 0, refresh: 0, sync: 0 };
  const manager = new EmployeeAuthorizationManager(store, {
    listVaults: async () => { counts.provisioning++; await hooks.list?.(); return []; }, createVault: async () => "alice-vault",
    listCredentials: async () => [], createEnvironmentVariableCredential: async () => "alice-credential",
    updateEnvironmentCredential: async () => { counts.sync++; }
  }, { applicationId: identity.installationId, refresh: async () => { counts.refresh++; await hooks.refresh?.(); return {
    accessToken: "access", refreshToken: "rotated-refresh", expiresAt: Date.now() + 3600000, scopes: ["calendar:read"] }; } } as never,
  async () => assert.fail("此测试不得发送卡片"), () => assert.fail("此测试不得恢复业务"));
  t.after(() => { manager.close(); store.close(); });
  return { store, manager, counts };
}
function ready(store: GatewayStore) {
  return store.credentials.save(identity, { vaultId: "alice-vault", credentialId: "alice-credential", status: "ready",
    scopes: ["calendar:read"], expiresAt: Date.now() + 3600000, refreshToken: "refresh" }, 0);
}

for (const terminal of [false, true]) test(`first binding detects an OAuth flow started during preparation${terminal ? " even after cancellation" : ""}`, async t => {
  const entered = gate(), proceed = gate();
  const { store, manager } = authFixture(t, { list: async () => { entered.release(); await proceed.promise; } });
  const preparation = manager.prepareUserTurn(incoming());
  await entered.promise;
  const flow = store.authorizations.create(identity, [{ ...incoming(), conversationId: "other-direct", messageId: "authorize" }]);
  if (terminal) store.finishAuthorizationFlow(flow, "cancelled");
  proceed.release();
  await assert.rejects(preparation, /授权/);
});

test("fresh preparation cannot silently adopt a newly cancelled OAuth flow during token refresh", async t => {
  const entered = gate(), proceed = gate();
  const { store, manager } = authFixture(t, { refresh: async () => { entered.release(); await proceed.promise; } });
  const state = ready(store); store.credentials.save(identity, { ...state, expiresAt: 1 }, state.revision);
  const preparation = manager.prepareUserTurn(incoming());
  await entered.promise;
  const flow = store.authorizations.create(identity, [{ ...incoming(), messageId: "authorize" }]);
  store.finishAuthorizationFlow(flow, "cancelled"); proceed.release();
  await assert.rejects(preparation, /授权/);
});

test("prepared refresh rejects a new cancelled flow without changing the original proof", async t => {
  const entered = gate(), proceed = gate();
  const { store, manager } = authFixture(t, { refresh: async () => { entered.release(); await proceed.promise; } });
  ready(store); const proof = await manager.prepareUserTurn(incoming()), before = structuredClone(proof);
  const state = store.credentials.get(identity)!; store.credentials.save(identity, { ...state, expiresAt: 1 }, state.revision);
  const refresh = manager.refreshPreparedAuthorization(incoming(), proof); await entered.promise;
  const flow = store.authorizations.create(identity, [{ ...incoming(), messageId: "authorize" }]);
  store.finishAuthorizationFlow(flow, "cancelled"); proceed.release();
  await assert.rejects(refresh, /授权/);
  assert.deepEqual(proof, before);
});

test("an asynchronous false lifecycle matcher must not authorize model dispatch", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  let posts = 0, replies = 0;
  const lifecycle = provider({ matches: (async () => false) as never });
  const gateway = new Gateway(store, { createSession: async () => "session", run: async (_id, _input, _timeout, _progress, _update, guard) => {
    guard?.(); posts++; return finished; } }, async () => { replies++; }, { ...options, userCredentialLifecycle: lifecycle });
  gateway.accept(incoming()); await until(() => replies > 0);
  assert.equal(posts, 0);
});

for (const field of ["channelType", "installationId", "tenantId", "openId"] as const)
test(`gateway independently rejects a proof with mismatched ${field}`, async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  let posts = 0, replies = 0;
  const wrong = { ...stamp, identity: { ...identity, [field]: "other-identity" } };
  const gateway = new Gateway(store, { createSession: async () => "session", run: async (_id, _input, _timeout, _progress, _update, guard) => {
    guard?.(); posts++; return finished; } }, async () => { replies++; }, { ...options,
    userCredentialLifecycle: provider({ prepare: async () => wrong }) });
  gateway.accept(incoming()); await until(() => replies > 0);
  assert.equal(posts, 0);
});

test("a lifecycle matcher cannot mutate the queued message identity", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  let posts = 0, replies = 0;
  const message = incoming();
  const gateway = new Gateway(store, { createSession: async () => "session", run: async (_id, _input, _timeout, _progress, _update, guard) => {
    guard?.(); posts++; return finished; } }, async () => { replies++; }, { ...options,
    userCredentialLifecycle: provider({ matches: current => { current.senderId = "bob"; return true; } }) });
  gateway.accept(message); await until(() => replies > 0);
  assert.equal(message.senderId, "alice");
  assert.equal(store.getSession(toConversationKey(incoming(), true)), "session");
  assert.equal(store.getSession(toConversationKey({ ...incoming(), senderId: "bob" }, true)), undefined);
  assert.equal(posts, 1);
});

test("a provider-owned proof mutated after capture cannot upgrade an existing task authorization", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  let posts = 0, replies = 0;
  const shared = structuredClone(stamp);
  const gateway = new Gateway(store, { createSession: async () => {
    shared.generation = "20000000-0000-4000-8000-000000000002"; return "session";
  }, run: async (_id, _input, _timeout, _progress, _update, guard) => { guard?.(); posts++; return finished; } },
  async () => { replies++; }, { ...options, userCredentialLifecycle: provider({ prepare: async () => shared,
    matches: (_message, expected) => expected.generation === shared.generation }) });
  gateway.accept(incoming()); await until(() => replies > 0);
  assert.equal(posts, 0);
});

test("a lifecycle prepare callback cannot mutate the original message identity", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  let posts = 0, replies = 0;
  const message = incoming();
  const gateway = new Gateway(store, { createSession: async () => "session", run: async (_id, _input, _timeout, _progress, _update, guard) => {
    guard?.(); posts++; return finished; } }, async () => { replies++; }, { ...options,
    userCredentialLifecycle: provider({ prepare: async current => { current.senderId = "bob"; return structuredClone(stamp); } }) });
  gateway.accept(message); await until(() => replies > 0);
  assert.equal(message.senderId, "alice");
  assert.equal(store.getSession(toConversationKey({ ...incoming(), senderId: "bob" }, true)), undefined);
  assert.equal(posts, 1);
});

for (const status of ["expired", "sync_pending", "refresh_uncertain"] as const)
test(`a ${status} credential observed at the last send guard stops model dispatch`, async t => {
  const { store, manager } = authFixture(t); ready(store);
  let replies = 0, posts = 0, checks = 0;
  const gateway = new Gateway(store, { createSession: async () => "session", run: async (_id, _input, _timeout, _progress, _update, guard) => {
    const state = store.credentials.get(identity)!;
    store.credentials.save(identity, { ...state, ...(status === "expired" ? { expiresAt: 1 } : { status }) }, state.revision);
    checks++; guard?.(); posts++; return finished;
  } }, async () => { replies++; }, { ...options, userCredentialLifecycle: {
    revision: "manager-v1", prepare: message => manager.prepareUserTurn(message),
    refresh: (message, proof) => manager.refreshPreparedAuthorization(message, proof),
    matches: (message, proof, send) => manager.matchesPreparedAuthorization(message, proof, send)
  } });
  gateway.accept(incoming()); await until(() => replies > 0);
  assert.equal(checks, 1); assert.equal(posts, 0);
});

test("an old Bot-only direct Session remains usable without silently creating another Session", async t => {
  const { store, manager } = authFixture(t); ready(store);
  const message = incoming(); store.saveSession(toConversationKey(message, true), "legacy-bot-session", "agent", undefined, ["bot-vault"]);
  let replies = 0, posts = 0;
  const gateway = new Gateway(store, { createSession: async () => assert.fail("旧Session不得自动替换"),
    run: async (id, _input, _timeout, _progress, _update, guard) => { guard?.(); assert.equal(id, "legacy-bot-session"); posts++; return finished; }
  }, async () => { replies++; }, { ...options, userCredentialLifecycle: {
    revision: "manager-v1", prepare: value => manager.prepareUserTurn(value),
    refresh: (value, proof) => manager.refreshPreparedAuthorization(value, proof),
    matches: (value, proof, send) => manager.matchesPreparedAuthorization(value, proof, send)
  } });
  gateway.accept(message); await until(() => replies > 0); assert.equal(posts, 1);
  assert.deepEqual(store.getSessionVaultIds(toConversationKey(message, true)), ["bot-vault"]);
});

for (const changed of ["user", "group"] as const)
test(`ready checkpoint rejects ${changed === "user" ? "another user's" : "a group's personal"} authorization proof`, t => {
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock(); t.after(() => store.close());
  const message = { ...incoming(), ...(changed === "group" ? { conversationType: "group" as const, mentionedBot: true } : {}) };
  const binding = { scope: store.conversationKey(toConversationKey(message, true)), agentId: "agent", configFingerprint: "a".repeat(64) };
  const task = store.receiveMessage(message, binding)!; store.inbox.claim(task.id, binding);
  const wrong = changed === "user" ? { ...stamp, identity: { ...identity, openId: "bob" } } : stamp;
  assert.throws(() => store.inbox.prepare(task.id, { sessionId: "session", input: "原始任务", notices: [], contextReceipts: [],
    userAuthorization: wrong }), /授权|身份|准备/);
  assert.equal(store.inbox.findTask(task.id)?.preparation, undefined);
});

for (const changed of ["user", "extra-secret", "generation", "identity-null"] as const)
test(`reading an authenticated ready proof rejects ${changed} corruption`, t => {
  const dir = mkdtempSync(join(tmpdir(), "ark-auth-ready-boundary-")), path = join(dir, "gateway.db");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new GatewayStore(path); store.acquireRuntimeLock(); t.after(() => store.close());
  const message = incoming(), binding = { scope: store.conversationKey(toConversationKey(message, true)), agentId: "agent", configFingerprint: "a".repeat(64) };
  const task = store.receiveMessage(message, binding)!; store.inbox.claim(task.id, binding);
  store.inbox.prepare(task.id, { sessionId: "session", input: "原任务", notices: [], contextReceipts: [], userAuthorization: stamp });
  assert.equal(readFileSync(path).includes(Buffer.from(stamp.generation)), false);
  const db = new DatabaseSync(path); t.after(() => db.close());
  const row = db.prepare("SELECT * FROM gateway_message_inbox WHERE id = ?").get(task.id)!;
  const context = JSON.stringify(["message-inbox", row.sequence, row.id, row.event_key, row.channel_type, row.installation_id,
    row.scope, row.agent_id, row.config_fingerprint, row.state, row.owner, row.revision,
    row.session_id, row.request_fingerprint, row.interrupted_at]);
  const payload = JSON.parse(store.credentials.openAuthorization(String(row.secret), context));
  const proof = payload.preparation.userAuthorization;
  if (changed === "user") proof.identity.openId = "bob";
  if (changed === "extra-secret") proof.accessToken = "forbidden-secret";
  if (changed === "generation") proof.generation = "invalid";
  if (changed === "identity-null") proof.identity = null;
  db.prepare("UPDATE gateway_message_inbox SET secret = ? WHERE id = ?").run(
    store.credentials.sealAuthorization(JSON.stringify(payload), context), task.id);
  assert.throws(() => store.inbox.findTask(task.id), /授权|身份|准备|损坏|格式/);
});

test("an encrypted ready proof survives a different process without changing identity or generation", t => {
  const dir = mkdtempSync(join(tmpdir(), "ark-auth-ready-process-")), path = join(dir, "gateway.db");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new GatewayStore(path); store.acquireRuntimeLock();
  const message = incoming(), binding = { scope: store.conversationKey(toConversationKey(message, true)), agentId: "agent", configFingerprint: "a".repeat(64) };
  const task = store.receiveMessage(message, binding)!; store.inbox.claim(task.id, binding);
  store.inbox.prepare(task.id, { sessionId: "session", input: "原任务", notices: [], contextReceipts: [], userAuthorization: stamp });
  store.close();
  assert.equal(readFileSync(path).includes(Buffer.from(stamp.generation)), false);
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    const store = new GatewayStore(${JSON.stringify(path)}); store.acquireRuntimeLock();
    try {
      const proof = store.inbox.findTask(${JSON.stringify(task.id)}).preparation.userAuthorization;
      assert.deepEqual(proof, ${JSON.stringify(stamp)});
      console.log('proof-verified');
    } finally { store.close(); }
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "proof-verified");
});
