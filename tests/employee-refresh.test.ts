import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EmployeeAuthorizationManager } from "../src/employee-auth.ts";
import { GatewayStore } from "../src/store.ts";
import { Gateway, type IncomingMessage } from "../src/gateway.ts";
import { OAuthError } from "../src/oauth.ts";
import { setTimeout as delay } from "node:timers/promises";

const identity = { channelType: "lark", installationId: "cli", tenantId: "tenant", openId: "ou-one" };
const message: IncomingMessage = { channelType: "lark", installationId: "cli", tenantId: "tenant", senderId: "ou-one",
  eventId: "event", messageId: "event", conversationId: "chat", conversationType: "direct", threadId: "", rootMessageId: "", parentMessageId: "",
  text: "你好", resources: [], mentionedBot: false, createTime: 1 };
const initial = { vaultId: "vault", credentialId: "credential", status: "ready" as const,
  refreshToken: "old-refresh", expiresAt: 1, scopes: ["calendar:calendar.event:read"] };
const fresh = { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: Date.now() + 3_600_000 };

function manager(store: GatewayStore, refresh: () => Promise<typeof fresh>, update: (token: string) => Promise<void>) {
  return new EmployeeAuthorizationManager(store, {
    listVaults: async () => [], createVault: async () => "vault", listCredentials: async () => [],
    createEnvironmentVariableCredential: async () => "credential",
    updateEnvironmentCredential: async (_vault, _credential, value) => update(value)
  }, { applicationId: "cli", refresh } as never, async () => { throw new Error("unexpected OAuth"); }, () => undefined);
}

test("valid credentials, unauthorized greetings and group messages never refresh or initiate OAuth", async () => {
  const store = new GatewayStore(":memory:");
  let calls = 0;
  const auth = manager(store, async () => { calls++; return fresh; }, async () => { calls++; });
  await auth.ensureCredentialFresh(message);
  store.credentials.save(identity, { ...initial, expiresAt: Date.now() + 600_000 }, 0);
  await auth.ensureCredentialFresh(message);
  await auth.ensureCredentialFresh({ ...message, conversationType: "group" });
  assert.equal(calls, 0);
  assert.deepEqual(await auth.vaultIds({ ...message, conversationType: "group" }), []);
  store.close();
});

test("concurrent refresh calls rotate once and persist before MA update", async () => {
  const store = new GatewayStore(":memory:");
  store.credentials.save(identity, initial, 0);
  let calls = 0;
  const auth = manager(store, async () => { calls++; return fresh; }, async token => {
    assert.equal(token, fresh.accessToken);
    const persisted = store.credentials.get(identity)!;
    assert.equal(persisted.refreshToken, fresh.refreshToken);
    assert.equal(persisted.status, "sync_pending");
  });
  await Promise.all(Array.from({ length: 10 }, () => auth.ensureCredentialFresh(message)));
  assert.equal(calls, 1);
  assert.equal(store.credentials.get(identity)?.status, "ready");
  assert.equal(store.credentials.get(identity)?.pendingAccessToken, undefined);
  store.close();
});

