import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { EmployeeAuthorizationManager } from "../src/employee-auth.ts";
import { GatewayStore } from "../src/store.ts";
import { credentialIdentityKey } from "../src/credential-state.ts";
import type { IncomingMessage } from "../src/gateway.ts";
import type { VaultMetadata, CredentialMetadata } from "../src/ark.ts";
import { provisionUserCredential } from "../src/credential-provisioning.ts";

const identity = { channelType: "lark", installationId: "cli", tenantId: "tenant", openId: "alice" };
const vaultName = `ark-employee-user-${createHash("sha256").update(credentialIdentityKey(identity)).digest("hex").slice(0, 40)}`;
const fixedOperationId = "11111111-1111-4111-8111-111111111111";
const message: IncomingMessage = { ...identity, senderId: identity.openId, conversationType: "direct",
  conversationId: "direct", eventId: "event", messageId: "message", text: "hello", resources: [],
  mentionedBot: false, threadId: "", rootMessageId: "", parentMessageId: "", createTime: 1 };

function fixture(t: TestContext) {
  const store = new GatewayStore(":memory:");
  const vaults: VaultMetadata[] = [], credentials: CredentialMetadata[] = [], calls: string[] = [];
  const ark = {
    listVaults: async () => { calls.push("vault-list"); return structuredClone(vaults); },
    getVault: async (id: string) => { calls.push("vault-get"); return structuredClone(vaults.find(v => v.id === id)!); },
    createVault: async (displayName: string, metadata?: Record<string, unknown>) => {
      calls.push("vault-create");
      const pending = store.credentialProvisioning.get(identity)!;
      assert.equal(pending.phase, "vault_pending");
      assert.equal(metadata?.arkagent_provision_operation, pending.operationId);
      const now = new Date().toISOString();
      vaults.push({ id: "vault", displayName, metadata, type: "vault", createdAt: now, updatedAt: now });
      return "vault";
    },
    listCredentials: async (_vaultId: string) => { calls.push("credential-list"); return structuredClone(credentials); },
    getCredential: async (_vaultId: string, id: string) => {
      calls.push("credential-get"); return structuredClone(credentials.find(c => c.id === id)!);
    },
    createEnvironmentVariableCredential: async (vaultId: string, displayName: string, secretName: string,
      secretValue: string, metadata?: Record<string, unknown>) => {
      calls.push("credential-create");
      const pending = store.credentialProvisioning.get(identity)!;
      assert.equal(pending.phase, "credential_pending"); assert.equal(pending.vaultId, vaultId);
      assert.equal(metadata?.arkagent_provision_operation, pending.operationId);
      assert.equal(secretValue, "ARKAGENT_USER_AUTH_PENDING");
      const now = new Date().toISOString();
      credentials.push({ id: "credential", displayName, vaultId, secretName, authType: "environment_variable",
        type: "vault_credential", metadata, createdAt: now, updatedAt: now, networking: { type: "unrestricted" } });
      return "credential";
    },
    updateEnvironmentCredential: async () => { throw new Error("must not update during provisioning"); }
  };
  const auth = new EmployeeAuthorizationManager(store, ark, { applicationId: "cli" } as never,
    async () => { throw new Error("must not send an OAuth card during provisioning"); },
    () => { throw new Error("must not replay business during provisioning"); });
  t.after(() => { auth.close(); store.close(); });
  return { store, auth, ark, vaults, credentials, calls };
}

async function provision(f: ReturnType<typeof fixture>, operationId: string, assertActive: () => void = () => {}) {
  const lease = f.store.credentials.acquire(identity);
  try { return await provisionUserCredential(f.store, f.ark, identity, assertActive, operationId); }
  finally { f.store.credentials.release(identity, lease); }
}

test("fresh provisioning uses the operation frozen before the hook started", async t => {
  const f = fixture(t);
  assert.deepEqual(await provision(f, fixedOperationId), { vaultId: "vault", credentialId: "credential" });
  const record = f.store.credentialProvisioning.get(identity)!;
  assert.equal(record.operationId, fixedOperationId);
  assert.equal(record.initialAuthorizationGeneration, f.store.credentials.get(identity)?.authorizationGeneration);
  assert.equal(f.vaults[0].metadata?.arkagent_provision_operation, fixedOperationId);
  assert.equal(f.credentials[0].metadata?.arkagent_provision_operation, fixedOperationId);
});

