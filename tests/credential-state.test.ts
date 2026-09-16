import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { GatewayStore } from "../src/store.ts";
import { execFileSync } from "node:child_process";

const identity = { channelType: "lark", installationId: "cli-one", tenantId: "tenant", openId: "ou-one" };
const binding = { vaultId: "vault", credentialId: "credential", status: "ready" as const,
  refreshToken: "test-private-refresh-value", expiresAt: 123456, scopes: ["calendar:read"] };

test("credential state is encrypted at rest, authenticated to identity and survives reopen", t => {
  const dir = mkdtempSync(join(tmpdir(), "arkagent-credential-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db");
  const store = new GatewayStore(path);
  store.credentials.save(identity, binding, 0);
  const saved = store.credentials.get(identity)!;
  assert.equal(saved.refreshToken, binding.refreshToken);
  assert.equal(saved.revision, 1);
  assert.equal(statSync(`${path}.credential-key`).mode & 0o777, 0o600);
  store.close();
  assert.equal(readFileSync(path).includes(Buffer.from(binding.refreshToken)), false);
  const second = new GatewayStore(path); t.after(() => second.close());
  assert.equal(second.credentials.get(identity)?.refreshToken, binding.refreshToken);
  assert.equal(second.credentials.get({ ...identity, installationId: "other" }), undefined);
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE employee_credentials SET identity_key = ?, installation_id = ?").run(
    JSON.stringify([identity.channelType, "other", identity.tenantId, identity.openId]), "other");
  raw.close();
  assert.throws(() => second.credentials.get({ ...identity, installationId: "other" }), /凭证.*解密/);
});

