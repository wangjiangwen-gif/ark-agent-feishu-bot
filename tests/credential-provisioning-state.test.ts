import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { GatewayStore } from "../src/store.ts";
import { credentialIdentityKey } from "../src/credential-state.ts";
import { provisioningMetadata, type CredentialProvisioningRecord } from "../src/credential-provisioning-state.ts";
import * as provisioningState from "../src/credential-provisioning-state.ts";

const identity = { channelType: "lark", installationId: "cli-provision", tenantId: "tenant", openId: "alice" };
const other = { ...identity, openId: "bob" };
const fixedOperationId = "11111111-1111-4111-8111-111111111111";
const known = { vaultId: "vault", credentialId: "credential", status: "ready" as const,
  scopes: ["calendar:read"], expiresAt: 10000, refreshToken: "existing-private-refresh" };
function memory(t: { after: (callback: () => void) => void }) {
  const store = new GatewayStore(":memory:"); t.after(() => store.close()); return store;
}
function disk(t: { after: (callback: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "ark-credential-provisioning-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "gateway.db");
  const store = new GatewayStore(path); t.after(() => store.close());
  return { store, path };
}
function reachReady(store: GatewayStore, owner = identity, vault = "vault", credential = "credential") {
  const begin = store.credentialProvisioning.begin(owner);
  const confirmed = store.credentialProvisioning.confirmVault(begin, vault);
  const pending = store.credentialProvisioning.beginCredential(confirmed);
  return store.credentialProvisioning.confirmCredential(pending, credential);
}

test("credential provisioning persists the immutable full-identity request before any resource exists", t => {
  const store = memory(t), record = store.credentialProvisioning.begin(identity);
  assert.equal(record.phase, "vault_pending"); assert.equal(record.revision, 1);
  assert.deepEqual(record.identity, identity);
  assert.equal(record.vaultName, `ark-employee-user-${createHash("sha256").update(credentialIdentityKey(identity)).digest("hex").slice(0, 40)}`);
  assert.equal(record.credentialName, "lark-cli-user-access-token");
  assert.equal(record.vaultId, undefined); assert.equal(record.credentialId, undefined);
  assert.deepEqual(store.credentialProvisioning.get(identity), record);
  assert.equal(store.credentials.get(identity), undefined);
  assert.throws(() => store.credentialProvisioning.begin(identity), /预置|创建|记录/);
});

test("already bound credentials cannot start a new provisioning operation", t => {
  const store = memory(t); store.credentials.save(identity, known, 0);
  assert.throws(() => store.credentialProvisioning.begin(identity), /绑定|预置/);
  assert.equal(store.credentialProvisioning.get(identity), undefined);
});

test("a caller can persist a fixed original provisioning operation without changing its identity", t => {
  const store = memory(t), record = store.credentialProvisioning.begin(identity, fixedOperationId);
  assert.equal(record.operationId, fixedOperationId);
  assert.equal(provisioningMetadata(record, "vault").arkagent_provision_operation, fixedOperationId);
  assert.throws(() => store.credentialProvisioning.begin(other, fixedOperationId));
  assert.equal(store.credentialProvisioning.get(other), undefined);
  assert.deepEqual(store.credentialProvisioning.get(identity), record);
});

for (const operationId of ["", "not-a-uuid", fixedOperationId.toUpperCase().replace("1", "A"), "11111111-1111-1111-8111-111111111111", null, 1])
test(`an invalid fixed provisioning operation is rejected before writing a journal: ${JSON.stringify(operationId)}`, t => {
  const store = memory(t);
  assert.throws(() => store.credentialProvisioning.begin(identity, operationId as string));
  assert.equal(store.credentialProvisioning.get(identity), undefined);
  assert.equal(store.credentials.get(identity), undefined);
});

test("Vault preflight can derive the original name without creating a provisioning intent", t => {
  const store = memory(t);
  const name = provisioningState.provisioningVaultName(identity);
  assert.equal(store.credentialProvisioning.get(identity), undefined);
  assert.equal(store.credentialProvisioning.begin(identity).vaultName, name);
  assert.throws(() => provisioningState.provisioningVaultName({ ...identity, accessToken: "private" }));
});

test("completion rejects accessor records before evaluating any caller-controlled fields", t => {
  const store = memory(t), ready = reachReady(store);
  let accesses = 0;
  const altered = { ...ready };
  Object.defineProperty(altered, "phase", { enumerable: true, get() { accesses++; return "ready"; } });
  assert.throws(() => store.credentialProvisioning.complete(altered));
  assert.equal(accesses, 0);
  assert.deepEqual(store.credentialProvisioning.get(identity), ready);
});

test("invalid phase objects are rejected without calling coercion methods", t => {
  const store = memory(t), record = store.credentialProvisioning.begin(identity);
  let coercions = 0;
  const invalid = { ...record, phase: { toString() { coercions++; return "vault_pending"; } } };
  assert.throws(() => store.credentialProvisioning.confirmVault(invalid as unknown as CredentialProvisioningRecord, "vault"));
  assert.equal(coercions, 0);
  assert.deepEqual(store.credentialProvisioning.get(identity), record);
});

test("each resource phase has a durable receipt and completing installs only the placeholder binding", t => {
  const store = memory(t), start = store.credentialProvisioning.begin(identity);
  const vault = store.credentialProvisioning.confirmVault(start, "vault");
  assert.equal(vault.phase, "vault_confirmed"); assert.equal(vault.vaultId, "vault");
  assert.equal(vault.credentialRequestedAt, undefined);
  const pending = store.credentialProvisioning.beginCredential(vault);
  assert.equal(pending.phase, "credential_pending"); assert.ok(pending.credentialRequestedAt! >= pending.createdAt);
  const ready = store.credentialProvisioning.confirmCredential(pending, "credential");
  assert.equal(ready.phase, "ready"); assert.equal(store.credentials.get(identity), undefined);
  const completed = store.credentialProvisioning.complete(ready);
  assert.equal(completed.phase, "completed"); assert.equal(completed.revision, 5);
  const binding = store.credentials.get(identity)!;
  assert.equal(binding.vaultId, "vault"); assert.equal(binding.credentialId, "credential");
  assert.equal(binding.status, "binding"); assert.equal(binding.expiresAt, 0); assert.deepEqual(binding.scopes, []);
  assert.equal(binding.refreshToken, undefined); assert.equal(binding.pendingAccessToken, undefined);
  assert.match(binding.authorizationGeneration!, /^[a-f0-9-]{36}$/);
  assert.equal(completed.initialAuthorizationGeneration, binding.authorizationGeneration);
  assert.deepEqual(store.credentialProvisioning.complete(completed), completed);
  assert.deepEqual(store.credentials.get(identity), binding);
});

for (const phase of ["vault_pending", "vault_confirmed", "credential_pending", "ready", "completed"] as const)
test(`${phase} provisioning survives closing and reopening the encrypted database`, t => {
  const { store, path } = disk(t);
  let record = store.credentialProvisioning.begin(identity);
  if (phase !== "vault_pending") record = store.credentialProvisioning.confirmVault(record, "vault");
  if (["credential_pending", "ready", "completed"].includes(phase)) record = store.credentialProvisioning.beginCredential(record);
  if (["ready", "completed"].includes(phase)) record = store.credentialProvisioning.confirmCredential(record, "credential");
  if (phase === "completed") record = store.credentialProvisioning.complete(record);
  store.close();
  assert.equal(readFileSync(path).includes(Buffer.from(record.vaultName)), false);
  assert.equal(readFileSync(path).includes(Buffer.from(record.credentialName)), false);
  if (record.initialAuthorizationGeneration) assert.equal(readFileSync(path).includes(Buffer.from(record.initialAuthorizationGeneration)), false);
  const reopened = new GatewayStore(path); t.after(() => reopened.close());
  assert.deepEqual(reopened.credentialProvisioning.get(identity), record);
});

test("a provisioning-only database cannot generate a replacement encryption key", t => {
  const { store, path } = disk(t); store.credentialProvisioning.begin(identity); store.close();
  unlinkSync(`${path}.credential-key`);
  const reopened = new GatewayStore(path); t.after(() => reopened.close());
  assert.throws(() => reopened.credentialProvisioning.get(identity), /密钥/);
  assert.throws(() => reopened.credentialProvisioning.begin(other), /密钥/);
});

for (const field of ["channelType", "installationId", "tenantId", "openId"] as const)
test(`provisioning identity includes ${field}`, t => {
  const store = memory(t), first = store.credentialProvisioning.begin(identity);
  const second = store.credentialProvisioning.begin({ ...identity, [field]: "different" });
  assert.notEqual(first.operationId, second.operationId); assert.notEqual(first.vaultName, second.vaultName);
  assert.notDeepEqual(provisioningMetadata(first, "vault"), provisioningMetadata(second, "vault"));
});

for (const field of ["identity", "operationId", "revision", "createdAt", "vaultName", "credentialName", "phase"] as const)
test(`a caller cannot change expected ${field} before confirming a Vault`, t => {
  const store = memory(t), first = store.credentialProvisioning.begin(identity);
  const altered = { ...first, [field]: field === "identity" ? other : field === "revision" ? 3
    : field === "createdAt" ? first.createdAt - 1 : field === "phase" ? "vault_confirmed" : "changed" };
  assert.throws(() => store.credentialProvisioning.confirmVault(altered as CredentialProvisioningRecord, "vault"), /预置|版本|绑定|记录/);
  assert.deepEqual(store.credentialProvisioning.get(identity), first);
});

test("old phase revisions cannot overwrite confirmed resource IDs or issue another Credential intent", t => {
  const store = memory(t), first = store.credentialProvisioning.begin(identity);
  const vault = store.credentialProvisioning.confirmVault(first, "vault");
  assert.throws(() => store.credentialProvisioning.confirmVault(first, "other-vault"), /预置|版本|阶段/);
  const pending = store.credentialProvisioning.beginCredential(vault);
  assert.throws(() => store.credentialProvisioning.beginCredential(vault), /预置|版本|阶段/);
  const ready = store.credentialProvisioning.confirmCredential(pending, "credential");
  assert.throws(() => store.credentialProvisioning.confirmCredential(pending, "other-credential"), /预置|版本|阶段/);
  assert.throws(() => store.credentialProvisioning.complete({ ...ready, credentialId: "replaced" }), /预置|版本|绑定/);
  assert.throws(() => store.credentialProvisioning.complete({ ...ready, credentialRequestedAt: ready.credentialRequestedAt! - 1 }), /预置|版本|绑定/);
  assert.deepEqual(store.credentialProvisioning.get(identity), ready);
});

test("phase transitions cannot skip Vault or Credential creation evidence", t => {
  const store = memory(t), first = store.credentialProvisioning.begin(identity);
  assert.throws(() => store.credentialProvisioning.beginCredential(first), /阶段|预置/);
  assert.throws(() => store.credentialProvisioning.confirmCredential(first, "credential"), /阶段|预置/);
  assert.throws(() => store.credentialProvisioning.complete(first), /阶段|预置/);
});

test("an existing authorized binding is preserved byte-for-byte when the same operation completes", t => {
  const store = memory(t), ready = reachReady(store);
  store.credentials.save(identity, known, 0);
  const before = store.credentials.get(identity);
  const completed = store.credentialProvisioning.complete(ready);
  assert.equal(Object.hasOwn(completed, "initialAuthorizationGeneration"), false);
  assert.deepEqual(store.credentialProvisioning.complete(completed), completed);
  assert.deepEqual(store.credentials.get(identity), before);
});

test("an existing placeholder binding is not relabeled as created by the provisioning transaction", t => {
  const store = memory(t), ready = reachReady(store);
  store.credentials.save(identity, { vaultId: "vault", credentialId: "credential", status: "binding", scopes: [], expiresAt: 0 }, 0);
  const before = store.credentials.get(identity), completed = store.credentialProvisioning.complete(ready);
  assert.equal(Object.hasOwn(completed, "initialAuthorizationGeneration"), false);
  assert.deepEqual(store.credentials.get(identity), before);
});

test("completed provisioning cannot replace or remove its original authorization generation receipt", t => {
  const store = memory(t), completed = store.credentialProvisioning.complete(reachReady(store));
  assert.ok(completed.initialAuthorizationGeneration);
  assert.throws(() => store.credentialProvisioning.complete({ ...completed, initialAuthorizationGeneration: fixedOperationId }));
  const { initialAuthorizationGeneration: _ignored, ...withoutReceipt } = completed;
  assert.throws(() => store.credentialProvisioning.complete(withoutReceipt));
  assert.deepEqual(store.credentialProvisioning.get(identity), completed);
});

test("deleting and recreating the same resource binding does not change its old provisioning generation receipt", t => {
  const { store, path } = disk(t), completed = store.credentialProvisioning.complete(reachReady(store));
  const original = store.credentials.get(identity)!;
  const db = new DatabaseSync(path); t.after(() => db.close());
  db.prepare("DELETE FROM employee_credentials WHERE identity_key = ?").run(credentialIdentityKey(identity));
  const replacement = store.credentials.save(identity, { vaultId: "vault", credentialId: "credential", status: "binding", scopes: [], expiresAt: 0 }, 0);
  assert.equal(completed.initialAuthorizationGeneration, original.authorizationGeneration);
  assert.notEqual(completed.initialAuthorizationGeneration, replacement.authorizationGeneration);
  assert.deepEqual(store.credentialProvisioning.complete(completed), completed);
});

test("an old completed journal without a generation remains readable and cannot manufacture one", t => {
  const { store, path } = disk(t), completed = store.credentialProvisioning.complete(reachReady(store));
  const db = new DatabaseSync(path); t.after(() => db.close());
  const row = db.prepare("SELECT * FROM employee_credential_provisioning").get()!;
  const context = JSON.stringify(["credential-provisioning", row.identity_key, row.operation_id, row.revision]);
  const legacy = { ...completed }; delete legacy.initialAuthorizationGeneration;
  db.prepare("UPDATE employee_credential_provisioning SET secret = ?").run(store.credentials.sealAuthorization(JSON.stringify(legacy), context));
  assert.deepEqual(store.credentialProvisioning.get(identity), legacy);
  assert.deepEqual(store.credentialProvisioning.complete(legacy), legacy);
  assert.equal(Object.hasOwn(store.credentialProvisioning.get(identity)!, "initialAuthorizationGeneration"), false);
});

test("an invalid authenticated initial generation is rejected when the journal is read back", t => {
  const { store, path } = disk(t);
  const completed = store.credentialProvisioning.complete(reachReady(store));
  const db = new DatabaseSync(path); t.after(() => db.close());
  const row = db.prepare("SELECT * FROM employee_credential_provisioning").get()!;
  const context = JSON.stringify(["credential-provisioning", row.identity_key, row.operation_id, row.revision]);
  db.prepare("UPDATE employee_credential_provisioning SET secret = ?").run(store.credentials.sealAuthorization(
    JSON.stringify({ ...completed, initialAuthorizationGeneration: "invalid-generation" }), context));
  assert.throws(() => store.credentialProvisioning.get(identity), /结构|预置/);
});

test("a missing generation returned by binding creation rolls back the entire provisioning completion", t => {
  const store = memory(t), ready = reachReady(store), save = store.credentials.save.bind(store.credentials);
  store.credentials.save = (...args) => ({ ...save(...args), authorizationGeneration: undefined });
  assert.throws(() => store.credentialProvisioning.complete(ready), /代次/);
  assert.equal(store.credentials.get(identity), undefined);
  assert.deepEqual(store.credentialProvisioning.get(identity), ready);
  store.credentials.save = save;
  const completed = store.credentialProvisioning.complete(ready);
  assert.equal(completed.initialAuthorizationGeneration, store.credentials.get(identity)?.authorizationGeneration);
});

for (const phase of ["vault_pending", "vault_confirmed", "credential_pending", "ready"] as const)
test(`${phase} cannot carry a premature initial authorization generation`, t => {
  const store = memory(t);
  let record = store.credentialProvisioning.begin(identity);
  if (phase !== "vault_pending") record = store.credentialProvisioning.confirmVault(record, "vault");
  if (phase === "credential_pending" || phase === "ready") record = store.credentialProvisioning.beginCredential(record);
  if (phase === "ready") record = store.credentialProvisioning.confirmCredential(record, "credential");
  assert.throws(() => provisioningMetadata({ ...record, initialAuthorizationGeneration: fixedOperationId }, "vault"));
  assert.deepEqual(store.credentialProvisioning.get(identity), record);
});

for (const generation of [undefined, null, "", "invalid", 1])
test(`an invalid initial authorization generation fails encrypted journal validation: ${String(generation)}`, t => {
  const store = memory(t), completed = store.credentialProvisioning.complete(reachReady(store));
  assert.throws(() => provisioningMetadata({ ...completed, initialAuthorizationGeneration: generation } as CredentialProvisioningRecord, "vault"));
});

test("another binding for the same identity prevents completion without overwriting its credentials", t => {
  const store = memory(t), ready = reachReady(store);
  store.credentials.save(identity, { ...known, vaultId: "replacement-vault", credentialId: "replacement-credential" }, 0);
  const before = store.credentials.get(identity);
  assert.throws(() => store.credentialProvisioning.complete(ready), /绑定|预置/);
  assert.deepEqual(store.credentials.get(identity), before);
  assert.deepEqual(store.credentialProvisioning.get(identity), ready);
});

test("a Vault already assigned to another identity is rejected before a Credential intent", t => {
  const store = memory(t); store.credentials.save(other, known, 0);
  const first = store.credentialProvisioning.begin(identity);
  assert.throws(() => store.credentialProvisioning.confirmVault(first, known.vaultId), /身份|归属|Vault/);
  assert.equal(store.credentialProvisioning.get(identity)?.phase, "vault_pending");
});

test("two provisioning journals cannot claim the same Vault", t => {
  const store = memory(t), first = store.credentialProvisioning.begin(identity), second = store.credentialProvisioning.begin(other);
  store.credentialProvisioning.confirmVault(first, "vault");
  assert.throws(() => store.credentialProvisioning.confirmVault(second, "vault"), /身份|归属|Vault|UNIQUE/);
  assert.equal(store.credentialProvisioning.get(other)?.phase, "vault_pending");
});

test("a competing bound identity is rechecked before entering credential_pending", t => {
  const store = memory(t), first = store.credentialProvisioning.begin(identity);
  const vault = store.credentialProvisioning.confirmVault(first, "vault");
  store.credentials.save(other, known, 0);
  assert.throws(() => store.credentialProvisioning.beginCredential(vault), /身份|归属|Vault/);
  assert.deepEqual(store.credentialProvisioning.get(identity), vault);
});

for (const vaultId of ["vault", "replacement-vault"])
test(`a local binding to ${vaultId} stops any new Credential intent for the same identity`, t => {
  const store = memory(t), first = store.credentialProvisioning.begin(identity);
  const vault = store.credentialProvisioning.confirmVault(first, "vault");
  store.credentials.save(identity, { ...known, vaultId }, 0);
  const binding = store.credentials.get(identity);
  assert.throws(() => store.credentialProvisioning.beginCredential(vault), /绑定|预置/);
  assert.deepEqual(store.credentialProvisioning.get(identity), vault);
  assert.deepEqual(store.credentials.get(identity), binding);
});

for (const target of ["employee_credentials", "employee_credential_provisioning"] as const)
test(`a ${target} write failure rolls back both the binding and completed journal`, t => {
  const { store, path } = disk(t), ready = reachReady(store);
  const db = new DatabaseSync(path); t.after(() => db.close());
  db.exec(target === "employee_credentials"
    ? "CREATE TRIGGER fail_binding BEFORE INSERT ON employee_credentials BEGIN SELECT RAISE(ABORT, 'test write failure'); END"
    : "CREATE TRIGGER fail_provision BEFORE UPDATE ON employee_credential_provisioning BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
  assert.throws(() => store.credentialProvisioning.complete(ready), /test write failure/);
  assert.equal(store.credentials.get(identity), undefined);
  assert.deepEqual(store.credentialProvisioning.get(identity), ready);
  db.exec(target === "employee_credentials" ? "DROP TRIGGER fail_binding" : "DROP TRIGGER fail_provision");
  const completed = store.credentialProvisioning.complete(ready);
  assert.equal(completed.phase, "completed");
  assert.equal(completed.initialAuthorizationGeneration, store.credentials.get(identity)?.authorizationGeneration);
});

test("association metadata stays stable for each exact request and changes for different operations", t => {
  const store = memory(t), first = store.credentialProvisioning.begin(identity);
  const original = provisioningMetadata(first, "vault"), confirmed = store.credentialProvisioning.confirmVault(first, "vault");
  assert.deepEqual(provisioningMetadata(confirmed, "vault"), original);
  assert.deepEqual(Object.keys(original).sort(), ["arkagent_provision_operation", "arkagent_provision_request", "external_user_id"]);
  assert.equal(original.arkagent_provision_operation, first.operationId);
  assert.match(original.arkagent_provision_request, /^[a-f0-9]{64}$/);
  assert.equal(original.external_user_id, createHash("sha256").update(credentialIdentityKey(identity)).digest("hex"));
  assert.throws(() => provisioningMetadata(first, "credential"), /Vault|预置|请求/);
  const pending = store.credentialProvisioning.beginCredential(confirmed), ready = store.credentialProvisioning.confirmCredential(pending, "credential");
  assert.deepEqual(provisioningMetadata(pending, "credential"), provisioningMetadata(ready, "credential"));
  assert.notEqual(provisioningMetadata(pending, "credential").arkagent_provision_request, original.arkagent_provision_request);
});

for (const change of ["identity_key", "operation_id", "revision", "vault_id"] as const)
test(`metadata tampering in ${change} cannot be accepted as another provisioning record`, t => {
  const { store, path } = disk(t); reachReady(store);
  const db = new DatabaseSync(path); t.after(() => db.close());
  db.prepare(`UPDATE employee_credential_provisioning SET ${change} = ?`).run(change === "revision" ? 99
    : change === "identity_key" ? credentialIdentityKey(other) : "changed");
  assert.throws(() => store.credentialProvisioning.get(change === "identity_key" ? other : identity), /解密|预置|记录/);
});

for (const change of ["extra", "time", "phase", "name", "identity", "oversize"] as const)
test(`an authenticated but invalid ${change} provisioning record fails closed`, t => {
  const { store, path } = disk(t), ready = reachReady(store);
  const db = new DatabaseSync(path); t.after(() => db.close());
  const row = db.prepare("SELECT * FROM employee_credential_provisioning").get()!;
  const context = JSON.stringify(["credential-provisioning", row.identity_key, row.operation_id, row.revision]);
  const payload = JSON.parse(store.credentials.openAuthorization(String(row.secret), context));
  if (change === "extra") payload.accessToken = "not-allowed";
  if (change === "time") payload.credentialRequestedAt = ready.createdAt - 100;
  if (change === "phase") payload.phase = "vault_pending";
  if (change === "name") payload.vaultName = "another-vault-name";
  if (change === "identity") payload.identity = other;
  if (change === "oversize") payload.identity.openId = "x".repeat(20_000);
  db.prepare("UPDATE employee_credential_provisioning SET secret = ?").run(store.credentials.sealAuthorization(JSON.stringify(payload), context));
  assert.throws(() => store.credentialProvisioning.get(identity), /预置|记录|身份/);
});
