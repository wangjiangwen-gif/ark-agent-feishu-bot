import test from "node:test";
import assert from "node:assert/strict";
import { GatewayStore } from "../src/store.ts";

const key = { tenantKey: "tenant", chatId: "chat", threadId: "", userOpenId: "user" };

test("store saves, reuses and resets a conversation session", () => {
  const store = new GatewayStore(":memory:");
  store.saveSession(key, "session-1", "agent-1", "3");
  assert.equal(store.getSession(key), "session-1");
  store.resetSession(key);
  assert.equal(store.getSession(key), undefined);
  store.close();
});

test("store claims the same Feishu event only once", () => {
  const store = new GatewayStore(":memory:");
  assert.equal(store.claimEvent("event-1"), true);
  assert.equal(store.claimEvent("event-1"), false);
  store.completeEvent("event-1", "completed");
  assert.equal(store.claimEvent("event-1"), false);
  store.close();
});

test("store resets every session without clearing event deduplication", () => {
  const store = new GatewayStore(":memory:");
  const anotherKey = { ...key, chatId: "chat-2" };
  store.saveSession(key, "session-1", "agent-1");
  store.saveSession(anotherKey, "session-2", "agent-1");
  assert.equal(store.claimEvent("event-1"), true);
  assert.equal(store.resetAllSessions(), 2);
  assert.equal(store.getSession(key), undefined);
  assert.equal(store.getSession(anotherKey), undefined);
  assert.equal(store.claimEvent("event-1"), false);
  store.close();
});

test("employee users are observed with first, latest and usage count", () => {
  const store = new GatewayStore(":memory:");
  const first = store.observeEmployeeUser("tenant", "user-1");
  const second = store.observeEmployeeUser("tenant", "user-1");
  assert.equal(first.usageCount, 1);
  assert.equal(second.usageCount, 2);
  assert.equal(second.firstUsedAt, first.firstUsedAt);
  assert.equal(store.listEmployeeUsers().length, 1);
  store.close();
});

test("audit logs are newest first", () => {
  const store = new GatewayStore(":memory:");
  store.addAuditLog({ tenantKey: "tenant", openId: "user-1", chatId: "chat", messageId: "message-1", action: "message", status: "failed" });
  store.addAuditLog({ tenantKey: "tenant", openId: "user-2", chatId: "chat", messageId: "message-2", action: "message", status: "succeeded", durationMs: 12 });
  const logs = store.listAuditLogs();
  assert.equal(logs.length, 2);
  assert.equal(logs[0].openId, "user-2");
  store.close();
});
