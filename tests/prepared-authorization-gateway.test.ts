import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { Gateway, toConversationKey, type GatewayOptions, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import type { PreparedAuthorization, UserCredentialLifecycle } from "../src/prepared-authorization.ts";
import { EmployeeAuthorizationManager } from "../src/employee-auth.ts";

const options: GatewayOptions = { agentId: "agent", environmentId: "env", vaultId: "bot-vault", appId: "cli",
  platformAccess: true, sharedGroupSessions: true, durableQueue: true, dualIdentity: true,
  timeoutMs: 1000, progressDelayMs: 60000, sessionConfigurationRevision: "authorization-fixture-v1" };
const incoming = (extra: Partial<IncomingMessage> = {}): IncomingMessage => ({ channelType: "lark", installationId: "cli",
  tenantId: "tenant", senderId: "alice", conversationId: "alice-chat", conversationType: "direct", threadId: "",
  rootMessageId: "", parentMessageId: "", messageId: "original-message", eventId: "original-event",
  text: "读取我的日程并保留原任务", createTime: 100, resources: [], mentionedBot: false, ...extra });
const message = incoming();
const stamp: PreparedAuthorization = { version: 1,
  identity: { channelType: "lark", installationId: "cli", tenantId: "tenant", openId: "alice" },
  generation: "10000000-0000-4000-8000-000000000001", vaultId: "alice-vault", credentialId: "alice-credential", flowId: null };
const done = () => ({ terminal: "idle" as const, messages: ["日程查询完成"] });
const readiness = async (sessionId: string) => ({ status: "idle" as const, sessionId, agentId: "agent" });
const counts = () => ({ prepare: 0, refresh: 0, create: 0, run: 0, post: 0, inspect: 0, hook: 0 });
type Counts = ReturnType<typeof counts>;
type Phase = "credential_complete" | "all_prepared" | "ready" | "credential_pending" | "developer_pending" | "legacy_ready";

test("replacing the Session while initializing a card cannot send the prepared input to the old Session", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  store.saveSession(toConversationKey(message, true), "old-session", "agent", undefined, ["bot-vault", stamp.vaultId]);
  const calls = counts(); let replies = 0;
  const gateway = new Gateway(store, { createSession: async () => assert.fail("不应新建"),
    run: async (_id, _text, _timeout, _progress, _update, guard) => { guard?.(); calls.post++; return done(); }
  }, async () => { replies++; }, { ...options, durableQueue: false, userCredentialLifecycle: lifecycle(calls, () => stamp),
    streamReply: async (_value, producer) => {
      await flush(); store.saveSession(toConversationKey(message, true), "replacement-session", "agent", undefined, ["bot-vault", stamp.vaultId]);
      await producer(async () => {});
    } });
  gateway.accept(message); await until(() => replies > 0 || calls.post > 0); await settle();
  assert.equal(calls.post, 0);
});

