import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { GatewayStore } from "../src/store.ts";
import { credentialIdentityKey } from "../src/credential-state.ts";

const identity = { channelType: "lark", installationId: "cli-generation", tenantId: "tenant", openId: "ou-one" };
const value = { vaultId: "vault-generation", credentialId: "credential-generation", status: "ready" as const,
  refreshToken: "private-refresh-original", expiresAt: 100_000, scopes: ["calendar:read", "offline_access"] };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function diskStore(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "ark-credential-generation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db");
  return { path, store: new GatewayStore(path) };
}

function overwriteSecret(path: string, secret: Record<string, unknown>): void {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", readFileSync(`${path}.credential-key`), iv);
  cipher.setAAD(Buffer.from(credentialIdentityKey(identity)));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
  const db = new DatabaseSync(path);
  try {
    db.prepare("UPDATE employee_credentials SET secret = ? WHERE identity_key = ?").run(
      `sealed:v1:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}`, credentialIdentityKey(identity));
  } finally { db.close(); }
}

test("initial credentials receive an encrypted persistent authorization generation", t => {
  const { path, store } = diskStore(t);
  const saved = store.credentials.save(identity, value, 0);
  assert.match(saved.authorizationGeneration!, uuid);
  assert.equal(store.credentials.get(identity)?.authorizationGeneration, saved.authorizationGeneration);
  store.close();
  const bytes = readFileSync(path);
  assert.equal(bytes.includes(Buffer.from(saved.authorizationGeneration!)), false);
  assert.equal(bytes.includes(Buffer.from(value.refreshToken)), false);
  const reopened = new GatewayStore(path); t.after(() => reopened.close());
  assert.equal(reopened.credentials.get(identity)?.authorizationGeneration, saved.authorizationGeneration);
});

test("a legacy encrypted row is read without fabricated proof and gains a generation on its next write", t => {
  const { path, store } = diskStore(t);
  store.credentials.save(identity, value, 0);
  overwriteSecret(path, { refreshToken: value.refreshToken });
  const legacy = store.credentials.get(identity)!;
  assert.equal(legacy.authorizationGeneration, undefined);
  const saved = store.credentials.save(identity, legacy, legacy.revision);
  assert.match(saved.authorizationGeneration!, uuid);
  store.close();
  const reopened = new GatewayStore(path); t.after(() => reopened.close());
  assert.equal(reopened.credentials.get(identity)?.authorizationGeneration, saved.authorizationGeneration);
});

test("token refresh, sync and transient states keep the same authorization generation", t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  let state = store.credentials.save(identity, value, 0);
  const generation = state.authorizationGeneration;
  assert.match(generation!, uuid);
  for (const status of ["refreshing", "refresh_uncertain", "sync_pending", "ready"] as const) {
    state = store.credentials.save(identity, { ...state, status, refreshToken: `rotated-${status}`,
      pendingAccessToken: status === "sync_pending" ? "pending-access" : undefined,
      expiresAt: state.expiresAt + 60_000, retryAfter: status === "ready" ? 500 : undefined }, state.revision);
    assert.equal(state.authorizationGeneration, generation);
    assert.equal(store.credentials.get(identity)?.authorizationGeneration, generation);
  }
});

test("scope ordering and duplicate scopes do not create a new authorization generation", t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  const initial = store.credentials.save(identity, value, 0);
  const saved = store.credentials.save(identity, { ...initial, scopes: ["offline_access", "calendar:read", "calendar:read"] }, initial.revision);
  assert.match(initial.authorizationGeneration!, uuid);
  assert.equal(saved.authorizationGeneration, initial.authorizationGeneration);
});

