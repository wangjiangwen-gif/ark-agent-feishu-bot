import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { GatewayStore } from "../src/store.ts";
import type { ChannelMessage } from "../src/channel.ts";

const identity = { channelType: "lark", installationId: "cli", tenantId: "tenant", openId: "user" };
const message: ChannelMessage = { channelType: "lark", installationId: "cli", tenantId: "tenant", senderId: "user", conversationType: "direct",
  conversationId: "chat", threadId: "", rootMessageId: "", parentMessageId: "", eventId: "event", messageId: "message",
  text: "private-request-body", resources: [], createTime: 1, mentionedBot: false };

test("authorization flow encrypts messages, device code and unverified tokens across reopen", t => {
  const dir = mkdtempSync(join(tmpdir(), "arkagent-auth-state-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db"); let store = new GatewayStore(path); t.after(() => store.close());
  let flow = store.authorizations.create(identity, [message]);
  flow = store.authorizations.save(identity, flow, { phase: "verifying", tokens: { accessToken: "private-access", refreshToken: "private-refresh", expiresAt: 999999 },
    device: { deviceCode: "private-device", verificationUrl: "https://example.test/private-url", expiresAt: 999999, intervalMs: 1000 } });
  store.close(); store = new GatewayStore(path);
  assert.deepEqual(store.authorizations.get(identity), flow);
  for (const secret of [message.text, "private-access", "private-refresh", "private-device", "private-url"]) assert.equal(readFileSync(path).includes(Buffer.from(secret)), false);
});

test("authorization CAS and unique active identity prevent replacement by a second manager", () => {
  const store = new GatewayStore(":memory:");
  try {
    const first = store.authorizations.create(identity, [message]);
    assert.throws(() => store.authorizations.create(identity, [message]), /授权流程/);
    const second = store.authorizations.save(identity, first, { phase: "waiting" });
    assert.throws(() => store.authorizations.save(identity, first, { phase: "cancelled" }), /版本/);
    store.authorizations.save(identity, second, { phase: "cancelled" });
    const replacement = store.authorizations.create(identity, [message]);
    assert.notEqual(replacement.id, first.id);
    assert.throws(() => store.authorizations.save(identity, second, { phase: "completed" }), /版本/);
  } finally { store.close(); }
});

test("terminal authorization removes reusable secrets and rejects cross-identity messages", () => {
  const store = new GatewayStore(":memory:");
  try {
    assert.throws(() => store.authorizations.create(identity, [{ ...message, senderId: "other" }]), /身份/);
    assert.throws(() => store.authorizations.create(identity, [{ ...message, conversationType: "group" }]), /单聊/);
    let flow = store.authorizations.create(identity, [message]);
    flow = store.authorizations.save(identity, flow, { phase: "verifying", tokens: { accessToken: "a", refreshToken: "r", expiresAt: 99999 } });
    flow = store.authorizations.save(identity, flow, { phase: "cancelled" });
    assert.equal(flow.tokens, undefined); assert.equal(flow.device, undefined);
    assert.deepEqual(store.authorizations.listActive("other"), []);
    assert.deepEqual(store.authorizations.listActive("cli"), []);
  } finally { store.close(); }
});

test("authorization-only database refuses a missing encryption key and authenticates flow metadata", t => {
  const dir = mkdtempSync(join(tmpdir(), "arkagent-auth-key-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db"); let store = new GatewayStore(path); t.after(() => store.close());
  store.authorizations.create(identity, [message]); store.close();
  const db = new DatabaseSync(path); db.exec("UPDATE employee_authorization_flows SET phase = 'ready'"); db.close();
  store = new GatewayStore(path);
  assert.throws(() => store.authorizations.get(identity), /解密/);
  store.close(); unlinkSync(`${path}.credential-key`); store = new GatewayStore(path);
  assert.throws(() => store.authorizations.get(identity), /密钥/);
});

test("credential staging and flow phase update roll back together on storage failure", t => {
  const dir = mkdtempSync(join(tmpdir(), "arkagent-auth-atomic-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db"); const store = new GatewayStore(path); t.after(() => store.close());
  store.credentials.save(identity, { vaultId: "vault", credentialId: "credential", status: "binding", expiresAt: 0, scopes: [] }, 0);
  const flow = store.authorizations.save(identity, store.authorizations.create(identity, [message]), { phase: "verifying" });
  const db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER fail_auth_phase BEFORE UPDATE ON employee_authorization_flows BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => store.stageAuthorizationCredential(flow, { accessToken: "a", refreshToken: "r", expiresAt: 999999 }, []), /injected/);
  assert.equal(store.credentials.get(identity)?.status, "binding");
  assert.equal(store.credentials.get(identity)?.refreshToken, undefined);
  assert.equal(store.authorizations.get(identity)?.phase, "verifying");
  db.exec("DROP TRIGGER fail_auth_phase"); db.close();
  store.stageAuthorizationCredential(flow, { accessToken: "a", refreshToken: "r", expiresAt: 999999 }, []);
  assert.equal(store.credentials.get(identity)?.status, "sync_pending");
  assert.equal(store.authorizations.get(identity)?.phase, "sync_pending");
});

test("cancelling flow and all joined recovery requests is one transaction", t => {
  const dir = mkdtempSync(join(tmpdir(), "arkagent-auth-stop-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db"); const store = new GatewayStore(path); t.after(() => store.close());
  const messages = [message, { ...message, messageId: "second" }];
  for (const item of messages) store.startAuthorizationRecovery(item, "original");
  const flow = store.authorizations.create(identity, messages);
  const db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER fail_auth_stop BEFORE UPDATE ON authorization_recoveries BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => store.finishAuthorizationFlow(flow, "cancelled"), /injected/);
  assert.equal(store.authorizations.get(identity)?.phase, "starting");
  assert.equal(store.getAuthorizationRecovery(message)?.state, "waiting");
  db.exec("DROP TRIGGER fail_auth_stop"); db.close();
  store.finishAuthorizationFlow(flow, "cancelled");
  for (const item of messages) assert.equal(store.getAuthorizationRecovery(item)?.state, "cancelled");
});
