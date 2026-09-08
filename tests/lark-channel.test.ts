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
    rootMessageId: "", parentMessageId: "", createTime: result.createTime,
    senderId: "ou-1", text: "请总结", mentionedBot: true,
    resources: [
      { id: "img-1", name: "img-1.jpg", type: "image" },
      { id: "file-1", name: "计划.md", type: "file" }
    ]
  });
});

test("Channel normalization keeps ordinary reply roots separate from real threads", () => {
  const result = normalizeLarkChannelMessage(normalized({
    chatType: "group", rootId: "om-root", replyToMessageId: "om-parent", threadId: undefined
  }), "cli-one");
  assert.equal(result.threadId, "");
  assert.equal(result.rootMessageId, "om-root");
  assert.equal(result.parentMessageId, "om-parent");
});

test("Channel adapter loads chat history before the trigger and excludes the trigger message", async () => {
  const calls: unknown[] = [];
  const port = historyPort(async payload => {
    calls.push(payload);
    return { code: 0, data: { items: [
      historyItem("om-future", "ou-3", "未来消息", 1_700_000_001_000),
      historyItem("om-trigger", "ou-2", "当前消息", 1_700_000_000_000),
      historyItem("om-before", "ou-1", "之前消息", 1_699_999_999_000, "张三")
    ] } };
  });
  const adapter = new LarkChannelAdapter({ appId: "cli-one", appSecret: "secret", channel: port });
  const inbound = normalizeLarkChannelMessage(normalized({
    messageId: "om-trigger", chatType: "group", createTime: 1_700_000_000_000, mentionedBot: true
  }), "cli-one");

  const history = await adapter.loadRecentHistory(inbound);

  assert.deepEqual(history.map(item => item.messageId), ["om-before"]);
  assert.equal(history[0].senderName, "张三");
  assert.equal(history[0].source, "chat");
  assert.deepEqual(calls, [{ params: {
    container_id_type: "chat", container_id: "oc-1", end_time: "1700000000",
    sort_type: "ByCreateTimeDesc", page_size: 50, with_sender_name: true
  } }]);
});

test("Channel adapter preserves downloadable resources from historical file messages", async () => {
  const port = historyPort(async () => ({ code: 0, data: { items: [{
    message_id: "om-file", msg_type: "file", create_time: "1699999999000",
    sender: { id: "ou-1", sender_type: "user", sender_name: "张三" },
    body: { content: JSON.stringify({ file_key: "file-v3-old", file_name: "会议材料.pdf" }) }
  }, {
    message_id: "om-image", msg_type: "image", create_time: "1699999998000",
    sender: { id: "ou-2", sender_type: "user", sender_name: "李四" },
    body: { content: JSON.stringify({ image_key: "img-v3-old" }) }
  }] } }));
  const adapter = new LarkChannelAdapter({ appId: "cli-one", appSecret: "secret", channel: port });
  const inbound = normalizeLarkChannelMessage(normalized({
    messageId: "om-trigger", chatType: "group", createTime: 1_700_000_000_000, mentionedBot: true
  }), "cli-one");

  const history = await adapter.loadRecentHistory(inbound);

  assert.deepEqual(history.map(item => ({ messageId: item.messageId, text: item.text, resources: item.resources })), [{
    messageId: "om-image", text: "[图片]",
    resources: [{ id: "img-v3-old", name: "img-v3-old.jpg", type: "image" }]
  }, {
    messageId: "om-file", text: "[文件：会议材料.pdf]",
    resources: [{ id: "file-v3-old", name: "会议材料.pdf", type: "file" }]
  }]);
});

