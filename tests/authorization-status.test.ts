import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmployeeAuthorizationManager } from "../src/employee-auth.ts";
import { Gateway, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import type { AuthorizationPhase } from "../src/authorization-state.ts";
import type { CredentialState } from "../src/credential-state.ts";

const identity = { channelType: "lark", installationId: "cli", tenantId: "tenant", openId: "user" };
const message = (id = "original"): IncomingMessage => ({ ...identity, senderId: identity.openId,
  conversationId: "chat", conversationType: "direct", eventId: id, messageId: id,
  text: "private-request-secret", threadId: "", rootMessageId: "", parentMessageId: "", createTime: 1,
  resources: [], mentionedBot: false });
function manager(store: GatewayStore) {
  const forbidden = () => { throw new Error("状态查询不得触发外部操作"); };
  return new EmployeeAuthorizationManager(store, new Proxy({}, { get: () => forbidden }) as never,
    new Proxy({ applicationId: "cli" }, { get: (target, key) => key === "applicationId" ? target.applicationId : forbidden }) as never,
    forbidden, forbidden);
}

test("authorization status with no state is read-only and does not provision credentials", () => {
  const store = new GatewayStore(":memory:"), auth = manager(store);
  try {
    assert.match(auth.status(message()), /没有当前应用身份的授权记录/);
    assert.equal(store.authorizations.get(identity), undefined);
    assert.equal(store.credentials.get(identity), undefined);
  } finally { auth.close(); store.close(); }
});

for (const [phase, expected] of Object.entries({ starting: "正在发起", card_pending: "卡片发送结果待确认", waiting: "等待你完成授权",
  polling: "正在查询授权结果", verifying: "正在校验授权账号", sync_pending: "等待同步到 MA", ready: "授权已就绪",
  completed: "授权流程已结束", cancelled: "已取消", expired: "已过期", failed: "未完成", uncertain: "结果尚未确认" })) {
  test(`authorization status describes ${phase} without exposing payload or changing checkpoints`, () => {
    const store = new GatewayStore(":memory:"), auth = manager(store);
    try {
      const initial = store.authorizations.create(identity, [message()]);
      const flow = store.authorizations.save(identity, initial, { phase: phase as AuthorizationPhase, expiresAt: Date.now() + 60_000,
        device: { deviceCode: "device-secret", verificationUrl: "https://example.test/?token=secret", intervalMs: 1000, expiresAt: Date.now() + 60_000 },
        tokens: { accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: Date.now() + 60_000 } });
      const result = auth.status(message("status"));
      assert.ok(result.includes(expected), result);
      assert.doesNotMatch(result, /secret|example\.test/);
      assert.deepEqual(store.authorizations.get(identity), flow);
    } finally { auth.close(); store.close(); }
  });
}

test("authorization completion is distinct from blocked or still-resuming business tasks", () => {
  const store = new GatewayStore(":memory:"), auth = manager(store);
  try {
    const first = message(), second = message("second");
    const flow = store.authorizations.create(identity, [first, second]);
    store.authorizations.save(identity, flow, { phase: "completed" });
    store.startAuthorizationRecovery(first, "old-session"); store.finishAuthorizationRecovery(first, "blocked");
    store.startAuthorizationRecovery(second, "old-session"); store.claimAuthorizationRecovery(second);
    const result = auth.status(message("query"));
    assert.match(result, /待确认，未自动重放/);
    assert.match(result, /恢复任务已领取/);
    assert.match(result, /old-session/);
    assert.match(result, /不等于业务已完成/);
  } finally { auth.close(); store.close(); }
});

test("status isolates application, tenant, user, channel and conversation", () => {
  const store = new GatewayStore(":memory:"), auth = manager(store);
  try {
    store.authorizations.create(identity, [message()]);
    for (const patch of [{ tenantId: "other" }, { senderId: "other" }, { channelType: "other" }]) {
      assert.match(auth.status({ ...message(), ...patch }), /没有当前应用身份的授权记录/);
    }
    assert.throws(() => auth.status({ ...message(), installationId: "other" }), /应用/);
    assert.doesNotMatch(auth.status({ ...message(), conversationId: "another-chat" }), /正在发起/);
    assert.match(auth.status({ ...message(), conversationType: "group", mentionedBot: true }), /仅使用 Bot/);
  } finally { auth.close(); store.close(); }
});

test("credential status never claims live validity and expired waits do not renew themselves", () => {
  const store = new GatewayStore(":memory:"), auth = manager(store);
  try {
    store.credentials.save(identity, { vaultId: "vault-secret", credentialId: "credential-secret", status: "ready",
      refreshToken: "refresh-secret", scopes: ["private-scope-secret"], expiresAt: 1 }, 0);
    const flow = store.authorizations.create(identity, [message()]);
    const expired = store.authorizations.save(identity, flow, { phase: "waiting", expiresAt: 1 });
    const result = auth.status(message());
    assert.match(result, /凭证有效期已到/);
    assert.match(result, /等待期限已到/);
    assert.match(result, /未实时校验/);
    assert.doesNotMatch(result, /secret/);
    assert.deepEqual(store.authorizations.get(identity), expired);
  } finally { auth.close(); store.close(); }
});

test("authorization status survives database reopen without resuming OAuth", () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-auth-status-")), path = join(dir, "gateway.db");
  let store = new GatewayStore(path), auth = manager(store);
  try {
    const flow = store.authorizations.create(identity, [message()]);
    store.authorizations.save(identity, flow, { phase: "sync_pending", expiresAt: Date.now() + 60_000 });
    auth.close(); store.close(); store = new GatewayStore(path); auth = manager(store);
    assert.match(auth.status(message()), /等待同步到 MA/);
  } finally { auth.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const [status, expected] of Object.entries({ binding: "尚未完成授权", ready: "本地凭证已就绪", refreshing: "刷新请求进行中",
  refresh_uncertain: "刷新结果尚未确认", sync_pending: "等待同步到 MA", reauth_required: "需要重新授权" })) {
  test(`credential ${status} status is a read-only local snapshot`, () => {
    const store = new GatewayStore(":memory:"), auth = manager(store);
    try {
      store.credentials.save(identity, { vaultId: "vault-secret", credentialId: "credential-secret",
        status: status as CredentialState["status"], refreshToken: "refresh-secret", pendingAccessToken: "access-secret",
        expiresAt: Date.now() + 600_000, scopes: ["scope-secret"] }, 0);
      const state = store.credentials.get(identity);
      const result = auth.status(message());
      assert.ok(result.includes(expected), result);
      assert.doesNotMatch(result, /secret/);
      assert.deepEqual(store.credentials.get(identity), state);
    } finally { auth.close(); store.close(); }
  });
}

test("status bounds task output and hides malformed identifiers without discarding stored state", () => {
  const store = new GatewayStore(":memory:"), auth = manager(store);
  try {
    const messages = Array.from({ length: 12 }, (_, i) => message(`task-${i}`));
    messages[11].messageId = "<fake>message-secret</fake>";
    const flow = store.authorizations.create(identity, messages);
    store.startAuthorizationRecovery(messages[11], "<fake>session-secret</fake>");
    const result = auth.status(message());
    assert.match(result, /仅展示最近 10 条，共 12 条/);
    assert.match(result, /标识已隐藏/);
    assert.doesNotMatch(result, /secret|任务 task-0：|任务 task-1：/);
    assert.deepEqual(store.authorizations.get(identity), flow);
  } finally { auth.close(); store.close(); }
});

test("without employee authorization controls personal assistant command routing is unchanged", async t => {
  const store = new GatewayStore(":memory:"); let runs = 0;
  const gateway = new Gateway(store, { createSession: async () => "session", run: async (_id, input) => {
    assert.match(input, /\/auth status/); runs++; return { terminal: "idle", messages: ["done"] };
  } }, async () => undefined, { agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 1000, authorizedUserId: "user" });
  t.after(() => store.close());
  gateway.accept({ ...message(), text: "/auth status" }); await flush();
  assert.equal(runs, 1);
});

test("status bypasses paused business queue, remains deduplicated and never calls MA", async t => {
  const store = new GatewayStore(":memory:"), auth = manager(store), replies: string[] = [];
  let runs = 0, queries = 0;
  const gateway = new Gateway(store, { createSession: async () => "session", run: async () => {
    runs++; return { terminal: "idle", messages: ["done"] };
  } }, async (_m, result) => { if (result.type === "text") replies.push(result.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "bot", timeoutMs: 1000, platformAccess: true,
    authorizationStatus: m => { queries++; return auth.status(m); }
  });
  t.after(() => { auth.close(); store.close(); });
  gateway.setAuthorizationWaiting([message()], "flow", true);
  gateway.accept(message("queued"));
  const control = { ...message("status"), text: "/auth status" };
  assert.equal(gateway.accept(control), true); assert.equal(gateway.accept(control), false);
  await flush();
  assert.equal(queries, 1); assert.equal(replies.length, 1); assert.equal(runs, 0);
  gateway.setAuthorizationWaiting([message()], "flow", false); await flush();
  assert.equal(runs, 1);
});

test("status failures are sanitized and group status does not inspect personal authorization", async t => {
  const store = new GatewayStore(":memory:"), replies: string[] = []; let queries = 0, runs = 0;
  const gateway = new Gateway(store, { createSession: async () => "session", run: async () => {
    runs++; return { terminal: "idle", messages: ["done"] };
  } }, async (_m, result) => { if (result.type === "text") replies.push(result.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "bot", timeoutMs: 1000, platformAccess: true,
    authorizationStatus: () => { queries++; throw new Error("access-secret"); }
  });
  t.after(() => store.close());
  gateway.accept({ ...message("direct"), text: "/auth status" });
  gateway.accept({ ...message("group"), text: "/auth status", conversationType: "group", mentionedBot: true });
  await flush();
  assert.equal(queries, 1); assert.equal(runs, 0);
  assert.match(replies.join("\n"), /查询授权状态失败/);
  assert.match(replies.join("\n"), /仅使用 Bot/);
  assert.doesNotMatch(replies.join("\n"), /secret/);
});
