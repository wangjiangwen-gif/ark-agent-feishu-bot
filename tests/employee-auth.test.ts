import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { EmployeeAuthorizationManager, EMPLOYEE_CALENDAR_USER_SCOPES } from "../src/employee-auth.ts";
import type { IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";

test("employee authorization maps only explicit calendar tool failures to calendar scopes", () => {
  assert.ok(EMPLOYEE_CALENDAR_USER_SCOPES.includes("calendar:calendar.free_busy:read"));
});

test("unsupported lark-cli domains do not open an unrelated calendar OAuth flow", async () => {
  const store = new GatewayStore(":memory:");
  const auth = new EmployeeAuthorizationManager(store, {
    listVaults: async () => [], createVault: async () => "vlt-user", listCredentials: async () => [],
    createEnvironmentVariableCredential: async () => "vcrd-user", updateEnvironmentCredential: async () => undefined
  }, { begin: async () => { throw new Error("should not begin"); } } as never,
  async () => undefined, () => undefined, () => undefined);

  await assert.rejects(auth.ensure(authMessage("om-doc"), {
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
  const auth = new EmployeeAuthorizationManager(store, {
    listVaults: async () => [],
    createVault: async () => "vlt-user",
    listCredentials: async () => [],
    createEnvironmentVariableCredential: async () => "vcrd-user",
    updateEnvironmentCredential: async () => undefined
  }, {
    begin: async () => ({ verificationUrl: "https://example.com/oauth", deviceCode: "device", expiresIn: 60, interval: 1 }),
    poll: async () => poll,
    getUserOpenId: async () => "ou-one"
  } as never, async message => { cards.push(message.messageId); },
  message => { resumed.push(message.messageId); },
  () => undefined);

  assert.equal(await auth.ensure(authMessage("om-one"), calendarRequest()), false);
  assert.equal(await auth.ensure(authMessage("om-two"), calendarRequest()), false);
  assert.deepEqual(cards, ["om-one"]);
  releasePoll?.({ accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 60_000 });
  await delay(20);

  assert.deepEqual(resumed, ["om-one", "om-two"]);
  assert.equal(store.getEmployeeOAuth("tenant", "ou-one")?.vaultId, "vlt-user");
  store.close();
});

test("authorization handoff is used once per direct conversation while groups resume normally", async () => {
  const store = new GatewayStore(":memory:");
  let releasePoll: ((value: { accessToken: string; refreshToken: string; expiresAt: number }) => void) | undefined;
  const poll = new Promise<{ accessToken: string; refreshToken: string; expiresAt: number }>(resolve => { releasePoll = resolve; });
  const resumed: string[] = [];
  const handedOff: string[] = [];
  const auth = new EmployeeAuthorizationManager(store, {
    listVaults: async () => [], createVault: async () => "vlt-user", listCredentials: async () => [],
    createEnvironmentVariableCredential: async () => "vcrd-user", updateEnvironmentCredential: async () => undefined
  }, {
    begin: async () => ({ verificationUrl: "https://example.com/oauth", deviceCode: "device", expiresIn: 60, interval: 1 }),
    poll: async () => poll,
    getUserOpenId: async () => "ou-one"
  } as never, async () => undefined,
  message => { resumed.push(message.messageId); },
  message => { handedOff.push(message.messageId); });

  assert.equal(await auth.ensure(authMessage("om-group"), calendarRequest()), false);
  assert.equal(await auth.ensure(authMessage("om-direct-one", "direct"), calendarRequest()), false);
  assert.equal(await auth.ensure(authMessage("om-direct-two", "direct"), calendarRequest()), false);
  releasePoll?.({ accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 60_000 });
  await delay(20);

  assert.deepEqual(handedOff, ["om-direct-one"]);
  assert.deepEqual(resumed, ["om-group", "om-direct-two"]);
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