for (const [name, patch] of [
  ["added scope", { scopes: [...value.scopes, "calendar:write"] }],
  ["removed scope", { scopes: ["calendar:read"] }],
  ["empty scope", { scopes: [] }],
  ["new Vault", { vaultId: "vault-other" }],
  ["new Credential", { credentialId: "credential-other" }]
] as const) test(`${name} rotates the authorization generation`, t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  const initial = store.credentials.save(identity, value, 0);
  const saved = store.credentials.save(identity, { ...initial, ...patch }, initial.revision);
  assert.match(saved.authorizationGeneration!, uuid);
  assert.notEqual(saved.authorizationGeneration, initial.authorizationGeneration);
});

test("an explicit new authorization rotates generation despite identical identity and scopes", t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  const initial = store.credentials.save(identity, value, 0);
  const rotated = store.credentials.save(identity, initial, initial.revision, true);
  assert.match(rotated.authorizationGeneration!, uuid);
  assert.notEqual(rotated.authorizationGeneration, initial.authorizationGeneration);
  const synced = store.credentials.save(identity, { ...rotated, status: "sync_pending", pendingAccessToken: "fresh-access" }, rotated.revision);
  assert.equal(synced.authorizationGeneration, rotated.authorizationGeneration);
});

test("callers cannot select, restore or overwrite an authorization generation", t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  const supplied = "00000000-0000-4000-8000-000000000000";
  const initial = store.credentials.save(identity, { ...value, authorizationGeneration: supplied }, 0);
  assert.match(initial.authorizationGeneration!, uuid);
  assert.notEqual(initial.authorizationGeneration, supplied);
  const rotated = store.credentials.save(identity, initial, initial.revision, true);
  const restored = store.credentials.save(identity, { ...rotated, authorizationGeneration: initial.authorizationGeneration }, rotated.revision);
  assert.equal(restored.authorizationGeneration, rotated.authorizationGeneration);
  const invalid = store.credentials.save(identity, { ...restored, authorizationGeneration: "not-a-generation" }, restored.revision);
  assert.equal(invalid.authorizationGeneration, rotated.authorizationGeneration);
});

test("stale and missing revision writes cannot rotate or partially replace credentials", t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  const initial = store.credentials.save(identity, value, 0);
  store.credentials.save(identity, { ...initial, refreshToken: "second-token" }, initial.revision);
  const latest = store.credentials.get(identity);
  assert.throws(() => store.credentials.save(identity, { ...initial, scopes: ["write"] }, initial.revision, true), /版本已变化/);
  assert.deepEqual(store.credentials.get(identity), latest);
  assert.throws(() => store.credentials.save({ ...identity, openId: "missing" }, { ...value, vaultId: "unused" }, 7, true), /版本已变化/);
  assert.equal(store.credentials.get({ ...identity, openId: "missing" }), undefined);
});

test("binding uniqueness failures do not rotate or partially write generation", t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  const initial = store.credentials.save(identity, value, 0);
  const secondIdentity = { ...identity, openId: "ou-two" };
  const second = store.credentials.save(secondIdentity, { ...value, vaultId: "vault-second", credentialId: "credential-second" }, 0);
  const before = store.credentials.get(identity), secondBefore = store.credentials.get(secondIdentity);
  assert.throws(() => store.credentials.save(identity, { ...initial, vaultId: second.vaultId }, initial.revision, true), /UNIQUE/);
  assert.deepEqual(store.credentials.get(identity), before);
  assert.deepEqual(store.credentials.get(secondIdentity), secondBefore);
});

for (const invalid of [null, 42, "", "not-a-generation", "A0000000-0000-4000-8000-000000000000", []]) {
  test(`malformed encrypted generation is rejected (${JSON.stringify(invalid)})`, t => {
    const { path, store } = diskStore(t); t.after(() => store.close());
    store.credentials.save(identity, value, 0);
    overwriteSecret(path, { refreshToken: value.refreshToken, authorizationGeneration: invalid });
    assert.throws(() => store.credentials.get(identity), /授权代次.*无效/);
    assert.throws(() => store.credentials.save(identity, value, 1), /授权代次.*无效/);
  });
}
