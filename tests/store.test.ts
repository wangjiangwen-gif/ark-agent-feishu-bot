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