function fixture(t: { after: (callback: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "ark-prepared-authorization-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "gateway.db");
}
function reopen(t: { after: (callback: () => void) => void }, path: string) {
  const store = new GatewayStore(path); store.acquireRuntimeLock(); t.after(() => store.close()); return store;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 1500 && !check(); i++) await flush();
  assert.ok(check(), "任务应到达预期状态，不能把未运行的测试当作成功");
}
async function settle() { for (let i = 0; i < 40; i++) await flush(); }
async function recover(gateway: Gateway, value = message) {
  gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(value); await settle();
}
function identityMatches(value: IncomingMessage, expected: PreparedAuthorization) {
  return expected.identity.channelType === value.channelType && expected.identity.installationId === value.installationId
    && expected.identity.tenantId === value.tenantId && expected.identity.openId === value.senderId;
}
function lifecycle(calls: Counts, active: () => PreparedAuthorization, changes: Partial<UserCredentialLifecycle> = {}): UserCredentialLifecycle {
  return { revision: "credential-v1", prepare: async value => { calls.prepare++; const current = active();
    assert.ok(identityMatches(value, current)); return structuredClone(current); },
  refresh: async (value, expected) => { calls.refresh++; assert.ok(identityMatches(value, expected)); },
  matches: (value, expected) => identityMatches(value, expected) && JSON.stringify(active()) === JSON.stringify(expected), ...changes };
}

// 子进程在真实SQLite事务完成后直接退出；父进程不能依赖其内存、回调结果或未落盘Promise。
function exitAt(path: string, phase: Phase, value = message, realCredentials = false) {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    import { Gateway, toConversationKey } from ${JSON.stringify(new URL("../src/gateway.ts", import.meta.url).href)};
    import { EmployeeAuthorizationManager } from ${JSON.stringify(new URL("../src/employee-auth.ts", import.meta.url).href)};
    const store = new GatewayStore(${JSON.stringify(path)}); store.acquireRuntimeLock();
    const value = ${JSON.stringify(value)}, stamp = ${JSON.stringify(stamp)}, phase = ${JSON.stringify(phase)};
    const calls = ${JSON.stringify(counts())};
    const quit = () => { console.log(JSON.stringify(calls)); process.exit(77); };
    store.saveSession(toConversationKey(value, true), 'original-session', 'agent', undefined, ['bot-vault', stamp.vaultId]);
    const complete = store.inbox.completePreparationStep.bind(store.inbox);
    store.inbox.completePreparationStep = (...args) => { const saved = complete(...args);
      if (phase === 'credential_complete' && args[2] === 'user-credential') quit(); return saved; };
    const prepare = store.inbox.prepare.bind(store.inbox);
    store.inbox.prepare = (id, value) => { if (phase === 'all_prepared') quit();
      const copy = { ...value }; if (phase === 'legacy_ready') delete copy.userAuthorization;
      const saved = prepare(id, copy); if (phase === 'legacy_ready') quit(); return saved; };
    store.dispatchMessage = quit;
    let userCredentialLifecycle = { revision: 'credential-v1',
      prepare: async () => { calls.prepare++; if (phase === 'credential_pending') quit(); return structuredClone(stamp); },
      refresh: async () => { calls.refresh++; }, matches: () => true };
    if (${JSON.stringify(realCredentials)}) {
      store.credentials.save(stamp.identity, { vaultId: stamp.vaultId, credentialId: stamp.credentialId,
        status: 'ready', refreshToken: 'fixture-initial-refresh', expiresAt: Date.now() + 3600000,
        scopes: ['calendar:calendar.event:read'] }, 0);
      const forbidden = async () => { throw Error('夹具已有凭证，不应发起远端请求'); };
      const auth = new EmployeeAuthorizationManager(store, { listVaults: forbidden, createVault: forbidden,
        listCredentials: forbidden, createEnvironmentVariableCredential: forbidden, updateEnvironmentCredential: forbidden },
        { applicationId: 'cli', refresh: forbidden }, forbidden, () => {});
      userCredentialLifecycle = { revision: 'credential-v1',
        prepare: async value => { calls.prepare++; return auth.prepareUserTurn(value); },
        refresh: async (value, proof) => { calls.refresh++; return auth.refreshPreparedAuthorization(value, proof); },
        matches: (value, proof, final) => auth.matchesPreparedAuthorization(value, proof, final) };
    }
    const gateway = new Gateway(store, { createSession: async () => { calls.create++; return 'wrong-session'; },
      run: async () => { calls.run++; throw Error('不能提前发送模型请求'); } }, async () => {},
      { ...${JSON.stringify(options)}, userCredentialLifecycle,
        ...(phase === 'developer_pending' ? { beforeDirectTurn: async () => { calls.hook++; quit(); } } : {}) });
    gateway.accept(value); setTimeout(() => process.exit(99), 3000);
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 77, child.stderr);
  return JSON.parse(child.stdout.trim().split("\n").at(-1)!) as Counts;
}

