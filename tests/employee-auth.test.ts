import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { EmployeeAuthorizationManager, EMPLOYEE_CALENDAR_USER_SCOPES } from "../src/employee-auth.ts";
import { Gateway, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import { OAuthError } from "../src/oauth.ts";

const identity = { channelType: "lark", installationId: "cli", tenantId: "tenant", openId: "ou-one" };

test("employee authorization maps only explicit calendar tool failures to calendar scopes", () => {
  assert.ok(EMPLOYEE_CALENDAR_USER_SCOPES.includes("calendar:calendar.free_busy:read"));
});

test("unsupported lark-cli domains do not open an unrelated calendar OAuth flow", async () => {
  const store = new GatewayStore(":memory:");
  const auth = new EmployeeAuthorizationManager(store, {
    listVaults: async () => [], createVault: async () => "vlt-user", listCredentials: async () => [],
    createEnvironmentVariableCredential: async () => "vcrd-user", updateEnvironmentCredential: async () => undefined
  }, { begin: async () => { throw new Error("should not begin"); } } as never,
  async () => undefined, () => undefined);

  await assert.rejects(auth.ensure(authMessage("om-doc", "direct"), {
    identity: "user", errorType: "authentication", subtype: "token_missing", domain: "docs"
  }), /尚未配置.*docs.*用户授权/);
  store.close();
});

test("concurrent authorization requests from one user all resume after one OAuth flow", async () => {
  const store = new GatewayStore(":memory:");
  let releasePoll: ((value: { accessToken: string; refreshToken: string; expiresAt: number }) => void) | undefined;
  const poll = new Promise<{ accessToken: string; refreshToken: string; expiresAt: number }>(resolve => { releasePoll = resolve; });
  const cards: string[] = [];
  const resumed: string[] = [];
  const createdSecrets: string[] = [];
  const auth = new EmployeeAuthorizationManager(store, {
    listVaults: async () => [],
    createVault: async () => "vlt-user",
    listCredentials: async () => [],
    createEnvironmentVariableCredential: async (_vaultId, _name, _secretName, secretValue) => {
      createdSecrets.push(secretValue);
      return "vcrd-user";
    },
    updateEnvironmentCredential: async () => undefined
  }, {
    begin: async () => ({ verificationUrl: "https://example.com/oauth", deviceCode: "device", expiresIn: 60, interval: 1 }),
    poll: async () => poll,
    getUserIdentity: async () => ({ openId: "ou-one", tenantKey: "tenant" })
  } as never, async message => { cards.push(message.messageId); },
  message => { resumed.push(message.messageId); });

  assert.deepEqual(await auth.vaultIds(authMessage("om-provision", "direct")), ["vlt-user"]);
  assert.equal(await auth.ensure(authMessage("om-one", "direct"), calendarRequest()), false);
  assert.equal(await auth.ensure(authMessage("om-two", "direct"), calendarRequest()), false);
  assert.deepEqual(cards, ["om-one"]);
  releasePoll?.({ accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 60_000 });
  await delay(20);

  assert.deepEqual(resumed, ["om-one", "om-two"]);
  assert.deepEqual(createdSecrets, ["ARKAGENT_USER_AUTH_PENDING"]);
  assert.equal(store.credentials.get(identity)?.vaultId, "vlt-user");
  store.close();
});

test("authorization resumes the original direct Session without handoff", async () => {
  const store = new GatewayStore(":memory:");
  let releasePoll: ((value: { accessToken: string; refreshToken: string; expiresAt: number }) => void) | undefined;
  const poll = new Promise<{ accessToken: string; refreshToken: string; expiresAt: number }>(resolve => { releasePoll = resolve; });
  const resumed: string[] = [];
  const auth = new EmployeeAuthorizationManager(store, {
    listVaults: async () => [], createVault: async () => "vlt-user", listCredentials: async () => [],
    createEnvironmentVariableCredential: async () => "vcrd-user", updateEnvironmentCredential: async () => undefined
  }, {
    begin: async () => ({ verificationUrl: "https://example.com/oauth", deviceCode: "device", expiresIn: 60, interval: 1 }),
    poll: async () => poll,
    getUserIdentity: async () => ({ openId: "ou-one", tenantKey: "tenant" })
  } as never, async () => undefined,
  message => { resumed.push(message.messageId); });

  assert.equal(await auth.ensure(authMessage("om-direct-one", "direct"), calendarRequest()), false);
  assert.equal(await auth.ensure(authMessage("om-direct-two", "direct"), calendarRequest()), false);
  releasePoll?.({ accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 60_000 });
  await delay(20);

  assert.deepEqual(resumed, ["om-direct-one", "om-direct-two"]);
  store.close();
});

test("an expired refresh token keeps the pre-mounted Vault and falls through to a new OAuth flow", async () => {
  const store = new GatewayStore(":memory:");
  store.credentials.save(identity, {
    status: "ready", vaultId: "vlt-user", credentialId: "vcrd-user",
    refreshToken: "expired", expiresAt: Date.now() - 1, scopes: EMPLOYEE_CALENDAR_USER_SCOPES
  }, 0);
  let began = 0;
  const auth = new EmployeeAuthorizationManager(store, {
    listVaults: async () => [], createVault: async () => "never", listCredentials: async () => [],
    createEnvironmentVariableCredential: async () => "never",
    updateEnvironmentCredential: async () => undefined
  }, {
    refresh: async () => { throw new OAuthError("reauth_required", { outcome: "rejected" }); },
    begin: async () => { began++; return { verificationUrl: "https://example.com/oauth", deviceCode: "device", expiresIn: 60, interval: 1 }; },
    poll: async () => new Promise(() => undefined)
  } as never, async () => undefined, () => undefined);

  assert.deepEqual(await auth.vaultIds(authMessage("om-expired", "direct")), ["vlt-user"]);
  await auth.ensureCredentialFresh(authMessage("om-expired", "direct"));
  assert.equal(await auth.ensure(authMessage("om-expired", "direct"), calendarRequest()), false);
  assert.equal(began, 1);
  store.close();
});

test("gateway mounts the placeholder Vault once and resumes the same Session after OAuth", async () => {
  const store = new GatewayStore(":memory:");
  let releasePoll: ((value: { accessToken: string; refreshToken: string; expiresAt: number }) => void) | undefined;
  const poll = new Promise<{ accessToken: string; refreshToken: string; expiresAt: number }>(resolve => { releasePoll = resolve; });
  const createdVaultLists: string[][] = [];
  const runSessions: string[] = [];
  const credentialWrites: string[] = [];
  let gateway: Gateway;
  const ark = {
    listVaults: async () => [], createVault: async () => "vlt-user", listCredentials: async () => [],
    createEnvironmentVariableCredential: async (_vault: string, _name: string, _secret: string, value: string) => {
      credentialWrites.push(value);
      return "vcrd-user";
    },
    updateEnvironmentCredential: async (_vault: string, _credential: string, value: string) => { credentialWrites.push(value); },
    createSession: async (request: { vault_ids?: string[] }) => {
      createdVaultLists.push(request.vault_ids || []);
      return "session-original";
    },
    run: async (sessionId: string) => {
      runSessions.push(sessionId);
      return runSessions.length === 1
        ? { terminal: "idle" as const, messages: [], authorizationRequired: calendarRequest() }
        : { terminal: "idle" as const, messages: ["已查询日程"] };
    }
  };
  const auth = new EmployeeAuthorizationManager(store, ark, {
    begin: async () => ({ verificationUrl: "https://example.com/oauth", deviceCode: "device", expiresIn: 60, interval: 1 }),
    poll: async () => poll,
    getUserIdentity: async () => ({ openId: "ou-one", tenantKey: "tenant" })
  } as never, async () => undefined, (message, userVaultId) => gateway.resumeAfterAuthorization(message, userVaultId));
  gateway = new Gateway(store, ark, async () => undefined, {
    agentId: "agent", environmentId: "env", vaultId: "vlt-bot", timeoutMs: 5_000, platformAccess: true,
    getUserVaultIds: message => auth.vaultIds(message), ensureAuthorization: (message, request) => auth.ensure(message, request),
    beforeDirectTurn: message => auth.ensureCredentialFresh(message)
  });

  gateway.accept(authMessage("om-hot-reload", "direct"));
  await delay(30);
  releasePoll?.({ accessToken: "valid-uat", refreshToken: "refresh", expiresAt: Date.now() + 60 * 60_000 });
  await delay(50);

  assert.deepEqual(createdVaultLists, [["vlt-bot", "vlt-user"]]);
  assert.deepEqual(runSessions, ["session-original", "session-original"]);
  assert.deepEqual(credentialWrites, ["ARKAGENT_USER_AUTH_PENDING", "valid-uat"]);
  assert.equal(store.credentials.get(identity)?.credentialId, "vcrd-user");
  store.close();
});

function authMessage(messageId: string, conversationType: "direct" | "group" = "group"): IncomingMessage {
  return {
    channelType: "lark", installationId: "cli", eventId: messageId, messageId,
    tenantId: "tenant", conversationId: "oc-one", conversationType,
    threadId: "", rootMessageId: "", parentMessageId: "", createTime: Date.now(),
    senderId: "ou-one", text: "帮我查看日程", resources: [], mentionedBot: conversationType === "group"
  };
}

function calendarRequest() {
  return { identity: "user" as const, errorType: "authentication" as const, subtype: "token_missing" as const, domain: "calendar" };
}