test("rich post history preserves image-only content, nested files and message revisions", async () => {
  const port = historyPort(async () => ({ data: { items: [{
    message_id: "post", msg_type: "post", create_time: "100", update_time: "150",
    sender: { id: "user", sender_type: "user" },
    body: { content: JSON.stringify({ zh_cn: { content: [[{ tag: "img", image_key: "img" }, { tag: "file", file_key: "file", file_name: "附件.pdf" }]] } }) }
  }] } }));
  const adapter = new LarkChannelAdapter({ appId: "cli", appSecret: "secret", channel: port });
  const history = await adapter.loadRecentHistory(normalizeLarkChannelMessage(normalized({ messageId: "trigger", chatType: "group", createTime: 200 }), "cli"));
  assert.equal(history.length, 1);
  assert.equal(history[0].updateTime, 150);
  assert.deepEqual(history[0].resources?.map(item => item.id), ["img", "file"]);
  assert.ok(history[0].text);
});

test("bounded history reports truncation and retains recalled-message tombstones", async () => {
  const port = historyPort(async () => ({ data: { items: Array.from({ length: 25 }, (_, i) => ({
    ...historyItem(`om-${i}`, "user", "原消息", 100 + i), deleted: i === 24, update_time: "199"
  })) } }));
  const adapter = new LarkChannelAdapter({ appId: "cli", appSecret: "secret", channel: port });
  const history = await adapter.loadRecentHistory(normalizeLarkChannelMessage(normalized({ messageId: "trigger", chatType: "group", createTime: 200 }), "cli"));
  assert.equal(history.length, 20);
  assert.match((history as typeof history & { notices?: string[] }).notices?.join("") || "", /仅加载近期/);
  assert.equal(history.at(-1)?.deleted, true);
  assert.match(history.at(-1)?.text || "", /撤回/);
});

test("outgoing message ids are recorded for context de-duplication", async () => {
  const sent: string[] = [];
  const port = historyPort(async () => ({ data: { items: [] } }));
  port.send = async () => ({ messageId: "sent-1", chunkIds: ["sent-2"] });
  const adapter = new LarkChannelAdapter({ appId: "cli", appSecret: "secret", channel: port, onSent: (_message, id) => sent.push(id) });
  await adapter.reply(normalizeLarkChannelMessage(normalized(), "cli"), { type: "text", text: "hello" });
  assert.deepEqual(sent, ["sent-1", "sent-2"]);
});

test("Channel adapter merges chat and thread history before the trigger", async () => {
  const calls: unknown[] = [];
  const port = historyPort(async payload => {
    calls.push(payload);
    const containerType = (payload as { params: { container_id_type: string } }).params.container_id_type;
    return containerType === "chat"
      ? { code: 0, data: { items: [
        historyItem("om-chat", "ou-3", "群聊背景", 1_699_999_997_000),
        historyItem("om-shared", "ou-1", "重复的根消息", 1_699_999_998_000)
      ] } }
      : { code: 0, data: { items: [
        historyItem("om-trigger", "ou-2", "当前话题消息", 1_700_000_000_000),
        historyItem("om-shared", "ou-1", "重复的根消息", 1_699_999_998_000),
        historyItem("om-thread", "ou-1", "话题前文", 1_699_999_999_000)
      ] } };
  });
  const adapter = new LarkChannelAdapter({ appId: "cli-one", appSecret: "secret", channel: port });
  const inbound = normalizeLarkChannelMessage(normalized({
    messageId: "om-trigger", chatType: "group", threadId: "omt-one", createTime: 1_700_000_000_000,
    mentionedBot: true
  }), "cli-one");

  const history = await adapter.loadRecentHistory(inbound);

  assert.deepEqual(history.map(item => [item.text, item.source]), [
    ["群聊背景", "chat"],
    ["重复的根消息", "thread"],
    ["话题前文", "thread"]
  ]);
  assert.deepEqual(calls, [
    { params: {
      container_id_type: "chat", container_id: "oc-1", end_time: "1700000000",
      sort_type: "ByCreateTimeDesc", page_size: 50, with_sender_name: true
    } },
    { params: {
      container_id_type: "thread", container_id: "omt-one",
      sort_type: "ByCreateTimeDesc", page_size: 50, with_sender_name: true
    } }
  ]);
});

