import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Gateway, resultToReply, shouldHandleMessage, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return { eventId: "event-1", messageId: "message-1", chatId: "chat-1", chatType: "p2p", threadId: "", userOpenId: "user-1", tenantKey: "tenant-1", text: "你好", mentionedBot: false, ...overrides };
}

test("group messages require an explicit bot mention", () => {
  assert.equal(shouldHandleMessage(message({ chatType: "group", mentionedBot: false })), false);
  assert.equal(shouldHandleMessage(message({ chatType: "group", mentionedBot: true })), true);
});

test("result requires both a successful terminal and a business message", () => {
  assert.throws(() => resultToReply({ terminal: "idle", messages: [] }), /没有产生回复/);
  assert.throws(() => resultToReply({ terminal: "failed", messages: ["partial"] }), /执行失败/);
  assert.equal(resultToReply({ terminal: "idle", messages: ["完成"] }), "完成");
});

test("gateway acknowledges quickly, deduplicates, and reuses a session", async () => {
  const store = new GatewayStore(":memory:");
  let creates = 0;
  let runs = 0;
  const replies: string[] = [];
  const ark = {
    createSession: async () => `session-${++creates}`,
    run: async () => { runs++; return { terminal: "idle" as const, messages: ["回复"] }; }
  };
  const gateway = new Gateway(store, ark, async (_chatId, text) => { replies.push(text); }, { agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserOpenId: "user-1", timeoutMs: 5_000 });
  assert.equal(gateway.accept(message()), true);
  assert.equal(gateway.accept(message()), false);
  gateway.accept(message({ eventId: "event-2", messageId: "message-2", text: "再问" }));
  await delay(30);
  assert.equal(creates, 1);
  assert.equal(runs, 2);
  assert.deepEqual(replies, ["已收到，正在处理。首次启动可能需要几分钟。", "回复", "回复"]);
  store.close();
});

test("reused slow sessions receive one delayed processing reply", async () => {
  const store = new GatewayStore(":memory:");
  const replies: string[] = [];
  let runs = 0;
  const gateway = new Gateway(store, {
    createSession: async () => "session-1",
    run: async () => {
      runs++;
      if (runs === 2) await delay(20);
      return { terminal: "idle" as const, messages: ["回复"] };
    }
  }, async (_chatId, text) => { replies.push(text); }, { agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserOpenId: "user-1", timeoutMs: 5_000, progressDelayMs: 5 });
  gateway.accept(message());
  await delay(20);
  gateway.accept(message({ eventId: "event-2", messageId: "message-2" }));
  await delay(40);
  assert.deepEqual(replies, [
    "已收到，正在处理。首次启动可能需要几分钟。", "回复",
    "已收到，正在处理，请稍候。", "回复"
  ]);
  store.close();
});

test("gateway filters Agent tool progress and sends only the final reply", async () => {
  const store = new GatewayStore(":memory:");
  store.saveSession({ tenantKey: "tenant-1", chatId: "chat-1", threadId: "", userOpenId: "user-1" }, "session-1", "agent-1");
  const replies: string[] = [];
  let receivedProgressCallback = false;
  const gateway = new Gateway(store, {
    createSession: async () => "session-1",
    run: async (_sessionId, _text, _timeout, onProgress) => {
      receivedProgressCallback = Boolean(onProgress);
      await onProgress?.("正在执行：检查 lark-cli");
      return { terminal: "idle" as const, messages: ["可用"] };
    }
  }, async (_chatId, text) => { replies.push(text); }, { agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserOpenId: "user-1", timeoutMs: 5_000, progressDelayMs: 50 });
  gateway.accept(message());
  await delay(20);
  assert.equal(receivedProgressCallback, false);
  assert.deepEqual(replies, ["可用"]);
  store.close();
});

test("gateway rejects users other than the authorized user", async () => {
  const store = new GatewayStore(":memory:");
  const replies: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => "never", run: async () => ({ terminal: "idle", messages: [] }) }, async (_chatId, text) => { replies.push(text); }, { agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserOpenId: "user-1", timeoutMs: 5_000 });
  gateway.accept(message({ userOpenId: "user-2" }));
  await delay(20);
  assert.match(replies[0], /未授权/);
  store.close();
});
