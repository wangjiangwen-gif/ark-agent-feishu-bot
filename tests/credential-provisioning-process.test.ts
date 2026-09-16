import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as flush } from "node:timers/promises";
import { GatewayStore } from "../src/store.ts";
import { EmployeeAuthorizationManager } from "../src/employee-auth.ts";
import { credentialIdentityKey } from "../src/credential-state.ts";
import { Gateway, type IncomingMessage } from "../src/gateway.ts";

const message: IncomingMessage = { channelType: "lark", installationId: "cli-provision", tenantId: "tenant-provision", senderId: "alice",
  conversationId: "alice-chat", conversationType: "direct", threadId: "", rootMessageId: "", parentMessageId: "",
  messageId: "original-task", eventId: "original-event", text: "查询我的日程", createTime: 100, resources: [], mentionedBot: false };
const identity = { channelType: message.channelType, installationId: message.installationId, tenantId: message.tenantId, openId: message.senderId };
const options = { agentId: "agent", environmentId: "env", vaultId: "bot-vault", appId: message.installationId,
  platformAccess: true, sharedGroupSessions: true, durableQueue: true, dualIdentity: true, timeoutMs: 1000,
  progressDelayMs: 60000, sessionConfigurationRevision: "provision-process-v1" };
type Phase = "vault_post" | "vault_confirmed" | "credential_post" | "credential_confirmed" | "before_binding";
type Resource = { id: string; displayName: string; type: string; metadata: Record<string, string>;
  createdAt: string; updatedAt: string; vaultId?: string; authType?: string; secretName?: string; networking?: unknown };
type RemoteState = { vaults: Resource[]; credentials: Resource[] };
type Effect = { kind: string; id?: string; vaultId?: string; metadata?: Record<string, string> };