test("Thread history remains available when the surrounding chat lookup fails", async () => {
  const port = historyPort(async payload => {
    const containerType = (payload as { params: { container_id_type: string } }).params.container_id_type;
    if (containerType === "chat") throw new Error("chat history unavailable");
    return { code: 0, data: { items: [
      historyItem("om-thread", "ou-1", "话题仍然可用", 1_699_999_999_000)
    ] } };
  });
  const adapter = new LarkChannelAdapter({ appId: "cli-one", appSecret: "secret", channel: port });
  const inbound = normalizeLarkChannelMessage(normalized({
    messageId: "om-trigger", chatType: "group", threadId: "omt-one", createTime: 1_700_000_000_000,
    mentionedBot: true
  }), "cli-one");

  const history = await adapter.loadRecentHistory(inbound);

  assert.deepEqual(history.map(item => [item.text, item.source]), [["话题仍然可用", "thread"]]);
});

test("Channel adapter sends normal chats directly and preserves existing topics", async () => {
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
  const direct = normalizeLarkChannelMessage(normalized(), "cli-one");
  const group = normalizeLarkChannelMessage(normalized({ messageId: "om-2", chatType: "group" }), "cli-one");
  const topic = normalizeLarkChannelMessage(normalized({ messageId: "om-3", chatType: "group", threadId: "omt-1" }), "cli-one");
  let received = "";
  await adapter.start(message => { received = message.text; });
  await handlers.get("message")?.(normalized() as never);
  await adapter.reply(direct, { type: "text", text: "单聊答复" });
  await adapter.reply(group, { type: "text", text: "群聊答复" });
  await adapter.reply(topic, { type: "text", text: "话题答复" });
  await adapter.send("oc-2", { type: "card", card: { schema: "2.0" } });
  assert.equal(received, "请总结");
  assert.deepEqual(calls, [
    { to: "oc-1", input: { text: "单聊答复" }, options: undefined },
    { to: "oc-1", input: { text: "群聊答复" }, options: undefined },
    { to: "oc-1", input: { text: "话题答复" }, options: { replyTo: "om-3", replyInThread: true } },
    { to: "oc-2", input: { card: { schema: "2.0" } }, options: undefined }
  ]);
});

test("Channel adapter streams snapshots and manages the Get reaction", async () => {
  const streamCalls: Array<{ to: string; options?: unknown; snapshots: string[] }> = [];
  const reactions: string[] = [];
  const port = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    on: () => () => undefined,
    send: async () => ({ messageId: "reply-1" }),
    stream: async (to: string, input: { markdown: (controller: { setContent(value: string): Promise<void> }) => Promise<void> }, options?: unknown) => {
      const snapshots: string[] = [];
      await input.markdown({ setContent: async value => { snapshots.push(value); } });
      streamCalls.push({ to, options, snapshots });
      return { messageId: "stream-1" };
    },
    addReaction: async (messageId: string, emojiType: string) => {
      reactions.push(`add:${messageId}:${emojiType}`);
      return "reaction-1";
    },
    removeReaction: async (messageId: string, reactionId: string) => { reactions.push(`remove:${messageId}:${reactionId}`); },
    downloadResource: async () => Buffer.alloc(0)
  } as unknown as LarkChannelPort;
  const adapter = new LarkChannelAdapter({ appId: "cli-one", appSecret: "secret", channel: port });
  const inbound = normalizeLarkChannelMessage(normalized({ chatType: "group", threadId: "omt-1" }), "cli-one");

  const reactionId = await adapter.addReaction(inbound, "Get");
  await adapter.streamReply(inbound, async update => {
    await update("你");
    await update("你好");
  });
  await adapter.removeReaction(inbound, reactionId);

  assert.deepEqual(streamCalls, [{
    to: "oc-1", options: { replyTo: "om-1", replyInThread: true }, snapshots: ["你好"]
  }]);
  assert.deepEqual(reactions, ["add:om-1:Get", "remove:om-1:reaction-1"]);
});