test("recovery confirms only the exact original provisioning operation", async t => {
  const f = fixture(t), create = f.ark.createEnvironmentVariableCredential;
  f.ark.createEnvironmentVariableCredential = async (...args) => { await create(...args); throw new Error("lost"); };
  await assert.rejects(provision(f, fixedOperationId));
  const original = f.store.credentialProvisioning.get(identity)!;
  assert.equal(original.operationId, fixedOperationId);
  assert.deepEqual(await provision(f, fixedOperationId), { vaultId: "vault", credentialId: "credential" });
  assert.equal(f.calls.filter(c => c === "vault-create").length, 1);
  assert.equal(f.calls.filter(c => c === "credential-create").length, 1);
  assert.equal(f.store.credentialProvisioning.get(identity)?.operationId, original.operationId);
});

for (const phase of ["vault_pending", "vault_confirmed", "credential_pending", "ready", "completed"] as const)
test(`a different expected operation in ${phase} makes no remote call or local write`, async t => {
  const f = fixture(t);
  let record = f.store.credentialProvisioning.begin(identity);
  if (phase !== "vault_pending") record = f.store.credentialProvisioning.confirmVault(record, "vault");
  if (["credential_pending", "ready", "completed"].includes(phase)) record = f.store.credentialProvisioning.beginCredential(record);
  if (["ready", "completed"].includes(phase)) record = f.store.credentialProvisioning.confirmCredential(record, "credential");
  if (phase === "completed") record = f.store.credentialProvisioning.complete(record);
  const binding = f.store.credentials.get(identity);
  await assert.rejects(provision(f, fixedOperationId));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.store.credentialProvisioning.get(identity), record);
  assert.deepEqual(f.store.credentials.get(identity), binding);
});

for (const operation of ["", "invalid", "11111111-1111-1111-8111-111111111111", null, 1])
test(`an invalid expected operation prevents preflight and provisioning: ${String(operation)}`, async t => {
  const f = fixture(t);
  await assert.rejects(provision(f, operation as string));
  assert.deepEqual(f.calls, []);
  assert.equal(f.store.credentialProvisioning.get(identity), undefined);
});

for (const boundary of ["vault-list", "vault-create", "credential-list", "credential-create"] as const)
test(`authorization becoming inactive after ${boundary} stops the fixed operation before its next effect`, async t => {
  const f = fixture(t);
  await assert.rejects(provision(f, fixedOperationId, () => {
    if (f.calls.includes(boundary)) throw new Error("inactive");
  }));
  const sequence = ["vault-list", "vault-create", "credential-list", "credential-create"];
  assert.deepEqual(f.calls, sequence.slice(0, sequence.indexOf(boundary) + 1));
  assert.equal(f.store.credentials.get(identity), undefined);
});

test("fresh provisioning journals each POST and reuses a confirmed binding without extra API calls", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.auth.ensureUserCredentialBinding(message), { vaultId: "vault", credentialId: "credential" });
  assert.deepEqual(f.calls, ["vault-list", "vault-create", "credential-list", "credential-create"]);
  const before = f.store.credentials.get(identity);
  await f.auth.ensureUserCredentialBinding(message);
  assert.equal(f.calls.length, 4); assert.deepEqual(f.store.credentials.get(identity), before);
  assert.equal(f.store.credentialProvisioning.get(identity)?.phase, "completed");
});

test("legacy same-name Vault is not adopted without an original provisioning journal", async t => {
  const f = fixture(t); f.vaults.push({ id: "legacy", displayName: vaultName });
  await assert.rejects(f.auth.ensureUserCredentialBinding(message), /归属|预置|创建/);
  assert.deepEqual(f.calls, ["vault-list"]); assert.equal(f.store.credentials.get(identity), undefined);
  assert.equal(f.store.credentialProvisioning.get(identity), undefined);
});

test("incomplete preflight does not persist a fake creation intent or POST", async t => {
  const f = fixture(t); f.ark.listVaults = async () => { throw new Error("private upstream detail"); };
  await assert.rejects(f.auth.ensureUserCredentialBinding(message), error =>
    error instanceof Error && !error.message.includes("private upstream detail"));
  assert.equal(f.store.credentialProvisioning.get(identity), undefined); assert.deepEqual(f.calls, []);
});

