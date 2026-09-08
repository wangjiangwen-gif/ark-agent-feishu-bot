import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway, toConversationKey, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import type { ChannelHistoryMessage } from "../src/channel.ts";

function message(id: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return { channelType: "lark", installationId: "cli", tenantId: "tenant", conversationId: "chat", conversationType: "group",
    eventId: id, messageId: id, threadId: "", rootMessageId: "", parentMessageId: "", createTime: 100,
    senderId: "user", text: "请处理", resources: [], mentionedBot: true, ...overrides };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("test did not complete"); await delay(5); }
}
function harness(overrides: Record<string, any> = {}, store = new GatewayStore(":memory:")) {
  const inputs: string[] = [];
  const replies: string[] = [];
  const resources: any[] = [];
  let uploads = 0;
  const gateway = new Gateway(store, {
    createSession: async request => { resources.push(...(request.resources || [])); return "session"; },
    uploadFile: async name => ({ id: `file-${++uploads}`, name }),
    addSessionResource: async (_id, resource) => { resources.push(resource); },
    run: async (_id, input) => { inputs.push(input); return { terminal: "idle", messages: ["完成"] }; },
    ...overrides.ark
  }, async (_message, reply) => { if (reply.type === "text") replies.push(reply.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "bot", timeoutMs: 5000,
    platformAccess: true, sharedGroupSessions: true, sessionCompaction: false,
    loadRecentHistory: async () => [],
    downloadAttachment: async () => ({ bytes: new Uint8Array([1]), mimeType: "application/pdf" }),
    ...overrides.options
  });
  return { gateway, store, inputs, replies, resources, uploads: () => uploads };
}

test("two same-name files are both mounted at different safe paths", async t => {
  const h = harness(); t.after(() => h.store.close());
  h.gateway.accept(message("files", { resources: [{ id: "a", name: "报告.pdf", type: "file" }, { id: "b", name: "报告.pdf", type: "file" }] }));
  await until(() => h.replies.length === 1);
  assert.equal(h.resources.length, 2);
  assert.notEqual(h.resources[0].mount_path, h.resources[1].mount_path);
  for (const resource of h.resources) assert.ok(h.inputs[0].includes(`/mnt/session/uploads${resource.mount_path}`));
});

test("edited and recalled history messages replace facts without replaying unchanged history", async t => {
  let history: ChannelHistoryMessage[] = [{ messageId: "fact", senderId: "user", senderType: "user", source: "chat", text: "时间是三点", createTime: 10 }];
  const h = harness({ options: { loadRecentHistory: async () => history } }); t.after(() => h.store.close());
  h.gateway.accept(message("one")); await until(() => h.replies.length === 1);
  history = [{ ...history[0], text: "时间改成四点", updateTime: 150 }];
  h.gateway.accept(message("two", { createTime: 200 })); await until(() => h.replies.length === 2);
  assert.match(h.inputs[1], /时间改成四点/);
  h.gateway.accept(message("three", { createTime: 300 })); await until(() => h.replies.length === 3);
  assert.doesNotMatch(h.inputs[2], /时间改成四点/);
  history = [{ ...history[0], text: "[已撤回]", deleted: true, updateTime: 350 }];
  h.gateway.accept(message("four", { createTime: 400 })); await until(() => h.replies.length === 4);
  assert.match(h.inputs[3], /已撤回/);
});

test("own replies are excluded only from their existing Session", async t => {
  const trigger = message("one");
  let history: ChannelHistoryMessage[] = [];
  const h = harness({ options: { loadRecentHistory: async () => history } }); t.after(() => h.store.close());
  h.gateway.accept(trigger); await until(() => h.replies.length === 1);
  h.store.recordOutgoing(trigger, "reply-one");
  history = [{ messageId: "reply-one", senderId: "bot-open-id", senderType: "app", source: "chat", text: "自己的回复", createTime: 150 },
    { messageId: "other-bot", senderId: "another-bot", senderType: "app", source: "chat", text: "其他机器人回复", createTime: 160 }];
  h.gateway.accept(message("two", { createTime: 200 })); await until(() => h.replies.length === 2);
  assert.doesNotMatch(h.inputs[1], /自己的回复/);
  assert.match(h.inputs[1], /其他机器人回复/);
});

test("unmentioned file is cached without execution and survives Gateway reconstruction", async t => {
  const h = harness(); t.after(() => h.store.close());
  assert.equal(h.gateway.accept(message("attachment", { mentionedBot: false, text: "", resources: [{ id: "a", name: "资料.pdf", type: "file" }] })), false);
  assert.equal(h.inputs.length, 0);
  const restarted = harness({ options: { loadRecentHistory: async () => { throw new Error("offline"); } } }, h.store);
  restarted.gateway.accept(message("mention", { createTime: 200 })); await until(() => restarted.replies.length === 1);
  assert.equal(restarted.resources.length, 1);
  assert.match(restarted.inputs[0], /资料.pdf/);
  assert.match(restarted.inputs[0], /可能缺少离线期间/);
});

test("failed historical mount reuses uploaded File ID on next mention", async t => {
  let attempts = 0;
  const history = [{ messageId: "file-message", senderId: "user", senderType: "user", source: "chat", text: "附件", createTime: 10, resources: [{ id: "a", name: "资料.pdf", type: "file" }] }];
  const h = harness({ ark: { addSessionResource: async () => { if (++attempts === 1) throw new Error("temporary mount error"); } }, options: { loadRecentHistory: async () => history } });
  t.after(() => h.store.close());
  h.gateway.accept(message("one")); await until(() => h.replies.length === 1);
  assert.match(h.replies[0], /附件提示/);
  h.gateway.accept(message("two", { createTime: 200 })); await until(() => h.replies.length === 2);
  assert.equal(attempts, 2);
  assert.equal(h.uploads(), 1);
  assert.match(h.inputs[1], /已挂载到/);
});

test("one unsupported file never swallows a valid sibling or the user's text", async t => {
  const h = harness({ options: { downloadAttachment: async resource => {
    if (resource.id === "bad") throw new Error("file type not supported");
    return { bytes: new Uint8Array([1]), mimeType: "application/pdf" };
  } } }); t.after(() => h.store.close());
  h.gateway.accept(message("files", { text: "先分析能读取的文件", resources: [{ id: "bad", name: "资料.bin", type: "file" }, { id: "good", name: "资料.pdf", type: "file" }] }));
  await until(() => h.replies.length === 1);
  assert.equal(h.resources.length, 1);
  assert.match(h.inputs[0], /先分析能读取的文件/);
  assert.match(h.replies[0], /MA 暂不支持此文件类型/);
});

test("inline text source is restored after compact within the same Session", async t => {
  const source = "原文标记 EXACT_123456789";
  const h = harness({ options: { downloadAttachment: async () => ({ bytes: new TextEncoder().encode(source), mimeType: "text/plain" }) } }); t.after(() => h.store.close());
  h.gateway.accept(message("text", { conversationType: "direct", resources: [{ id: "text", name: "原文.txt", type: "file" }] }));
  await until(() => h.replies.length === 1);
  h.gateway.accept(message("compact", { conversationType: "direct", text: "/compact" })); await until(() => h.replies.length === 2);
  h.gateway.accept(message("read", { conversationType: "direct", text: "返回原文" })); await until(() => h.replies.length === 3);
  assert.match(h.inputs.at(-1)!, /EXACT_123456789/);
  assert.equal(h.uploads(), 0);
});

test("oversized text is reported without failing a valid message", async t => {
  const h = harness({ options: { downloadAttachment: async () => ({ bytes: new Uint8Array(256 * 1024 + 1), mimeType: "text/plain" }) } }); t.after(() => h.store.close());
  h.gateway.accept(message("big", { resources: [{ id: "big", name: "大文件.txt", type: "file" }] })); await until(() => h.replies.length === 1);
  assert.match(h.replies[0], /256 KB/);
  assert.equal(h.inputs.length, 1);
});

test("Agent config mismatch preserves the old Session and refuses to run it", async t => {
  const h = harness(); t.after(() => h.store.close());
  h.store.saveSession(toConversationKey(message("one"), true), "old", "other-agent");
  h.gateway.accept(message("one")); await until(() => h.replies.length === 1);
  assert.equal(h.inputs.length, 0);
  assert.match(h.replies[0], /Agent.*不一致/);
  assert.equal(h.store.getSession(toConversationKey(message("one"), true)), "old");
});

test("local history does not leak another thread or another installation", async t => {
  const h = harness(); t.after(() => h.store.close());
  h.gateway.accept(message("foreign", { installationId: "another", text: "其他安装私密内容", mentionedBot: false }));
  h.gateway.accept(message("thread", { threadId: "other-thread", text: "其他话题内容", mentionedBot: false }));
  h.gateway.accept(message("public", { text: "公共背景", mentionedBot: false }));
  h.gateway.accept(message("request", { threadId: "this-thread", createTime: 200 })); await until(() => h.replies.length === 1);
  assert.match(h.inputs[0], /公共背景/);
  assert.doesNotMatch(h.inputs[0], /其他安装私密内容|其他话题内容/);
});

test("a failed current mount leaves its valid sibling and never advertises a missing path", async t => {
  const h = harness({ ark: { addSessionResource: async (_id, resource) => {
    if (resource.file_id === "file-1") throw new Error("mount failed");
  } } }); t.after(() => h.store.close());
  h.store.saveSession(toConversationKey(message("files"), true), "session", "agent");
  h.gateway.accept(message("files", { resources: [{ id: "a", name: "bad.pdf", type: "file" }, { id: "b", name: "good.pdf", type: "file" }] }));
  await until(() => h.replies.length === 1);
  assert.doesNotMatch(h.inputs[0], /\/mnt\/session\/uploads[^\n]*bad\.pdf/);
  assert.match(h.inputs[0], /\/mnt\/session\/uploads[^\n]*good\.pdf/);
  assert.match(h.replies[0], /bad\.pdf.*未能挂载/);
});

test("a trigger returned by history with different mention rendering is not injected again", async t => {
  const h = harness({ options: { loadRecentHistory: async () => [{ messageId: "first", senderId: "user", senderType: "user", source: "chat", text: "@数字员工 请处理", createTime: 100 }] } });
  t.after(() => h.store.close());
  h.gateway.accept(message("first")); await until(() => h.replies.length === 1);
  h.gateway.accept(message("second", { createTime: 200 })); await until(() => h.replies.length === 2);
  assert.doesNotMatch(h.inputs[1], /@数字员工/);
});

test("attachment download receives the remaining aggregate budget", async t => {
  const limits: number[] = [];
  const h = harness({ options: { downloadAttachment: async (_resource, _message, limit) => {
    limits.push(limit);
    return { bytes: new Uint8Array(15 * 1024 * 1024), mimeType: "application/pdf" };
  } } }); t.after(() => h.store.close());
  h.gateway.accept(message("files", { resources: ["a", "b", "c"].map(id => ({ id, name: `${id}.pdf`, type: "file" })) }));
  await until(() => h.replies.length === 1);
  assert.deepEqual(limits, [20, 20, 10].map(mb => mb * 1024 * 1024));
  assert.equal(h.uploads(), 2);
  assert.match(h.replies[0], /40 MB/);
});

test("history, upload receipts and inline originals survive a real SQLite close and reopen", async t => {
  const directory = mkdtempSync(join(tmpdir(), "arkagent-resilience-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "gateway.db");
  const first = harness({ options: { downloadAttachment: async () => ({ bytes: new TextEncoder().encode("DURABLE_SOURCE"), mimeType: "text/plain" }) } }, new GatewayStore(path));
  first.gateway.accept(message("source", { resources: [{ id: "txt", name: "source.txt", type: "file" }] }));
  await until(() => first.replies.length === 1);
  first.gateway.accept(message("cached", { text: "未艾特的新事实", createTime: 110, mentionedBot: false }));
  first.store.requestInlineRestore("session");
  first.store.close();
  const second = harness({ options: { loadRecentHistory: async () => { throw new Error("offline"); } } }, new GatewayStore(path));
  t.after(() => second.store.close());
  second.gateway.accept(message("next", { createTime: 200 }));
  await until(() => second.replies.length === 1);
  assert.match(second.inputs[0], /DURABLE_SOURCE/);
  assert.match(second.inputs[0], /未艾特的新事实/);
  assert.equal(second.uploads(), 0);
  assert.equal(second.store.getSession(toConversationKey(message("next"), true)), "session");
});

test("older remote snapshots never overwrite a cached edit", async t => {
  const h = harness({ options: { loadRecentHistory: async () => [{ messageId: "fact", senderId: "user", senderType: "user", source: "chat", text: "旧信息", createTime: 10 }] } });
  t.after(() => h.store.close());
  h.store.cacheHistory(message("next"), [{ messageId: "fact", senderId: "user", senderType: "user", source: "chat", text: "已更正的信息", createTime: 10, updateTime: 20 }]);
  h.gateway.accept(message("next")); await until(() => h.replies.length === 1);
  assert.match(h.inputs[0], /已更正的信息/);
  assert.doesNotMatch(h.inputs[0], /旧信息/);
  assert.equal(h.store.cachedHistory(message("later", { createTime: 200 }))[0].text, "已更正的信息");
});

test("overflow historical attachments get their turn without reuploading the first batch", async t => {
  const history = [{ messageId: "batch", senderId: "user", senderType: "user", source: "chat", text: "九个附件", createTime: 10,
    resources: Array.from({ length: 9 }, (_, index) => ({ id: String(index), name: `${index}.pdf`, type: "file" })) }];
  const h = harness({ options: { loadRecentHistory: async () => history } }); t.after(() => h.store.close());
  h.gateway.accept(message("first")); await until(() => h.replies.length === 1);
  assert.equal(h.uploads(), 8);
  assert.match(h.replies[0], /最多处理 8 个/);
  h.gateway.accept(message("second", { createTime: 200 })); await until(() => h.replies.length === 2);
  assert.equal(h.uploads(), 9);
  assert.equal(h.resources.length, 9);
  assert.doesNotMatch(h.replies[1], /附件提示/);
});
