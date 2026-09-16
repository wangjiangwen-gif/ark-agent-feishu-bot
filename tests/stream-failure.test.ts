import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { LarkChannelAdapter, type LarkChannelPort } from "../src/lark-channel.ts";
import type { ChannelMessage, ReplyDeliveryEvent } from "../src/channel.ts";
import { Gateway, resultToReply, toConversationKey } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";

const message: ChannelMessage = { channelType: "lark", installationId: "app", tenantId: "tenant", conversationId: "chat",
  conversationType: "group", eventId: "e", messageId: "m", senderId: "u", text: "read", mentionedBot: true,
  resources: [], threadId: "", rootMessageId: "", parentMessageId: "", createTime: 1 };
const streaming = { intervalMs: 1, printFrequencyMs: 1, printStep: 1000, settlePaddingMs: 0 };

for (const value of [undefined, null]) for (const native of [true, false]) test(`non-Error producer rejection is not successful (native=${native}, value=${value})`, async () => {
  const receipts: ReplyDeliveryEvent[] = [], contents: string[] = [];
  const port = native ? { createCard: async () => ({ cardId: "card" }), send: async () => ({ messageId: "reply" }), rawClient: {
    im: {}, cardkit: { v1: { cardElement: { content: async p => { contents.push(p.data.content); return { code: 0 }; } }, card: { settings: async () => ({ code: 0 }) } } }
  } } : { stream: async (_to, input) => {
    try { await input.markdown({ setContent: async text => { contents.push(text); } }); } catch { /* 模拟SDK吞掉异常 */ }
    return { messageId: "reply" };
  } };
  const adapter = new LarkChannelAdapter({ appId: "app", appSecret: "secret", channel: port as unknown as LarkChannelPort, streaming });
  let rejected = false;
  try { await adapter.streamReply(message, async () => { throw value; }, async e => { receipts.push(e); }); }
  catch (error) { rejected = true; assert.equal(error, value); }
  assert.equal(rejected, true); assert.match(contents.at(-1)!, /执行失败/);
  assert.equal(receipts.some(e => e.type === "completed"), false);
});

for (const partial of [false, true]) for (const closeFails of [false, true]) test(`native failed stream closes card (partial=${partial}, closeFails=${closeFails})`, async () => {
  const contents: string[] = [], settings: any[] = [], receipts: ReplyDeliveryEvent[] = [];
  let runs = 0;
  const port = { createCard: async () => ({ cardId: "card" }), send: async () => ({ messageId: "reply" }), rawClient: {
    im: {}, cardkit: { v1: { cardElement: { content: async p => { contents.push(p.data.content); return { code: 0 }; } },
      card: { settings: async p => { settings.push(p); return { code: closeFails ? 230001 : 0 }; } } } }
  } } as unknown as LarkChannelPort;
  const adapter = new LarkChannelAdapter({ appId: "app", appSecret: "secret", channel: port, streaming });
  await assert.rejects(adapter.streamReply(message, async update => {
    runs++;
    if (partial) await update("正在读取文件");
    resultToReply({ terminal: "failed", messages: [], failure: { kind: "timeout", code: "model_file_processing_timeout", requestId: "req-123" } });
  }, async e => { receipts.push(e); }), /文件内容处理超时/);
  assert.match(contents.at(-1)!, /执行失败.*文件内容处理超时/);
  assert.match(contents.at(-1)!, /req-123/);
  assert.doesNotMatch(contents.at(-1)!, /Thinking/);
  assert.equal(JSON.parse(settings.at(-1).data.settings).config.streaming_mode, false);
  assert.equal(receipts.some(e => e.type === "completed"), false);
  assert.equal(runs, 1);
});