test("Channel adapter preserves producer failures after flushing the latest snapshot", async () => {
  const snapshots: string[] = [];
  const port = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    on: () => () => undefined,
    send: async () => ({ messageId: "reply-1" }),
    stream: async (_to: string, input: { markdown: (controller: { setContent(value: string): Promise<void> }) => Promise<void> }) => {
      await input.markdown({ setContent: async value => { snapshots.push(value); } });
      return { messageId: "stream-1" };
    },
    downloadResource: async () => Buffer.alloc(0)
  } as unknown as LarkChannelPort;
  const adapter = new LarkChannelAdapter({
    appId: "cli-one", appSecret: "secret", channel: port,
    streaming: { intervalMs: 1, minChunkChars: 4, maxSteps: 4 }
  });
  const inbound = normalizeLarkChannelMessage(normalized(), "cli-one");

  await assert.rejects(adapter.streamReply(inbound, async update => {
    await update("已生成部分内容");
    throw new Error("upstream failed");
  }), /upstream failed/);
  assert.equal(snapshots.at(-1), "已生成部分内容");
});

test("Channel adapter progressively reveals a complete upstream snapshot", async () => {
  const snapshots: string[] = [];
  const operations: string[] = [];
  let content = "";
  const port = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    on: () => () => undefined,
    send: async () => ({ messageId: "reply-1" }),
    stream: async (_to: string, input: { markdown: (controller: { append(value: string): Promise<void>; setContent(value: string): Promise<void> }) => Promise<void> }) => {
      await input.markdown({
        append: async value => { operations.push(`append:${value}`); content += value; snapshots.push(content); },
        setContent: async value => { operations.push(`set:${value}`); content = value; snapshots.push(content); }
      });
      return { messageId: "stream-1" };
    },
    downloadResource: async () => Buffer.alloc(0)
  } as unknown as LarkChannelPort;
  const adapter = new LarkChannelAdapter({
    appId: "cli-one", appSecret: "secret", channel: port,
    streaming: { intervalMs: 1, minChunkChars: 4, maxSteps: 4 }
  });
  const inbound = normalizeLarkChannelMessage(normalized(), "cli-one");

  await adapter.streamReply(inbound, async update => {
    await update("一二三四五六七八九十甲乙丙丁戊己");
  });

  assert.ok(snapshots.length >= 3, `expected progressive updates, got ${snapshots.length}`);
  assert.equal(snapshots.at(-1), "一二三四五六七八九十甲乙丙丁戊己");
  assert.ok(operations.every(operation => operation.startsWith("append:")), `expected append-only growth, got ${operations.join(",")}`);
  for (let index = 1; index < snapshots.length; index++) {
    assert.ok(snapshots[index].startsWith(snapshots[index - 1]));
    assert.ok(snapshots[index].length > snapshots[index - 1].length);
  }
});

test("Channel adapter progressively replaces a previous non-prefix Agent message", async () => {
  const snapshots: string[] = [];
  const port = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    on: () => () => undefined,
    send: async () => ({ messageId: "reply-1" }),
    stream: async (_to: string, input: { markdown: (controller: { setContent(value: string): Promise<void> }) => Promise<void> }) => {
      await input.markdown({ setContent: async value => { snapshots.push(value); } });
      return { messageId: "stream-1" };
    },
    downloadResource: async () => Buffer.alloc(0)
  } as unknown as LarkChannelPort;
  const adapter = new LarkChannelAdapter({
    appId: "cli-one", appSecret: "secret", channel: port,
    streaming: { intervalMs: 1, minChunkChars: 4, maxSteps: 4 }
  });
  const inbound = normalizeLarkChannelMessage(normalized(), "cli-one");
  const final = "最终回答甲乙丙丁戊己庚辛壬癸";

  await adapter.streamReply(inbound, async update => {
    await update("正在检查一二三四五六七八九十");
    await delay(10);
    await update(final);
  });

  const replacement = snapshots.find(value => final.startsWith(value));
  assert.ok(replacement, "expected a snapshot from the replacement message");
  assert.ok(replacement.length < final.length, "replacement must not jump directly to the complete final message");
  assert.equal(snapshots.at(-1), final);
});