test("credential key cannot silently regenerate after data exists", t => {
  const dir = mkdtempSync(join(tmpdir(), "arkagent-credential-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db");
  const first = new GatewayStore(path);
  first.credentials.save(identity, binding, 0); first.close();
  unlinkSync(`${path}.credential-key`);
  const second = new GatewayStore(path); t.after(() => second.close());
  assert.throws(() => second.credentials.get(identity), /凭证.*密钥/);
  assert.throws(() => second.credentials.save({ ...identity, openId: "other" }, binding, 0), /凭证.*密钥/);
});

test("credential revision prevents lost updates and binding without authorization is private", () => {
  const store = new GatewayStore(":memory:");
  store.credentials.save(identity, { ...binding, status: "binding", refreshToken: undefined }, 0);
  assert.deepEqual(store.knownUserVaultIds(), ["vault"]);
  assert.throws(() => store.credentials.save(identity, binding, 0), /版本已变化/);
  store.credentials.save(identity, binding, 1);
  assert.equal(store.credentials.get(identity)?.revision, 2);
  store.close();
});

test("database coordination excludes concurrent refresh even across manager instances", t => {
  const dir = mkdtempSync(join(tmpdir(), "arkagent-credential-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db");
  const first = new GatewayStore(path), second = new GatewayStore(path);
  t.after(() => { first.close(); second.close(); });
  const lease = first.credentials.acquire(identity);
  assert.throws(() => second.credentials.acquire(identity), /凭证操作正在进行/);
  first.credentials.release(identity, "wrong-owner");
  assert.throws(() => second.credentials.acquire(identity), /凭证操作正在进行/);
  first.credentials.release(identity, lease);
  const next = second.credentials.acquire(identity);
  second.credentials.release(identity, next);
});

test("pending rotated tokens survive restart without exposing plaintext in database", t => {
  const dir = mkdtempSync(join(tmpdir(), "arkagent-pending-token-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db");
  const first = new GatewayStore(path);
  first.credentials.save(identity, { ...binding, status: "sync_pending", pendingAccessToken: "test-private-access-value" }, 0);
  first.close();
  const second = new GatewayStore(path); t.after(() => second.close());
  assert.equal(second.credentials.get(identity)?.pendingAccessToken, "test-private-access-value");
  assert.equal(second.credentials.get(identity)?.status, "sync_pending");
  assert.equal(readFileSync(path).includes(Buffer.from("test-private-access-value")), false);
});

test("unsafe credential key permissions fail closed without printing secrets", t => {
  const dir = mkdtempSync(join(tmpdir(), "arkagent-key-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db");
  writeFileSync(`${path}.credential-key`, Buffer.alloc(32, 1), { mode: 0o644 });
  const store = new GatewayStore(path); t.after(() => store.close());
  assert.throws(() => store.credentials.save(identity, binding, 0), /凭证.*密钥/);
});

test("legacy plaintext is encrypted before use and migrates only with same-app Session evidence", t => {
  const dir = mkdtempSync(join(tmpdir(), "arkagent-legacy-credential-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db");
  new GatewayStore(path).close();
  const legacy = new DatabaseSync(path);
  legacy.prepare("INSERT INTO employee_oauth VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    identity.tenantId, identity.openId, binding.vaultId, binding.credentialId, "legacy-refresh-secret", binding.expiresAt, "[]", "now");
  legacy.close();
  const store = new GatewayStore(path);
  store.credentials.prepare();
  const reader = new DatabaseSync(path, { readOnly: true });
  assert.match(String(reader.prepare("SELECT refresh_token FROM employee_oauth").get()?.refresh_token), /^sealed:v1:/);
  reader.close();
  assert.equal(store.migrateEmployeeCredential(identity), undefined, "没有归属证据不能按旧openid静默认领");
  store.saveSession({ channelType: identity.channelType, installationId: identity.installationId, tenantId: identity.tenantId,
    senderId: identity.openId, conversationId: "direct", threadId: "" }, "original", "agent", undefined, ["bot", "vault"]);
  assert.equal(store.migrateEmployeeCredential({ ...identity, installationId: "other-app" }), undefined);
  const migrated = store.migrateEmployeeCredential(identity)!;
  assert.equal(migrated.refreshToken, "legacy-refresh-secret");
  assert.equal(migrated.credentialId, binding.credentialId);
  assert.equal(store.getEmployeeOAuth(identity.tenantId, identity.openId), undefined);
  store.close();
  assert.equal(readFileSync(path).includes(Buffer.from("legacy-refresh-secret")), false);
});

test("credential operation can be recovered after the owning process exits", t => {
  const dir = mkdtempSync(join(tmpdir(), "arkagent-dead-refresh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db");
  const script = `import { GatewayStore } from './src/store.ts'; const store = new GatewayStore(${JSON.stringify(path)}); store.credentials.acquire(${JSON.stringify(identity)}); process.exit(0);`;
  execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: "pipe" });
  const store = new GatewayStore(path); t.after(() => store.close());
  const lease = store.credentials.acquire(identity);
  assert.equal(typeof lease, "string");
  store.credentials.release(identity, lease);
});

test("a Credential cannot be assigned to two identities", () => {
  const store = new GatewayStore(":memory:");
  store.credentials.save(identity, binding, 0);
  assert.throws(() => store.credentials.save({ ...identity, openId: "other-user" }, binding, 0), /UNIQUE/);
  store.close();
});

test("legacy migration refuses ambiguous application ownership instead of the first claimant winning", () => {
  const store = new GatewayStore(":memory:");
  store.saveEmployeeOAuth({ tenantKey: identity.tenantId, openId: identity.openId, ...binding });
  for (const app of [identity.installationId, "other-app"]) store.saveSession({
    channelType: identity.channelType, installationId: app, tenantId: identity.tenantId,
    senderId: identity.openId, conversationId: "chat", threadId: ""
  }, `session-${app}`, "agent", undefined, [binding.vaultId]);
  assert.throws(() => store.migrateEmployeeCredential(identity), /归属.*不唯一/);
  assert.equal(store.credentials.get(identity), undefined);
  assert.equal(store.getEmployeeOAuth(identity.tenantId, identity.openId)?.credentialId, binding.credentialId);
  store.close();
});

test("legacy migration is atomic when removing the old row fails", t => {
  const dir = mkdtempSync(join(tmpdir(), "arkagent-migration-atomic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db");
  const store = new GatewayStore(path); t.after(() => store.close());
  store.saveEmployeeOAuth({ tenantKey: identity.tenantId, openId: identity.openId, ...binding });
  store.saveSession({ channelType: identity.channelType, installationId: identity.installationId, tenantId: identity.tenantId,
    senderId: identity.openId, conversationId: "chat", threadId: "" }, "session", "agent", undefined, [binding.vaultId]);
  const db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER reject_legacy_delete BEFORE DELETE ON employee_oauth BEGIN SELECT RAISE(ABORT, 'test interruption'); END");
  db.close();
  assert.throws(() => store.migrateEmployeeCredential(identity), /test interruption/);
  assert.equal(store.credentials.get(identity), undefined);
  assert.equal(store.getEmployeeOAuth(identity.tenantId, identity.openId)?.credentialId, binding.credentialId);
});

test("a private Vault cannot be shared across identities through different Credentials", () => {
  const store = new GatewayStore(":memory:");
  store.credentials.save(identity, binding, 0);
  assert.throws(() => store.credentials.save({ ...identity, openId: "other" }, { ...binding, credentialId: "different" }, 0), /UNIQUE/);
  store.close();
});