for (const phase of ["credential_complete", "all_prepared", "ready"] as const)
test(`${phase} direct recovery refreshes the frozen authorization without repeating user preparation`, async t => {
  const path = fixture(t), child = exitAt(path, phase), store = reopen(t, path), calls = counts();
  assert.equal(child.prepare, 1); assert.equal(child.run, 0);
  const saved = store.inbox.findMessage(message)!;
  if (phase === "ready") assert.deepEqual(saved.preparation!.userAuthorization, stamp);
  else assert.deepEqual(saved.preparationPlan!.steps.find(step => step.id === "user-credential")!.output, stamp);
  const inputs: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => { calls.create++; return "wrong-session"; },
    inspectSessionReadiness: async id => { calls.inspect++; return readiness(id); },
    run: async (id, input, _timeout, _progress, _update, guard) => { calls.run++; guard?.(); calls.post++;
      assert.equal(id, "original-session"); inputs.push(input); return done(); }
  }, async () => {}, { ...options, userCredentialLifecycle: lifecycle(calls, () => stamp) });
  await recover(gateway); await until(() => store.inbox.findMessage(message)?.state === "completed");
  assert.deepEqual(calls, { prepare: 0, refresh: 1, create: 0, run: 1, post: 1, inspect: 1, hook: 0 });
  assert.equal(inputs.length, 1); assert.match(inputs[0], /读取我的日程并保留原任务/);
  if (saved.preparation) assert.equal(inputs[0], saved.preparation.input);
  assert.equal(store.getSession(toConversationKey(message, true)), "original-session");
  await recover(gateway); assert.equal(calls.post, 1);
});

for (const phase of ["credential_pending", "developer_pending"] as const)
test(`${phase} recovery pauses instead of retrying an uncertain provisioning or arbitrary hook`, async t => {
  const path = fixture(t), child = exitAt(path, phase), store = reopen(t, path), calls = counts();
  assert.equal(phase === "credential_pending" ? child.prepare : child.hook, 1);
  const gateway = new Gateway(store, { createSession: async () => { calls.create++; return "wrong"; },
    inspectSessionReadiness: async id => { calls.inspect++; return readiness(id); },
    run: async () => { calls.post++; return done(); }
  }, async () => {}, { ...options, userCredentialLifecycle: lifecycle(calls, () => stamp),
    ...(phase === "developer_pending" ? { beforeDirectTurn: async () => { calls.hook++; } } : {}) });
  await recover(gateway);
  assert.equal(store.inbox.findMessage(message)?.state, "uncertain");
  assert.deepEqual(calls, counts());
});

for (const botCredentialExists of [true, false])
test(`ready credential recovery uses only dedicated maintenance with Bot binding ${botCredentialExists ? "present" : "missing"}`, async t => {
  const path = fixture(t); exitAt(path, "ready"); const store = reopen(t, path), calls = counts();
  let botBinding = botCredentialExists;
  const gateway = new Gateway(store, { createSession: async () => assert.fail("恢复不能重建Session"),
    inspectSessionReadiness: readiness,
    run: async (_id, _input, _timeout, _progress, _update, guard) => { guard?.(); calls.post++; return done(); }
  }, async () => {}, { ...options,
    beforeCreateSession: async () => { calls.hook++; botBinding = true; },
    beforeDirectTurn: async () => { calls.hook++; },
    userCredentialLifecycle: lifecycle(calls, () => stamp, { refresh: async () => {
      calls.refresh++; if (!botBinding) throw new Error("原Bot凭证不存在，不能重新创建");
    } }) });
  await recover(gateway);
  if (botCredentialExists) await until(() => store.inbox.findMessage(message)?.state === "completed");
  assert.equal(calls.hook, 0, "ready恢复不能先执行可创建凭证的普通hook");
  assert.equal(calls.refresh, 1); assert.equal(calls.prepare, 0);
  assert.equal(calls.post, botCredentialExists ? 1 : 0);
  assert.equal(store.inbox.findMessage(message)?.state, botCredentialExists ? "completed" : "uncertain");
});

test("fresh direct input still performs ordinary maintenance before preparing authorization", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close()); const calls = counts();
  store.saveSession(toConversationKey(message, true), "original-session", "agent", undefined, ["bot-vault", stamp.vaultId]);
  const order: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => assert.fail("不应新建"),
    run: async (_id, _input, _timeout, _progress, _update, guard) => { guard?.(); calls.post++; return done(); }
  }, async () => {}, { ...options, durableQueue: false,
    beforeCreateSession: async () => { order.push("bot"); }, beforeDirectTurn: async () => { order.push("direct"); },
    userCredentialLifecycle: lifecycle(calls, () => stamp, { prepare: async () => { order.push("prepare"); return stamp; } }) });
  gateway.accept(message); await until(() => calls.post > 0); await settle();
  assert.deepEqual(order, ["bot", "direct", "prepare"]); assert.equal(calls.refresh, 0);
});