test("Channel adapter waits for native CardKit typing before closing the stream", async () => {
  const operations: Array<{ type: string; value?: unknown }> = [];
  const port = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    on: () => () => undefined,
    createCard: async (card: object) => { operations.push({ type: "create", value: card }); return { cardId: "card-1" }; },
    send: async (_to: string, input: unknown) => { operations.push({ type: "send", value: input }); return { messageId: "reply-1" }; },
    stream: async () => { throw new Error("legacy stream path used"); },
    downloadResource: async () => Buffer.alloc(0),
    rawClient: {
      im: { messageResource: { get: async () => { throw new Error("unused"); } } },
      cardkit: { v1: {
        cardElement: { content: async (payload: unknown) => { operations.push({ type: "content", value: payload }); } },
        card: { settings: async (payload: unknown) => { operations.push({ type: "settings", value: payload }); } }
      } }
    }
  } as unknown as LarkChannelPort;
  const adapter = new LarkChannelAdapter({
    appId: "cli-one", appSecret: "secret", channel: port,
    streaming: {
      intervalMs: 1, minChunkChars: 4, maxSteps: 4,
      printFrequencyMs: 1, printStep: 10, settlePaddingMs: 0
    }
  });
  const inbound = normalizeLarkChannelMessage(normalized(), "cli-one");
  const final = "原生打字机需要在关闭流之前消费完最终内容";

  await adapter.streamReply(inbound, async update => update(final));

  assert.equal(operations[0].type, "create");
  assert.deepEqual(operations[1], { type: "send", value: { cardId: "card-1" } });
  const updates = operations.filter(operation => operation.type === "content");
  assert.ok(updates.length >= 3, `expected incremental CardKit updates, got ${updates.length}`);
  assert.equal(operations.at(-1)?.type, "settings");
  const card = operations[0].value as {
    config: { streaming_config: { print_frequency_ms: { default: number }; print_step: { default: number } } };
    body: { elements: Array<{ content: string }> };
  };
  assert.equal(card.config.streaming_config.print_frequency_ms.default, 1);
  assert.equal(card.config.streaming_config.print_step.default, 10);
  assert.equal(card.body.elements[0].content, "Thinking...");
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
  assert.deepEqual(sends.map(item => item.input), [{ text: "最终答复" }]);
  assert.equal(store.listAuditLogs()[0].installationId, "cli-one");
  await adapter.stop();
  store.close();
});

test("outbound conversion remains explicit for future channel capabilities", () => {
  assert.deepEqual(toLarkSendInput({ type: "text", text: "hello" }), { text: "hello" });
  assert.deepEqual(toLarkSendInput({ type: "markdown", markdown: "**hello**" }), { markdown: "**hello**" });
  assert.deepEqual(toLarkSendInput({ type: "card", card: { schema: "2.0" } }), { card: { schema: "2.0" } });
});

function historyItem(messageId: string, senderId: string, text: string, createTime: number, senderName?: string) {
  return {
    message_id: messageId, msg_type: "text", create_time: String(createTime),
    sender: { id: senderId, id_type: "open_id", sender_type: "user", sender_name: senderName },
    body: { content: JSON.stringify({ text }) }
  };
}

function historyPort(list: (payload: unknown) => Promise<unknown>): LarkChannelPort {
  return {
    connect: async () => undefined,
    disconnect: async () => undefined,
    on: () => () => undefined,
    send: async () => ({ messageId: "reply-1" }),
    stream: async () => ({ messageId: "stream-1" }),
    addReaction: async () => "reaction-1",
    removeReaction: async () => undefined,
    createCard: async () => ({ cardId: "card-1" }),
    downloadResource: async () => Buffer.alloc(0),
    rawClient: {
      im: {
        message: { list },
        messageResource: { get: async () => { throw new Error("unused"); } }
      }
    }
  } as unknown as LarkChannelPort;
}
