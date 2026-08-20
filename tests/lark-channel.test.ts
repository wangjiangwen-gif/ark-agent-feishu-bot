import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { NormalizedMessage } from "@larksuite/channel";
import { Gateway } from "../src/gateway.ts";
import { LarkChannelAdapter, normalizeLarkChannelMessage, toLarkSendInput, type LarkChannelPort } from "../src/lark-channel.ts";
import { GatewayStore } from "../src/store.ts";

function normalized(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: "om-1", chatId: "oc-1", chatType: "p2p", senderId: "ou-1",
    content: "请总结", rawContentType: "post", resources: [], mentions: [],
    mentionAll: false, mentionedBot: false, createTime: Date.now(),
    raw: { event_id: "evt-1", sender: { tenant_key: "tenant-1" } },
    ...overrides
  };
}

test("Channel SDK message maps to the channel-neutral contract", () => {
  const result = normalizeLarkChannelMessage(normalized({
    chatType: "group", threadId: "omt-1", mentionedBot: true,
    resources: [
      { type: "image", fileKey: "img-1" },
      { type: "file", fileKey: "file-1", fileName: "计划.md" },
      { type: "audio", fileKey: "audio-1" }
    ]
  }), "cli-one");
  assert.deepEqual(result, {
    channelType: "lark", installationId: "cli-one", eventId: "evt-1", messageId: "om-1",
    tenantId: "tenant-1", conversationId: "oc-1", conversationType: "group", threadId: "omt-1",
    senderId: "ou-1", text: "请总结", mentionedBot: true,
    resources: [
      { id: "img-1", name: "img-1.jpg", type: "image" },
      { id: "file-1", name: "计划.md", type: "file" }
    ]
  });
});

test("Channel adapter replies in the original thread and sends cards", async () => {
  const calls: Array<{ to: string; input: unknown; options?: unknown }> = [];
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const port = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    on: (name: string, handler: (...args: never[]) => unknown) => { handlers.set(name, handler); return () => undefined; },
    send: async (to: string, input: unknown, options?: unknown) => { calls.push({ to, input, options }); return { messageId: "reply-1" }; },
    downloadResource: async () => Buffer.from([1, 2, 3])
  } as unknown as LarkChannelPort;
  const adapter = new LarkChannelAdapter({ appId: "cli-one", appSecret: "secret", channel: port });
  const inbound = normalizeLarkChannelMessage(normalized({ threadId: "omt-1" }), "cli-one");
  let received = "";
  await adapter.start(message => { received = message.text; });
  await handlers.get("message")?.(normalized() as never);
  await adapter.reply(inbound, { type: "text", text: "完成" });
  await adapter.send("oc-2", { type: "card", card: { schema: "2.0" } });
  assert.equal(received, "请总结");
  assert.deepEqual(calls, [
    { to: "oc-1", input: { text: "完成" }, options: { replyTo: "om-1", replyInThread: true } },
    { to: "oc-2", input: { card: { schema: "2.0" } }, options: undefined }
  ]);
});

test("Channel adapter enforces the attachment limit", async () => {
  const port = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    on: () => () => undefined,
    send: async () => ({ messageId: "reply-1" }),
    downloadResource: async () => Buffer.from([1, 2, 3, 4])
  } as unknown as LarkChannelPort;
  const adapter = new LarkChannelAdapter({ appId: "cli-one", appSecret: "secret", channel: port, maxFileBytes: 3 });
  const inbound = normalizeLarkChannelMessage(normalized(), "cli-one");
  await assert.rejects(() => adapter.download({ id: "file-1", name: "report.pdf", type: "file" }, inbound), /超过/);
});

test("Channel adapter drives the complete receive, Agent and reply path", async () => {
  let messageHandler: ((message: NormalizedMessage) => void) | undefined;
  const sends: Array<{ to: string; input: unknown }> = [];
  const port = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    on: (name: string, handler: (message: NormalizedMessage) => void) => { if (name === "message") messageHandler = handler; return () => undefined; },
    send: async (to: string, input: unknown) => { sends.push({ to, input }); return { messageId: `reply-${sends.length}` }; },
    downloadResource: async () => Buffer.alloc(0)
  } as unknown as LarkChannelPort;
  const adapter = new LarkChannelAdapter({ appId: "cli-one", appSecret: "secret", channel: port });
  const store = new GatewayStore(":memory:");
  const gateway = new Gateway(store, {
    createSession: async () => "session-1",
    run: async () => ({ terminal: "idle" as const, messages: ["最终答复"] })
  }, (message, outbound) => adapter.reply(message, outbound), {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "ou-1", timeoutMs: 5_000
  });
  await adapter.start(message => gateway.accept(message));
  messageHandler?.(normalized());
  await delay(30);
  assert.deepEqual(sends.map(item => item.input), [{ text: "已收到，正在处理。首次启动可能需要几分钟。" }, { text: "最终答复" }]);
  assert.equal(store.listAuditLogs()[0].installationId, "cli-one");
  await adapter.stop();
  store.close();
});

test("outbound conversion remains explicit for future channel capabilities", () => {
  assert.deepEqual(toLarkSendInput({ type: "text", text: "hello" }), { text: "hello" });
  assert.deepEqual(toLarkSendInput({ type: "markdown", markdown: "**hello**" }), { markdown: "**hello**" });
  assert.deepEqual(toLarkSendInput({ type: "card", card: { schema: "2.0" } }), { card: { schema: "2.0" } });
});