for (const scenario of ["legacy_ready", "missing_provider"] as const)
test(`${scenario} direct task cannot manufacture a new authorization proof on restart`, async t => {
  const path = fixture(t); exitAt(path, scenario === "legacy_ready" ? "legacy_ready" : "ready");
  const store = reopen(t, path), calls = counts();
  const gateway = new Gateway(store, { createSession: async () => { calls.create++; return "wrong"; },
    inspectSessionReadiness: async id => { calls.inspect++; return readiness(id); }, run: async () => { calls.post++; return done(); }
  }, async () => {}, { ...options, ...(scenario === "missing_provider" ? {} : { userCredentialLifecycle: lifecycle(calls, () => stamp) }) });
  await recover(gateway);
  assert.equal(store.inbox.findMessage(message)?.state, "uncertain");
  assert.equal(calls.prepare, 0); assert.equal(calls.refresh, 0); assert.equal(calls.post, 0);
});

for (const phase of ["all_prepared", "ready"] as const)
for (const changed of ["generation", "flowId"] as const)
for (const at of ["before_recovery", "readiness", "refresh", "stream_card", "before_send"] as const)
test(`${phase} rejects changed ${changed} at ${at} before posting the old user input`, async t => {
  const path = fixture(t); exitAt(path, phase);
  const store = reopen(t, path), calls = counts();
  let active = structuredClone(stamp), cardOpened = false, guardObserved = false;
  const mutate = () => { active = { ...active, [changed]: "20000000-0000-4000-8000-000000000002" }; };
  if (at === "before_recovery") mutate();
  const provider = lifecycle(calls, () => active, { refresh: async () => { calls.refresh++; if (at === "refresh") mutate(); } });
  const gateway = new Gateway(store, { createSession: async () => { calls.create++; return "wrong"; },
    inspectSessionReadiness: async id => { calls.inspect++; if (at === "readiness") mutate(); return readiness(id); },
    run: async (_id, _input, _timeout, _progress, _update, guard) => {
      calls.run++; if (at === "before_send") mutate();
      guardObserved = typeof guard === "function"; guard?.(); calls.post++; return done();
    }
  }, async () => {}, { ...options, userCredentialLifecycle: provider,
    ...(at === "stream_card" ? { streamReply: async (_message, producer) => {
      cardOpened = true; await flush(); mutate(); await producer(async () => {});
    } } : {}) });
  await recover(gateway);
  assert.equal(calls.post, 0, "用户授权已变化，旧请求不能进入MA");
  assert.equal(calls.prepare, 0); assert.equal(calls.create, 0);
  if (at === "before_send") assert.equal(guardObserved, true, "Ark实际发送前必须再次同步验证授权");
  else assert.equal(calls.run, 0, "已在网关可见的授权变化应阻止进入Ark.run");
  if (at === "stream_card") assert.equal(cardOpened, true);
  assert.equal(store.inbox.findMessage(message)?.state, "uncertain");
});

for (const at of ["prepare", "stream_card", "before_send"] as const)
test(`default non-durable direct path also rejects authorization replacement at ${at}`, async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  const calls = counts(); let active = structuredClone(stamp); let replies = 0, guardObserved = false;
  const mutate = () => { active = { ...active, generation: "20000000-0000-4000-8000-000000000002" }; };
  const provider = lifecycle(calls, () => active, { prepare: async () => {
    calls.prepare++; const expected = structuredClone(active); if (at === "prepare") mutate(); return expected;
  } });
  const gateway = new Gateway(store, { createSession: async () => "new-session",
    run: async (_id, _input, _timeout, _progress, _update, guard) => { calls.run++;
      if (at === "before_send") mutate(); guardObserved = typeof guard === "function"; guard?.(); calls.post++; return done(); }
  }, async () => { replies++; }, { ...options, durableQueue: false, userCredentialLifecycle: provider,
    ...(at === "stream_card" ? { streamReply: async (_message, producer) => { await flush(); mutate(); await producer(async () => {}); } } : {}) });
  gateway.accept(message); await until(() => replies > 0); await settle();
  assert.equal(calls.prepare, 1); assert.equal(calls.post, 0);
  if (at === "before_send") assert.equal(guardObserved, true); else assert.equal(calls.run, 0);
});

