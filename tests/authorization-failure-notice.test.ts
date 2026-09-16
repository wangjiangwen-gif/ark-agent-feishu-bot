import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Gateway, toConversationKey, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import { LarkChannelAdapter, type LarkChannelPort } from "../src/lark-channel.ts";
import { readOnlyEvidence } from "./helpers/run-evidence.ts";

const message: IncomingMessage = { channelType: "lark", installationId: "cli", tenantId: "tenant", senderId: "user",
  conversationId: "chat", conversationType: "direct", threadId: "", parentMessageId: "", rootMessageId: "",
  messageId: "message", eventId: "event", text: "查看日程", resources: [], mentionedBot: false, createTime: 1 };
const streaming = { intervalMs: 1, printFrequencyMs: 1, printStep: 1000, settlePaddingMs: 0 };

for (const delivery of ["confirmed", "content_failed", "close_failed"] as const) {
  test(`OAuth continuation retains recovery state without repeating a confirmed failed card (${delivery})`, async t => {
    const store = new GatewayStore(":memory:"); t.after(() => store.close());
    const key = toConversationKey(message);
    store.saveSession(key, "original", "agent", undefined, ["bot", "user-vault"]);
    store.startAuthorizationRecovery(message, "original", readOnlyEvidence());
    const contents: string[] = [], replies: string[] = [], reactions: string[] = [];
    let runs = 0;
    const channel = { createCard: async () => ({ cardId: "card" }), send: async () => ({ messageId: "reply" }), rawClient: {
      im: {}, cardkit: { v1: { cardElement: { content: async input => {
        contents.push(input.data.content); return { code: delivery === "content_failed" ? 230001 : 0 };
      } }, card: { settings: async () => ({ code: delivery === "close_failed" ? 230001 : 0 }) } } }
    } } as unknown as LarkChannelPort;
    const adapter = new LarkChannelAdapter({ appId: "cli", appSecret: "secret", channel, streaming });
    const gateway = new Gateway(store, {
      createSession: async () => { assert.fail("授权续跑不能重建Session"); },
      getSessionStats: async () => ({ eventCount: 10, status: "idle" }),
      run: async sessionId => {
        assert.equal(sessionId, "original"); runs++;
        return { terminal: "failed", messages: [], failure: { kind: "timeout", code: "model_file_processing_timeout", requestId: "req-oauth-failure" } };
      }
    }, async (_message, output) => { if (output.type === "text") replies.push(output.text); }, {
      agentId: "agent", environmentId: "env", vaultId: "bot", timeoutMs: 1000, platformAccess: true,
      streamReply: adapter.streamReply.bind(adapter),
      addReaction: async (_message, emoji) => { reactions.push(emoji); return "reaction"; },
      removeReaction: async () => { reactions.push("removed"); }
    });
    gateway.resumeAfterAuthorization(message, "user-vault");
    const deadline = Date.now() + 2000;
    while (!replies.length) { assert.ok(Date.now() < deadline, "等待授权续跑失败反馈超时"); await delay(5); }
    assert.equal(runs, 1); assert.equal(store.getSession(key), "original");
    assert.equal(store.getAuthorizationRecovery(message)?.state, "failed");
    assert.deepEqual(reactions, ["Get", "removed"]); assert.equal(replies.length, 1);
    assert.match(contents.at(-1)!, /文件内容处理超时.*req-oauth-failure/);
    if (delivery === "confirmed") {
      assert.match(replies[0], /授权已更新.*续跑未完成/);
      assert.match(replies[0], /上方卡片.*原 Session.*未自动重试.*核对/);
      assert.doesNotMatch(replies[0], /文件内容处理超时|file_url|req-oauth-failure/);
    } else assert.match(replies[0], /授权恢复未完成.*文件内容处理超时.*req-oauth-failure/);
    assert.equal(store.listAuditLogs().find(row => row.action === "message")?.status, "failed");
    // 重复OAuth回调不能因为失败通知去重而重新执行已失败的续跑。
    gateway.resumeAfterAuthorization(message, "user-vault"); await delay(5);
    assert.equal(runs, 1); assert.equal(replies.length, 1);
  });
}