for (const swallow of [false, true]) test(`SDK fallback surfaces producer failure even if SDK swallows it (${swallow})`, async () => {
  const contents: string[] = [], receipts: ReplyDeliveryEvent[] = [];
  const port = { stream: async (_to, input) => {
    try { await input.markdown({ setContent: async text => { contents.push(text); } }); }
    catch (e) { if (!swallow) throw e; }
    return { messageId: "reply" };
  } } as unknown as LarkChannelPort;
  const adapter = new LarkChannelAdapter({ appId: "app", appSecret: "secret", channel: port, streaming });
  await assert.rejects(adapter.streamReply(message, async () => { throw new Error("private-token-secret"); }, async e => { receipts.push(e); }), /private-token-secret/);
  assert.match(contents.at(-1)!, /执行失败/);
  assert.doesNotMatch(contents.at(-1)!, /private-token-secret/);
  assert.equal(receipts.some(e => e.type === "completed"), false);
});

test("failed delivery preserves the original content for read-only recovery", async () => {
  let pushes = 0, closes = 0;
  const receipts: ReplyDeliveryEvent[] = [];
  const port = { createCard: async () => ({ cardId: "card" }), send: async () => ({ messageId: "reply" }), rawClient: {
    im: {}, cardkit: { v1: { cardElement: { content: async () => { pushes++; return { code: 230001 }; } },
      card: { settings: async () => { closes++; return { code: 0 }; } } } }
  } } as unknown as LarkChannelPort;
  const adapter = new LarkChannelAdapter({ appId: "app", appSecret: "secret", channel: port, streaming });
  await assert.rejects(adapter.streamReply(message, async update => update("reply"), async e => { receipts.push(e); }), /CardKit/);
  assert.equal(pushes, 1); assert.equal(closes, 1);
  assert.equal(receipts.some(e => e.type === "completed"), false);
});

for (const mode of ["direct", "group", "thread"] as const) for (const stream of [true, false]) {
  test(`Gateway ${mode} failure remains failed with Get cleanup (stream=${stream})`, async t => {
    const store = new GatewayStore(":memory:"); t.after(() => store.close());
    const input = { ...message, conversationType: mode === "direct" ? "direct" as const : "group" as const, threadId: mode === "thread" ? "thread" : "" };
    const key = toConversationKey(input, true);
    store.saveSession(key, "session", "agent");
    const contents: string[] = [], replies: string[] = [], reactions: string[] = [];
    let runs = 0;
    const port = { createCard: async () => ({ cardId: "card" }), send: async () => ({ messageId: "reply" }), rawClient: {
      im: {}, cardkit: { v1: { cardElement: { content: async p => { contents.push(p.data.content); return { code: 0 }; } },
        card: { settings: async () => ({ code: 0 }) } } }
    } } as unknown as LarkChannelPort;
    const adapter = new LarkChannelAdapter({ appId: "app", appSecret: "secret", channel: port, streaming });
    const gateway = new Gateway(store, {
      createSession: async () => { throw new Error("不应新建Session"); },
      run: async () => { runs++; return { terminal: "failed", messages: ["正在读取"],
        failure: { kind: "timeout", code: "model_file_processing_timeout", requestId: "req-test" } }; }
    }, async (_m, out) => { if (out.type === "text") replies.push(out.text); }, {
      agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 1000, platformAccess: true, sharedGroupSessions: true,
      addReaction: async (_m, emoji) => { reactions.push(emoji); return "reaction"; },
      removeReaction: async () => { reactions.push("removed"); },
      ...(stream ? { streamReply: adapter.streamReply.bind(adapter) } : {})
    });
    gateway.accept(input);
    const deadline = Date.now() + 2000;
    while (!replies.length) { assert.ok(Date.now() < deadline, "等待失败反馈超时"); await delay(5); }
    assert.equal(runs, 1); assert.equal(store.getSession(key), "session");
    assert.deepEqual(reactions, ["Get", "removed"]);
    assert.match(replies[0], /文件内容处理超时.*req-test/);
    const audit = store.listAuditLogs().find(row => row.action === "message");
    assert.equal(audit?.status, "failed"); assert.match(audit?.summary || "", /req-test/);
    assert.equal(audit?.requestId, "req-test");
    if (stream) assert.match(contents.at(-1)!, /文件内容处理超时/);
  });
}