test("MA update failure preserves rotated tokens; restart only retries the same Credential update", async t => {
  const dir = mkdtempSync(join(tmpdir(), "arkagent-refresh-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db");
  const first = new GatewayStore(path);
  first.credentials.save(identity, initial, 0);
  let refreshes = 0;
  const one = manager(first, async () => { refreshes++; return fresh; }, async () => { throw new Error("secret-upstream-response"); });
  await assert.rejects(one.ensureCredentialFresh(message), /凭证同步.*稍后重试/);
  assert.equal(first.credentials.get(identity)?.status, "sync_pending");
  first.close();
  const second = new GatewayStore(path); t.after(() => second.close());
  const tokens: string[] = [];
  const two = manager(second, async () => { refreshes++; throw new Error("must not refresh again"); }, async token => { tokens.push(token); });
  await two.ensureCredentialFresh(message);
  assert.equal(refreshes, 1);
  assert.deepEqual(tokens, [fresh.accessToken]);
  assert.equal(second.credentials.get(identity)?.credentialId, "credential");
});

test("only explicit invalid grant requires reauthorization, never network or rate-limit text", async () => {
  for (const kind of ["reauth_required", "rate_limit", "network"] as const) {
    const store = new GatewayStore(":memory:");
    store.credentials.save(identity, initial, 0);
    const writes: string[] = [];
    const auth = manager(store, async () => { throw new OAuthError(kind, { outcome: kind === "network" ? "unknown" : "rejected", retryAfterMs: 60_000 }); }, async token => { writes.push(token); });
    if (kind === "reauth_required") {
      await auth.ensureCredentialFresh(message);
      assert.equal(store.credentials.get(identity)?.status, "reauth_required");
      assert.deepEqual(writes, ["ARKAGENT_USER_AUTH_PENDING"]);
    } else {
      await assert.rejects(auth.ensureCredentialFresh(message));
      assert.equal(store.credentials.get(identity)?.refreshToken, initial.refreshToken);
      assert.equal(store.credentials.get(identity)?.status, kind === "network" ? "refresh_uncertain" : "ready");
      assert.deepEqual(writes, []);
    }
    store.close();
  }
});

test("refresh-in-flight state after crash is uncertain and does not reuse old Refresh Token", async () => {
  const store = new GatewayStore(":memory:");
  store.credentials.save(identity, { ...initial, status: "refreshing" }, 0);
  let calls = 0;
  const auth = manager(store, async () => { calls++; return fresh; }, async () => undefined);
  await assert.rejects(auth.ensureCredentialFresh(message), /刷新结果尚未确认/);
  assert.equal(calls, 0);
  assert.equal(store.credentials.get(identity)?.status, "refresh_uncertain");
  store.close();
});

test("late refresh response after shutdown does not access the closed database or update MA", async () => {
  for (const succeeds of [true, false]) {
    const store = new GatewayStore(":memory:");
    store.credentials.save(identity, initial, 0);
    let resolveRefresh!: (value: typeof fresh) => void;
    let rejectRefresh!: (reason: Error) => void;
    let updates = 0;
    const auth = manager(store, () => new Promise((resolve, reject) => { resolveRefresh = resolve; rejectRefresh = reject; }), async () => { updates++; });
    const pending = auth.ensureCredentialFresh(message);
    const rejected = assert.rejects(pending, error => error instanceof OAuthError && error.kind === "cancelled");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.credentials.get(identity)?.status, "refreshing");
    auth.close(); store.close();
    if (succeeds) resolveRefresh(fresh); else rejectRefresh(new OAuthError("network"));
    await rejected;
    assert.equal(updates, 0);
  }
});

test("application mismatch rejects before any credential access or OAuth request", async () => {
  const store = new GatewayStore(":memory:");
  let calls = 0;
  const auth = manager(store, async () => { calls++; return fresh; }, async () => undefined);
  await assert.rejects(auth.vaultIds({ ...message, installationId: "other-app" }), /应用.*不一致/);
  assert.equal(calls, 0);
  store.close();
});

test("429 cooldown avoids another token exchange and resumes after the explicit retry deadline", async () => {
  const store = new GatewayStore(":memory:");
  store.credentials.save(identity, initial, 0);
  let calls = 0;
  const auth = manager(store, async () => {
    calls++;
    if (calls === 1) throw new OAuthError("rate_limit", { outcome: "rejected", retryAfterMs: 60_000 });
    return fresh;
  }, async () => undefined);
  await assert.rejects(auth.ensureCredentialFresh(message));
  await assert.rejects(auth.ensureCredentialFresh(message), /限流/);
  assert.equal(calls, 1);
  const state = store.credentials.get(identity)!;
  store.credentials.save(identity, { ...state, retryAfter: 0 }, state.revision);
  await auth.ensureCredentialFresh(message);
  assert.equal(calls, 2);
  assert.equal(store.credentials.get(identity)?.status, "ready");
  store.close();
});