test("recovering Alice and processing Bob in another scope never exchange identity proofs or Vaults", async t => {
  const path = fixture(t); exitAt(path, "ready"); const store = reopen(t, path), calls = counts();
  const bob = incoming({ senderId: "bob", conversationId: "bob-chat", messageId: "bob-message", eventId: "bob-event", text: "Bob独立任务" });
  const bobStamp = { ...stamp, identity: { ...stamp.identity, openId: "bob" }, vaultId: "bob-vault", credentialId: "bob-credential",
    generation: "30000000-0000-4000-8000-000000000003" };
  const expected = (value: IncomingMessage) => value.senderId === "bob" ? bobStamp : stamp;
  const prepared: string[] = [], refreshed: string[] = [], requests: Array<{ session: string; input: string }> = [], vaults: string[][] = [];
  const provider: UserCredentialLifecycle = { revision: "credential-v1",
    prepare: async value => { prepared.push(value.senderId); return structuredClone(expected(value)); },
    refresh: async (value, proof) => { assert.deepEqual(proof, expected(value)); refreshed.push(value.senderId); },
    matches: (value, proof) => identityMatches(value, proof) && JSON.stringify(proof) === JSON.stringify(expected(value)) };
  const gateway = new Gateway(store, { createSession: async request => { calls.create++; vaults.push(request.vault_ids || []); return "bob-session"; },
    inspectSessionReadiness: readiness, run: async (id, input, _timeout, _progress, _update, guard) => {
      guard?.(); requests.push({ session: id, input }); return done(); }
  }, async () => {}, { ...options, userCredentialLifecycle: provider, getUserVaultIds: async value => [expected(value).vaultId] });
  gateway.recoverPendingMessages("lark", "cli"); gateway.accept(bob);
  await until(() => store.inbox.findMessage(message)?.state === "completed" && store.inbox.findMessage(bob)?.state === "completed");
  assert.deepEqual(prepared, ["bob"]); assert.deepEqual(refreshed, ["alice"]);
  assert.equal(requests.length, 2); assert.match(requests.find(value => value.session === "original-session")!.input, /读取我的日程/);
  assert.match(requests.find(value => value.session === "bob-session")!.input, /Bob独立任务/);
  assert.deepEqual(vaults, [["bot-vault", "bob-vault"]]);
});

for (const durableQueue of [false, true])
for (const threadId of ["", "thread-one"])
test(`group ${threadId || "chat"} stays Bot-only with durableQueue=${durableQueue}`, async t => {
  const store = new GatewayStore(":memory:"); if (durableQueue) store.acquireRuntimeLock(); t.after(() => store.close());
  const value = incoming({ conversationType: "group", mentionedBot: true, conversationId: "shared-chat", threadId });
  const calls = counts(); let replies = 0; const vaults: string[][] = [];
  const forbidden = () => { throw Error("群聊不能进入个人授权生命周期"); };
  const gateway = new Gateway(store, { createSession: async request => { vaults.push(request.vault_ids || []); return "bot-session"; },
    run: async (_id, _input, _timeout, _progress, _update, guard) => { guard?.(); calls.post++; return done(); }
  }, async () => { replies++; }, { ...options, durableQueue, userCredentialLifecycle: { revision: "credential-v1", prepare: forbidden, refresh: forbidden, matches: forbidden },
    getUserVaultIds: forbidden });
  gateway.accept(value); await until(() => replies > 0); await settle();
  assert.equal(calls.post, 1); assert.deepEqual(vaults, [["bot-vault"]]);
  if (durableQueue) assert.equal(store.inbox.findMessage(value)?.state, "completed");
});

