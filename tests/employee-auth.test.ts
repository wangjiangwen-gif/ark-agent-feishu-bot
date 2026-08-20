import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { EmployeeAuthorizationManager, EMPLOYEE_CALENDAR_USER_SCOPES, needsCalendarAuthorization } from "../src/employee-auth.ts";
import type { IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";

test("calendar scheduling requests require user authorization", () => {
  assert.equal(needsCalendarAuthorization("帮我安排明天下午的日程"), true);
  assert.equal(needsCalendarAuthorization("帮我创建一份飞书文档"), false);
  assert.ok(EMPLOYEE_CALENDAR_USER_SCOPES.includes("calendar:calendar.free_busy:read"));
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
  } as never, async message => { cards.push(message.messageId); }, message => { resumed.push(message.messageId); });

  assert.equal(await auth.ensure(authMessage("om-one")), false);
  assert.equal(await auth.ensure(authMessage("om-two")), false);
  assert.deepEqual(cards, ["om-one"]);
  releasePoll?.({ accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 60_000 });
  await delay(20);

  assert.deepEqual(resumed, ["om-one", "om-two"]);
  assert.equal(store.getEmployeeOAuth("tenant", "ou-one")?.vaultId, "vlt-user");
  store.close();
});

function authMessage(messageId: string): IncomingMessage {
  return {
    channelType: "lark", installationId: "cli", eventId: messageId, messageId,
    tenantId: "tenant", conversationId: "oc-one", conversationType: "group",
    threadId: "", rootMessageId: "", parentMessageId: "", createTime: Date.now(),
    senderId: "ou-one", text: "帮我查看日程", resources: [], mentionedBot: true
  };
}