test("expired pending Access Token uses the persisted rotated Refresh Token, never the old one", async () => {
  const store = new GatewayStore(":memory:");
  store.credentials.save(identity, { ...initial, status: "sync_pending", refreshToken: "rotated-refresh", pendingAccessToken: "expired-access" }, 0);
  let used = "";
  const auth = new EmployeeAuthorizationManager(store, {
    updateEnvironmentCredential: async (_vault: string, _credential: string, token: string) => { assert.equal(token, fresh.accessToken); }
  } as never, { applicationId: "cli", refresh: async (token: string) => { used = token; return fresh; } } as never, async () => undefined, () => undefined);
  await auth.ensureCredentialFresh(message);
  assert.equal(used, "rotated-refresh");
  store.close();
});

test("OAuth callback rejects wrong user or tenant and duplicate requests resume only once", async () => {
  for (const user of [{ openId: "wrong", tenantKey: "tenant" }, { openId: "ou-one", tenantKey: "wrong" }, { openId: "ou-one", tenantKey: "tenant" }]) {
    const store = new GatewayStore(":memory:");
    store.credentials.save(identity, { ...initial, status: "binding", refreshToken: undefined }, 0);
    const writes: string[] = [], resumes: string[] = [];
    let finish!: (tokens: typeof fresh) => void;
    const polling = new Promise<typeof fresh>(resolve => { finish = resolve; });
    const auth = new EmployeeAuthorizationManager(store, {
      updateEnvironmentCredential: async (_vault: string, _credential: string, token: string) => { writes.push(token); }
    } as never, { applicationId: "cli", begin: async () => ({ verificationUrl: "https://example.invalid/oauth", deviceCode: "device", expiresAt: Date.now() + 60_000, intervalMs: 1000 }), poll: async () => polling,
      getUserIdentity: async () => user } as never, async () => undefined, input => { resumes.push(input.messageId); });
    const request = { identity: "user" as const, errorType: "authentication" as const, subtype: "token_missing" as const, domain: "calendar" };
    await auth.ensure(message, request);
    await auth.ensure(message, request);
    finish(fresh);
    await delay(20);
    const valid = user.openId === identity.openId && user.tenantKey === identity.tenantId;
    assert.deepEqual(writes, valid ? [fresh.accessToken] : []);
    assert.deepEqual(resumes, valid ? [message.messageId] : []);
    store.close();
  }
});

test("Gateway refresh hook runs for every direct turn including reused Session but not group", async () => {
  const store = new GatewayStore(":memory:");
  store.credentials.save(identity, initial, 0);
  let creates = 0, refreshes = 0, hooks = 0;
  const runs: string[] = [], errors: string[] = [];
  const auth = manager(store, async () => { refreshes++; return fresh; }, async () => undefined);
  const gateway = new Gateway(store, {
    createSession: async () => `session-${++creates}`,
    run: async (sessionId: string) => { runs.push(sessionId); return { terminal: "idle" as const, messages: ["ok"] }; }
  }, async (_message, outbound) => { if (outbound.type === "text") errors.push(outbound.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "bot", timeoutMs: 1000, platformAccess: true, sharedGroupSessions: true,
    sessionCompaction: false, getUserVaultIds: input => auth.vaultIds(input),
    beforeDirectTurn: async input => { hooks++; await auth.ensureCredentialFresh(input); }
  });
  for (let i = 0; i < 2; i++) {
    gateway.accept({ ...message, eventId: `m${i}`, messageId: `m${i}` });
    await until(() => errors.length === i + 1);
  }
  gateway.accept({ ...message, eventId: "group", messageId: "group", conversationType: "group", mentionedBot: true });
  await until(() => errors.length === 3);
  assert.equal(hooks, 2);
  assert.equal(refreshes, 1);
  assert.deepEqual(runs, ["session-1", "session-1", "session-2"]);
  assert.equal(errors.some(text => /执行失败/.test(text)), false);
  store.close();
});

async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > end) throw new Error("测试未完成"); await delay(5); }
}