function proofFrom(store: GatewayStore): PreparedAuthorization {
  const task = store.inbox.findMessage(message)!;
  return task.preparation?.userAuthorization
    ?? task.preparationPlan!.steps.find(step => step.id === "user-credential" && step.state === "completed")!.output as PreparedAuthorization;
}
function realManager(t: { after: (callback: () => void) => void }, store: GatewayStore) {
  const counts = { prepare: 0, maintain: 0, refresh: 0, update: 0, provision: 0 };
  const updates: Array<{ vaultId: string; credentialId: string; token: string }> = [];
  const forbidden = async () => { counts.provision++; throw Error("恢复不能重复创建Vault或Credential"); };
  const auth = new EmployeeAuthorizationManager(store, { listVaults: forbidden, createVault: forbidden, listCredentials: forbidden,
    createEnvironmentVariableCredential: forbidden, updateEnvironmentCredential: async (vaultId, credentialId, token) => {
      counts.update++; updates.push({ vaultId, credentialId, token });
    } }, { applicationId: "cli", refresh: async () => { counts.refresh++;
      return { accessToken: "fixture-new-access", refreshToken: "fixture-new-refresh", expiresAt: Date.now() + 3600000 };
    } } as never, forbidden, () => {});
  t.after(() => auth.close());
  const provider: UserCredentialLifecycle = { revision: "credential-v1",
    prepare: async value => { counts.prepare++; return auth.prepareUserTurn(value); },
    refresh: async (value, expected) => { counts.maintain++; return auth.refreshPreparedAuthorization(value, expected); },
    matches: (value, expected, final) => auth.matchesPreparedAuthorization(value, expected, final) };
  return { auth, provider, counts, updates };
}

for (const phase of ["all_prepared", "ready"] as const)
for (const state of ["expired", "sync_pending"] as const)
test(`real credential manager recovers ${phase} ${state} state without changing authorization generation`, async t => {
  const path = fixture(t); const child = exitAt(path, phase, message, true);
  assert.equal(child.prepare, 1); assert.equal(child.run, 0);
  const store = reopen(t, path), proof = proofFrom(store), before = store.credentials.get(stamp.identity)!;
  store.credentials.save(stamp.identity, state === "expired" ? { ...before, expiresAt: 1 }
    : { ...before, status: "sync_pending", pendingAccessToken: "fixture-already-rotated-access" }, before.revision);
  const manager = realManager(t, store); let posts = 0; const inputs: string[] = [];
  assert.equal(manager.auth.matchesPreparedAuthorization(message, proof), true);
  assert.equal(manager.auth.matchesPreparedAuthorization(message, proof, true), false);
  const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能创建另一个Session"); }, inspectSessionReadiness: readiness,
    run: async (id, input, _timeout, _progress, _update, guard) => {
      assert.equal(id, "original-session"); assert.equal(typeof guard, "function"); guard!(); posts++; inputs.push(input); return done(); }
  }, async () => {}, { ...options, userCredentialLifecycle: manager.provider });
  await recover(gateway); await until(() => store.inbox.findMessage(message)?.state === "completed");
  assert.deepEqual(manager.counts, { prepare: 0, maintain: 1, refresh: state === "expired" ? 1 : 0, update: 1, provision: 0 });
  assert.deepEqual(manager.updates, [{ vaultId: proof.vaultId, credentialId: proof.credentialId,
    token: state === "expired" ? "fixture-new-access" : "fixture-already-rotated-access" }]);
  assert.equal(posts, 1); assert.equal(store.credentials.get(stamp.identity)?.authorizationGeneration, proof.generation);
  assert.equal(store.credentials.get(stamp.identity)?.status, "ready");
  assert.equal(manager.auth.matchesPreparedAuthorization(message, proof, true), true);
  assert.doesNotMatch(inputs[0], /fixture-(?:new|initial|already-rotated)-(?:refresh|access)/);
});