test("lost Vault response is recovered by exact operation evidence, not another POST", async t => {
  const f = fixture(t), create = f.ark.createVault;
  f.ark.createVault = async (...args) => { await create(...args); throw new Error("response lost"); };
  await assert.rejects(f.auth.ensureUserCredentialBinding(message));
  assert.equal(f.store.credentialProvisioning.get(identity)?.phase, "vault_pending");
  assert.deepEqual(await f.auth.ensureUserCredentialBinding(message), { vaultId: "vault", credentialId: "credential" });
  assert.equal(f.calls.filter(c => c === "vault-create").length, 1);
  assert.equal(f.calls.filter(c => c === "credential-create").length, 1);
  assert.ok(f.calls.includes("vault-get"));
});

test("lost Credential response is recovered without changing the write-only secret", async t => {
  const f = fixture(t), create = f.ark.createEnvironmentVariableCredential;
  f.ark.createEnvironmentVariableCredential = async (...args) => { await create(...args); throw new Error("response lost"); };
  await assert.rejects(f.auth.ensureUserCredentialBinding(message));
  assert.equal(f.store.credentialProvisioning.get(identity)?.phase, "credential_pending");
  assert.deepEqual(await f.auth.ensureUserCredentialBinding(message), { vaultId: "vault", credentialId: "credential" });
  assert.equal(f.calls.filter(c => c === "vault-create").length, 1);
  assert.equal(f.calls.filter(c => c === "credential-create").length, 1);
  assert.ok(f.calls.includes("credential-get"));
});

for (const resource of ["vault", "credential"] as const)
test(`a ${resource} POST whose remote result is absent stays pending without retry`, async t => {
  const f = fixture(t);
  if (resource === "vault") f.ark.createVault = async () => { f.calls.push("vault-create"); throw new Error("lost"); };
  else f.ark.createEnvironmentVariableCredential = async () => { f.calls.push("credential-create"); throw new Error("lost"); };
  await assert.rejects(f.auth.ensureUserCredentialBinding(message));
  await assert.rejects(f.auth.ensureUserCredentialBinding(message), /预置|确认|归属/);
  assert.equal(f.calls.filter(c => c === `${resource}-create`).length, 1);
  assert.equal(f.store.credentials.get(identity), undefined);
});

for (const field of ["metadata", "vaultId", "authType", "secretName", "networking", "createdAt", "updatedAt", "id"] as const)
test(`changed Credential ${field} prevents uncertain provisioning from being adopted`, async t => {
  const f = fixture(t), create = f.ark.createEnvironmentVariableCredential;
  f.ark.createEnvironmentVariableCredential = async (...args) => { await create(...args); throw new Error("lost"); };
  await assert.rejects(f.auth.ensureUserCredentialBinding(message));
  const bad = f.credentials[0]!;
  if (field === "metadata") bad.metadata = { ...bad.metadata, external_user_id: "another-user" };
  else if (field === "networking") bad.networking = undefined;
  else if (field === "createdAt") bad.createdAt = "2000-01-01T00:00:00Z";
  else if (field === "updatedAt") bad.updatedAt = new Date(Date.parse(bad.createdAt!) + 1).toISOString();
  else if (field === "id") f.ark.getCredential = async () => ({ ...bad, id: "other-credential" });
  else bad[field] = "wrong";
  await assert.rejects(f.auth.ensureUserCredentialBinding(message), /预置|确认|归属/);
  assert.equal(f.store.credentials.get(identity), undefined);
  assert.equal(f.calls.filter(c => c === "credential-create").length, 1);
});

test("a second Credential in the private Vault prevents adopting unknown authority", async t => {
  const f = fixture(t), create = f.ark.createEnvironmentVariableCredential;
  f.ark.createEnvironmentVariableCredential = async (...args) => { await create(...args); throw new Error("lost"); };
  await assert.rejects(f.auth.ensureUserCredentialBinding(message));
  f.credentials.push({ ...f.credentials[0], id: "second" });
  await assert.rejects(f.auth.ensureUserCredentialBinding(message), /预置|确认|归属/);
  assert.equal(f.store.credentials.get(identity), undefined);
});

test("closing during Vault creation preserves pending evidence and does not create a Credential", async t => {
  const f = fixture(t), create = f.ark.createVault;
  f.ark.createVault = async (...args) => { const result = await create(...args); f.auth.close(); return result; };
  await assert.rejects(f.auth.ensureUserCredentialBinding(message));
  assert.equal(f.store.credentialProvisioning.get(identity)?.phase, "vault_pending");
  assert.equal(f.calls.includes("credential-create"), false);
});