// 远端资源放在独立临时文件中；真实进程退出后保留，不能靠父进程的内存伪造创建成功。
// 此模块只模拟Ark边界，业务Manager、SQLite事务和恢复判断均使用产品代码。
const remoteModule = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
export function makeRemote(files, crash = '') {
  const record = value => appendFileSync(files.ledger, JSON.stringify(value) + '\\n');
  const state = () => JSON.parse(readFileSync(files.remote, 'utf8'));
  const save = value => writeFileSync(files.remote, JSON.stringify(value));
  const quit = phase => { if (crash === phase) { record({ kind: 'process_exit', phase }); process.exit(77); } };
  const api = {
    listVaults: async () => { record({ kind: 'list_vaults' }); return state().vaults; },
    getVault: async id => { record({ kind: 'get_vault', id });
      const found = state().vaults.find(item => item.id === id); if (!found) throw Error('合成Vault不存在'); return found; },
    listCredentials: async vaultId => { record({ kind: 'list_credentials', vaultId }); return state().credentials.filter(item => item.vaultId === vaultId); },
    getCredential: async (vaultId, id) => { record({ kind: 'get_credential', vaultId, id });
      const found = state().credentials.find(item => item.id === id && item.vaultId === vaultId);
      if (!found) throw Error('合成Credential不存在'); return found; },
    createVault: async (displayName, metadata = {}) => {
      const data = state(), id = 'vlt-synthetic-' + (data.vaults.length + 1), time = new Date().toISOString();
      data.vaults.push({ id, displayName, type: 'vault', metadata, createdAt: time, updatedAt: time }); save(data);
      record({ kind: 'vault_post', id, metadata }); quit('vault_post'); return id;
    },
    createEnvironmentVariableCredential: async (vaultId, displayName, secretName, secret, metadata = {}) => {
      if (secret !== 'ARKAGENT_USER_AUTH_PENDING') throw Error('首次预置只能写占位凭证');
      const data = state(), id = 'vcrd-synthetic-' + (data.credentials.length + 1), time = new Date().toISOString();
      data.credentials.push({ id, vaultId, displayName, type: 'vault_credential', authType: 'environment_variable',
        secretName, networking: { type: 'unrestricted' }, metadata, createdAt: time, updatedAt: time }); save(data);
      record({ kind: 'credential_post', id, vaultId, metadata }); quit('credential_post'); return id;
    },
    updateEnvironmentCredential: async () => { record({ kind: 'credential_update' }); throw Error('预置恢复不能更新未知Token'); },
    createSession: async () => { record({ kind: 'session_post' }); return 'synthetic-session'; },
    run: async () => { record({ kind: 'business_post' }); return { terminal: 'idle', messages: ['合成回复'] }; }
  };
  return { api, record, state, save };
}
`;

function fixture(t: { after: (callback: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "ark-credential-provision-process-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { path: join(dir, "gateway.db"), remote: join(dir, "remote.json"), ledger: join(dir, "effects.ndjson"), module: join(dir, "remote.mjs") };
  writeFileSync(files.module, remoteModule); writeFileSync(files.remote, JSON.stringify({ vaults: [], credentials: [] }));
  writeFileSync(files.ledger, ""); return files;
}
type Files = ReturnType<typeof fixture>;
function effects(files: Files): Effect[] { return readFileSync(files.ledger, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
function state(files: Files): RemoteState { return JSON.parse(readFileSync(files.remote, "utf8")); }
function changeRemote(files: Files, modify: (value: RemoteState) => void) { const data = state(files); modify(data); writeFileSync(files.remote, JSON.stringify(data)); }
const posted = (files: Files) => effects(files).filter(effect => effect.kind.endsWith("_post"));
function open(t: { after: (callback: () => void) => void }, files: Files) {
  const store = new GatewayStore(files.path); store.acquireRuntimeLock(); t.after(() => store.close()); return store;
}
async function remote(files: Files) {
  return (await import(pathToFileURL(files.module).href)).makeRemote(files) as { api: any; state: () => RemoteState; save: (data: RemoteState) => void; record: (value: Effect) => void };
}
async function manager(t: { after: (callback: () => void) => void }, store: GatewayStore, files: Files, patch: Record<string, unknown> = {}) {
  const source = await remote(files);
  const auth = new EmployeeAuthorizationManager(store, { ...source.api, ...patch }, {
    applicationId: message.installationId, refresh: async () => { source.record({ kind: "oauth_refresh" }); throw Error("不能刷新尚未授权的凭证"); }
  } as never, async () => { source.record({ kind: "oauth_card" }); }, () => { source.record({ kind: "business_resume" }); });
  t.after(() => auth.close()); return { auth, ...source };
}

function exitAt(files: Files, phase: Phase, viaInbox = false) {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    import { EmployeeAuthorizationManager } from ${JSON.stringify(new URL("../src/employee-auth.ts", import.meta.url).href)};
    import { Gateway } from ${JSON.stringify(new URL("../src/gateway.ts", import.meta.url).href)};
    import { makeRemote } from ${JSON.stringify(pathToFileURL(files.module).href)};
    const files = ${JSON.stringify(files)}, phase = ${JSON.stringify(phase)}, message = ${JSON.stringify(message)};
    const store = new GatewayStore(files.path); store.acquireRuntimeLock();
    const source = makeRemote(files, phase), quit = () => { source.record({ kind: 'checkpoint_exit', phase }); process.exit(77); };
    if (phase === 'vault_confirmed' || phase === 'credential_confirmed') {
      const method = phase === 'vault_confirmed' ? 'confirmVault' : 'confirmCredential';
      const original = store.credentialProvisioning[method].bind(store.credentialProvisioning);
      store.credentialProvisioning[method] = (...args) => { const result = original(...args); quit(); return result; };
    }
    if (phase === 'before_binding') {
      const original = store.credentials.save.bind(store.credentials);
      store.credentials.save = (...args) => { if (args[0].openId === message.senderId && args[1].status === 'binding') quit(); return original(...args); };
    }
    const auth = new EmployeeAuthorizationManager(store, source.api, { applicationId: message.installationId,
      refresh: async () => { throw Error('不能刷新尚未授权的凭证'); } }, async () => {}, () => {});
    if (${JSON.stringify(viaInbox)}) {
      const userCredentialLifecycle = { revision: 'provision-v1', prepare: value => auth.prepareUserTurn(value),
        refresh: (value, proof) => auth.refreshPreparedAuthorization(value, proof),
        matches: (value, proof, final) => auth.matchesPreparedAuthorization(value, proof, final) };
      new Gateway(store, source.api, async () => {}, { ...${JSON.stringify(options)}, userCredentialLifecycle }).accept(message);
    } else {
      auth.ensureUserCredentialBinding(message).then(() => process.exit(98), error => { console.error(error.message); process.exit(97); });
    }
    setTimeout(() => process.exit(99), 3000);
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 77, child.stderr || child.stdout);
  assert.equal(effects(files).some(effect => ["business_post", "session_post", "oauth_card", "oauth_refresh"].includes(effect.kind)), false);
}

for (const phase of ["vault_post", "vault_confirmed", "credential_post", "credential_confirmed", "before_binding"] as const)
test(`${phase} process exit recovers the original provisioning operation and resource IDs without a duplicate POST`, async t => {
  const files = fixture(t); exitAt(files, phase); const store = open(t, files);
  const original = store.credentialProvisioning.get(identity)!;
  assert.ok(original); assert.equal(store.credentials.get(identity), undefined);
  assert.equal(original.phase, { vault_post: "vault_pending", vault_confirmed: "vault_confirmed", credential_post: "credential_pending",
    credential_confirmed: "ready", before_binding: "ready" }[phase]);
  const originalResources = state(files), before = posted(files), { auth } = await manager(t, store, files);
  const binding = await auth.ensureUserCredentialBinding(message);
  const recovered = store.credentialProvisioning.get(identity)!;
  assert.equal(recovered.operationId, original.operationId); assert.equal(recovered.phase, "completed");
  assert.equal(binding.vaultId, originalResources.vaults[0].id);
  assert.equal(binding.credentialId, originalResources.credentials[0]?.id || state(files).credentials[0].id);
  assert.equal(posted(files).filter(effect => effect.kind === "vault_post").length, 1);
  assert.equal(posted(files).filter(effect => effect.kind === "credential_post").length, 1);
  assert.deepEqual(posted(files).slice(0, before.length), before);
  const credential = store.credentials.get(identity)!;
  assert.equal(credential.vaultId, binding.vaultId); assert.equal(credential.credentialId, binding.credentialId);
  assert.equal(credential.status, "binding"); assert.equal(credential.refreshToken, undefined); assert.deepEqual(credential.scopes, []);
  const metadata = state(files).vaults[0].metadata;
  assert.equal(metadata.external_user_id, createHash("sha256").update(credentialIdentityKey(identity)).digest("hex"));
  assert.equal(metadata.arkagent_provision_operation, original.operationId);
  assert.match(metadata.arkagent_provision_request, /^[a-f0-9]{64}$/);
  assert.equal(state(files).credentials[0].metadata.arkagent_provision_operation, original.operationId);
  const after = effects(files); await auth.ensureUserCredentialBinding(message);
  assert.deepEqual(effects(files), after, "已经确认的本地绑定无需再次读取远端");
});

for (const phase of ["vault_post", "credential_post"] as const)
for (const invalid of ["missing", "duplicate", "metadata_changed", "updated_at_changed", "type_changed", "created_too_early",
  "created_in_future", "invalid_time", "details_missing", "details_changed", "details_timestamp_changed"] as const)
test(`${phase} unknown POST stays pending when recovery evidence is ${invalid}`, async t => {
  const files = fixture(t); exitAt(files, phase); const store = open(t, files), original = store.credentialProvisioning.get(identity)!;
  const property = phase === "vault_post" ? "vaults" : "credentials", beforePosts = posted(files);
  changeRemote(files, data => {
    const item = data[property][0];
    if (invalid === "missing") data[property] = [];
    if (invalid === "duplicate") data[property].push({ ...structuredClone(item), id: `${item.id}-duplicate` });
    if (invalid === "metadata_changed") item.metadata.arkagent_provision_operation = "00000000-0000-4000-8000-000000000000";
    if (invalid === "updated_at_changed") item.updatedAt = new Date(Date.parse(item.createdAt) + 5000).toISOString();
    if (invalid === "type_changed") item.type = "unrelated_resource";
    if (invalid === "created_too_early") item.createdAt = item.updatedAt = "2000-01-01T00:00:00.000Z";
    if (invalid === "created_in_future") item.createdAt = item.updatedAt = new Date(Date.now() + 86400000).toISOString();
    if (invalid === "invalid_time") item.createdAt = item.updatedAt = "not-a-time";
  });
  const detailPatch = invalid === "details_missing" ? { [phase === "vault_post" ? "getVault" : "getCredential"]: async () => { throw Error("详情不可读"); } }
    : invalid === "details_changed" ? { [phase === "vault_post" ? "getVault" : "getCredential"]: async () => ({ ...state(files)[property][0], metadata: {} }) }
    : invalid === "details_timestamp_changed" ? { [phase === "vault_post" ? "getVault" : "getCredential"]: async () => {
      const item = state(files)[property][0], time = new Date(Date.parse(item.createdAt) + 1000).toISOString();
      return { ...item, createdAt: time, updatedAt: time };
    } } : {};
  const { auth } = await manager(t, store, files, detailPatch);
  await assert.rejects(auth.ensureUserCredentialBinding(message));
  await assert.rejects(auth.ensureUserCredentialBinding(message));
  assert.equal(store.credentials.get(identity), undefined);
  assert.deepEqual(store.credentialProvisioning.get(identity), original, "不完整或冲突的查询证据不能推进原操作");
  assert.deepEqual(posted(files), beforePosts, "查询失败或候选不唯一不能重新POST");
});

for (const patch of [
  { vaultId: "another-vault" }, { authType: "bearer" }, { secretName: "OTHER_USER_SECRET" },
  { networking: { type: "restricted" } }, { networking: { type: "unrestricted", allowed_hosts: ["unexpected.example"] } },
  { displayName: "unexpected-name" }
] as const)
test(`credential unknown POST rejects mismatched credential shape ${JSON.stringify(patch)}`, async t => {
  const files = fixture(t); exitAt(files, "credential_post"); const store = open(t, files);
  const original = store.credentialProvisioning.get(identity), before = posted(files);
  changeRemote(files, data => Object.assign(data.credentials[0], patch));
  const { auth } = await manager(t, store, files);
  await assert.rejects(auth.ensureUserCredentialBinding(message));
  assert.equal(store.credentials.get(identity), undefined); assert.deepEqual(store.credentialProvisioning.get(identity), original);
  assert.deepEqual(posted(files), before);
});

for (const phase of ["vault_confirmed", "credential_confirmed"] as const)
for (const changed of ["missing", "metadata", "updated_at", "type"] as const)
test(`${phase} restart rechecks the confirmed Vault and refuses ${changed} changes before local binding`, async t => {
  const files = fixture(t); exitAt(files, phase); const store = open(t, files);
  const original = store.credentialProvisioning.get(identity), before = posted(files);
  changeRemote(files, data => {
    if (changed === "missing") data.vaults = [];
    if (changed === "metadata") data.vaults[0].metadata.arkagent_provision_request = "0".repeat(64);
    if (changed === "updated_at") data.vaults[0].updatedAt = new Date(Date.parse(data.vaults[0].createdAt) + 1000).toISOString();
    if (changed === "type") data.vaults[0].type = "other";
  });
  const { auth } = await manager(t, store, files);
  await assert.rejects(auth.ensureUserCredentialBinding(message));
  assert.equal(store.credentials.get(identity), undefined); assert.deepEqual(posted(files), before);
  assert.deepEqual(store.credentialProvisioning.get(identity), original);
});

for (const changed of ["missing", "metadata", "updated_at", "auth_type"] as const)
test(`confirmed Credential restart refuses ${changed} changes before committing local identity binding`, async t => {
  const files = fixture(t); exitAt(files, "credential_confirmed"); const store = open(t, files);
  const original = store.credentialProvisioning.get(identity), before = posted(files);
  changeRemote(files, data => {
    if (changed === "missing") data.credentials = [];
    if (changed === "metadata") data.credentials[0].metadata.arkagent_provision_request = "0".repeat(64);
    if (changed === "updated_at") data.credentials[0].updatedAt = new Date(Date.parse(data.credentials[0].createdAt) + 1000).toISOString();
    if (changed === "auth_type") data.credentials[0].authType = "oauth";
  });
  const { auth } = await manager(t, store, files);
  await assert.rejects(auth.ensureUserCredentialBinding(message));
  assert.equal(store.credentials.get(identity), undefined); assert.deepEqual(posted(files), before);
  assert.deepEqual(store.credentialProvisioning.get(identity), original);
});

test("a preexisting same-name Vault without local operation proof is never adopted or modified", async t => {
  const files = fixture(t), store = open(t, files), now = new Date().toISOString();
  changeRemote(files, data => data.vaults.push({ id: "vlt-legacy", displayName: `ark-employee-user-${createHash("sha256")
    .update(credentialIdentityKey(identity)).digest("hex").slice(0, 40)}`, type: "vault", metadata: {}, createdAt: now, updatedAt: now }));
  const { auth } = await manager(t, store, files);
  await assert.rejects(auth.ensureUserCredentialBinding(message));
  assert.equal(store.credentials.get(identity), undefined); assert.deepEqual(posted(files), []);
  assert.equal(effects(files).some(effect => effect.kind === "credential_update"), false);
});

test("a preexisting same-name Credential in the confirmed Vault cannot be adopted without matching operation proof", async t => {
  const files = fixture(t); exitAt(files, "vault_confirmed"); const store = open(t, files), before = posted(files);
  const now = new Date().toISOString(), vaultId = state(files).vaults[0].id;
  changeRemote(files, data => data.credentials.push({ id: "vcrd-legacy", vaultId, displayName: "lark-cli-user-access-token",
    type: "vault_credential", authType: "environment_variable", secretName: "LARKSUITE_CLI_USER_ACCESS_TOKEN",
    networking: { type: "unrestricted" }, metadata: {}, createdAt: now, updatedAt: now }));
  const { auth } = await manager(t, store, files);
  await assert.rejects(auth.ensureUserCredentialBinding(message));
  assert.equal(store.credentials.get(identity), undefined); assert.deepEqual(posted(files), before);
  assert.equal(effects(files).some(effect => effect.kind === "credential_update"), false);
});

test("another user's independent provisioning does not adopt or unblock Alice's pending operation", async t => {
  const files = fixture(t); exitAt(files, "vault_post"); const store = open(t, files), aliceOperation = store.credentialProvisioning.get(identity)!;
  const bob = { ...message, senderId: "bob", conversationId: "bob-chat", messageId: "bob-task", eventId: "bob-event" };
  const bobIdentity = { ...identity, openId: "bob" }, { auth } = await manager(t, store, files);
  const bobBinding = await auth.ensureUserCredentialBinding(bob);
  assert.deepEqual(store.credentialProvisioning.get(identity), aliceOperation); assert.equal(store.credentials.get(identity), undefined);
  const aliceBinding = await auth.ensureUserCredentialBinding(message);
  assert.notEqual(aliceBinding.vaultId, bobBinding.vaultId); assert.notEqual(aliceBinding.credentialId, bobBinding.credentialId);
  assert.notEqual(store.credentialProvisioning.get(bobIdentity)?.operationId, aliceOperation.operationId);
  assert.equal(store.credentials.get(bobIdentity)?.vaultId, bobBinding.vaultId);
  assert.equal(store.credentials.get(identity)?.vaultId, aliceBinding.vaultId);
  assert.equal(posted(files).filter(effect => effect.kind === "vault_post").length, 2);
  assert.equal(posted(files).filter(effect => effect.kind === "credential_post").length, 2);
});

test("an already confirmed local binding performs no remote reads or writes", async t => {
  const files = fixture(t), store = open(t, files);
  store.credentials.save(identity, { vaultId: "vlt-confirmed", credentialId: "vcrd-confirmed", status: "binding", expiresAt: 0, scopes: [] }, 0);
  const { auth } = await manager(t, store, files);
  assert.deepEqual(await auth.ensureUserCredentialBinding(message), { vaultId: "vlt-confirmed", credentialId: "vcrd-confirmed" });
  assert.deepEqual(effects(files), []); assert.equal(store.credentialProvisioning.get(identity), undefined);
});

test("fresh concurrent provisioning creates one pair with no redundant detail GET after known POST responses", async t => {
  const files = fixture(t), store = open(t, files), { auth } = await manager(t, store, files);
  const results = await Promise.all(Array.from({ length: 8 }, () => auth.ensureUserCredentialBinding(message)));
  assert.ok(results.every(result => result.vaultId === results[0].vaultId && result.credentialId === results[0].credentialId));
  assert.equal(store.credentialProvisioning.get(identity)?.phase, "completed");
  assert.equal(posted(files).filter(effect => effect.kind === "vault_post").length, 1);
  assert.equal(posted(files).filter(effect => effect.kind === "credential_post").length, 1);
  assert.equal(effects(files).filter(effect => effect.kind === "list_vaults").length, 1);
  assert.equal(effects(files).filter(effect => effect.kind === "list_credentials").length, 1);
  assert.equal(effects(files).some(effect => ["get_vault", "get_credential"].includes(effect.kind)), false);
});

test("resource reconciliation alone does not replay an uncertain inbox user-credential hook", async t => {
  const files = fixture(t); exitAt(files, "credential_post", true); const store = open(t, files);
  const original = store.inbox.findMessage(message)!;
  assert.equal(original.preparationPlan!.steps.find(step => step.id === "user-credential")!.state, "pending");
  const { auth, api } = await manager(t, store, files);
  const binding = await auth.ensureUserCredentialBinding(message);
  assert.equal(binding.credentialId, state(files).credentials[0].id);
  const prior = effects(files);
  const userCredentialLifecycle = { revision: "provision-v1", prepare: (value: IncomingMessage) => auth.prepareUserTurn(value),
    refresh: (value: IncomingMessage, proof: any) => auth.refreshPreparedAuthorization(value, proof),
    matches: (value: IncomingMessage, proof: any, final?: boolean) => auth.matchesPreparedAuthorization(value, proof, final) };
  const gateway = new Gateway(store, api, async () => {}, { ...options, userCredentialLifecycle });
  gateway.recoverPendingMessages(message.channelType, message.installationId); await gateway.reconcilePendingMessage(message);
  for (let i = 0; i < 30; i++) await flush();
  const stopped = store.inbox.findMessage(message)!;
  assert.equal(stopped.id, original.id); assert.equal(stopped.state, "uncertain");
  assert.equal(stopped.preparationPlan!.steps.find(step => step.id === "user-credential")!.state, "pending");
  assert.deepEqual(effects(files), prior, "恢复资源不等于有权重放原消息的未知准备回调");
});