for (const change of ["oauth_replaced", "flow_cancelled", "credential_replaced", "refresh_uncertain"] as const)
test(`real credential manager refuses ${change} before resuming the old ready task`, async t => {
  const path = fixture(t); exitAt(path, "ready", message, true);
  const store = reopen(t, path), proof = proofFrom(store), before = store.credentials.get(stamp.identity)!;
  if (change === "oauth_replaced") {
    let flow = store.authorizations.create(stamp.identity, [message]);
    flow = store.authorizations.save(stamp.identity, flow, { phase: "verifying" });
    flow = store.stageAuthorizationCredential(flow, { accessToken: "fixture-second-oauth-access",
      refreshToken: "fixture-second-oauth-refresh", expiresAt: Date.now() + 3600000 }, before.scopes);
    const staged = store.credentials.get(stamp.identity)!;
    store.credentials.save(stamp.identity, { ...staged, status: "ready", pendingAccessToken: undefined }, staged.revision);
    store.authorizations.save(stamp.identity, flow, { phase: "completed" });
    assert.notEqual(store.credentials.get(stamp.identity)?.authorizationGeneration, proof.generation);
  } else if (change === "flow_cancelled") {
    const flow = store.authorizations.create(stamp.identity, [message]);
    store.authorizations.save(stamp.identity, flow, { phase: "cancelled" });
    assert.equal(store.credentials.get(stamp.identity)?.authorizationGeneration, proof.generation);
  } else if (change === "credential_replaced") {
    store.credentials.save(stamp.identity, { ...before, credentialId: "replacement-credential" }, before.revision);
  } else {
    store.credentials.save(stamp.identity, { ...before, status: "refresh_uncertain" }, before.revision);
  }
  const manager = realManager(t, store); let posts = 0, inspections = 0;
  assert.equal(manager.auth.matchesPreparedAuthorization(message, proof), false);
  const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能创建另一个Session"); },
    inspectSessionReadiness: async id => { inspections++; return readiness(id); }, run: async () => { posts++; return done(); }
  }, async () => {}, { ...options, userCredentialLifecycle: manager.provider });
  await recover(gateway);
  assert.deepEqual(manager.counts, { prepare: 0, maintain: 0, refresh: 0, update: 0, provision: 0 });
  assert.equal(posts, 0); assert.equal(inspections, 0); assert.equal(store.inbox.findMessage(message)?.state, "uncertain");
});

for (const at of ["stream_card", "before_send"] as const)
for (const changed of ["expired", "sync_pending", "active_flow"] as const)
test(`real credential manager rejects ${changed} at ${at} even when the saved generation is unchanged`, async t => {
  const path = fixture(t); exitAt(path, "ready", message, true);
  const store = reopen(t, path), proof = proofFrom(store), manager = realManager(t, store);
  let posts = 0, runs = 0, changedOnce = false;
  const mutate = () => {
    assert.equal(changedOnce, false); changedOnce = true;
    const state = store.credentials.get(stamp.identity)!;
    if (changed === "active_flow") store.authorizations.create(stamp.identity, [message]);
    else store.credentials.save(stamp.identity, changed === "expired" ? { ...state, expiresAt: 1 }
      : { ...state, status: "sync_pending", pendingAccessToken: "fixture-late-access" }, state.revision);
    assert.equal(store.credentials.get(stamp.identity)?.authorizationGeneration, proof.generation);
    assert.equal(manager.auth.matchesPreparedAuthorization(message, proof, true), false);
  };
  const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能创建另一个Session"); },
    inspectSessionReadiness: readiness, run: async (_id, _input, _timeout, _progress, _update, guard) => {
      runs++; if (at === "before_send") mutate(); assert.equal(typeof guard, "function"); guard!(); posts++; return done(); }
  }, async () => {}, { ...options, userCredentialLifecycle: manager.provider,
    ...(at === "stream_card" ? { streamReply: async (_message, producer) => { await flush(); mutate(); await producer(async () => {}); } } : {}) });
  await recover(gateway);
  assert.equal(changedOnce, true); assert.equal(posts, 0); assert.equal(runs, at === "before_send" ? 1 : 0);
  assert.deepEqual(manager.counts, { prepare: 0, maintain: 1, refresh: 0, update: 0, provision: 0 });
  assert.equal(store.inbox.findMessage(message)?.state, "uncertain");
});