test("groups cannot provision individual credentials or call remote APIs", async t => {
  const f = fixture(t);
  await assert.rejects(f.auth.ensureUserCredentialBinding({ ...message, conversationType: "group" }), /群聊/);
  assert.deepEqual(f.calls, []); assert.equal(f.store.credentialProvisioning.get(identity), undefined);
});

test("same-identity concurrent requests create one resource pair", async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 20 }, () => f.auth.ensureUserCredentialBinding(message)));
  assert.ok(results.every(r => r.vaultId === "vault" && r.credentialId === "credential"));
  assert.equal(f.calls.filter(c => c.endsWith("create")).length, 2);
});

for (const phase of ["vault_pending", "vault_confirmed", "credential_pending", "ready"] as const)
test(`authorization status exposes ${phase} as incomplete provisioning without side effects`, t => {
  const f = fixture(t);
  let record = f.store.credentialProvisioning.begin(identity);
  if (phase !== "vault_pending") record = f.store.credentialProvisioning.confirmVault(record, "private-vault");
  if (phase === "credential_pending" || phase === "ready") record = f.store.credentialProvisioning.beginCredential(record);
  if (phase === "ready") record = f.store.credentialProvisioning.confirmCredential(record, "private-credential");
  const result = f.auth.status(message);
  assert.match(result, /预置.*未完成|预置.*待确认/);
  assert.doesNotMatch(result, /private-|ark-employee-user|arkagent_provision|没有当前应用身份的授权记录/);
  assert.doesNotMatch(f.auth.status({ ...message, senderId: "bob" }), /预置/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.store.credentialProvisioning.get(identity), record);
  assert.equal(f.store.credentials.get(identity), undefined);
});

for (const resource of ["vault", "credential"] as const)
for (const conflict of ["updated", "details"] as const)
test(`${resource} ${conflict} differing only below millisecond precision cannot be adopted`, async t => {
  const f = fixture(t);
  if (resource === "vault") {
    const create = f.ark.createVault;
    f.ark.createVault = async (...args) => { await create(...args); throw new Error("lost"); };
  } else {
    const create = f.ark.createEnvironmentVariableCredential;
    f.ark.createEnvironmentVariableCredential = async (...args) => { await create(...args); throw new Error("lost"); };
  }
  await assert.rejects(f.auth.ensureUserCredentialBinding(message));
  const source = resource === "vault" ? f.vaults[0] : f.credentials[0];
  source.createdAt = source.createdAt!.replace("Z", "123Z");
  source.updatedAt = conflict === "updated" ? source.createdAt.replace("123Z", "789Z") : source.createdAt;
  if (conflict === "details") {
    const detail = { ...source, createdAt: source.createdAt.replace("123Z", "789Z"), updatedAt: source.createdAt.replace("123Z", "789Z") };
    if (resource === "vault") f.ark.getVault = async () => detail as VaultMetadata;
    else f.ark.getCredential = async () => detail as CredentialMetadata;
  }
  const before = f.store.credentialProvisioning.get(identity);
  await assert.rejects(f.auth.ensureUserCredentialBinding(message), /预置/);
  assert.equal(f.store.credentials.get(identity), undefined);
  assert.deepEqual(f.store.credentialProvisioning.get(identity), before);
});

for (const boundary of ["vault-create", "credential-list"] as const)
test(`another local binding appearing during ${boundary} prevents any further Credential POST`, async t => {
  const f = fixture(t);
  const bind = () => f.store.credentials.save(identity, { vaultId: "replacement-vault", credentialId: "replacement-credential",
    status: "ready", expiresAt: Date.now() + 600_000, scopes: ["calendar:read"], refreshToken: "private-refresh" }, 0);
  if (boundary === "vault-create") {
    const create = f.ark.createVault;
    f.ark.createVault = async (...args) => { const id = await create(...args); bind(); return id; };
  } else {
    const list = f.ark.listCredentials;
    f.ark.listCredentials = async (...args) => { const items = await list(...args); bind(); return items; };
  }
  await assert.rejects(f.auth.ensureUserCredentialBinding(message));
  assert.equal(f.calls.includes("credential-create"), false);
  assert.equal(f.store.credentials.get(identity)?.vaultId, "replacement-vault");
  assert.equal(f.store.credentials.get(identity)?.status, "ready");
});
