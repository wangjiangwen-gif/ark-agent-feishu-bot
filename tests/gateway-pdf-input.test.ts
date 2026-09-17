import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Gateway, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import { runInputFingerprint, pdfInputMode } from "../src/pdf-input.ts";

const message = (id: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  channelType: "lark", installationId: "cli-test", eventId: id, messageId: id, tenantId: "tenant", senderId: "user",
  conversationId: "chat", conversationType: "direct", threadId: "", rootMessageId: "", parentMessageId: "",
  createTime: Date.now(), text: "分析附件", resources: [], mentionedBot: false, ...overrides
});
const pdf = { type: "file" as const, id: "feishu-file", name: "report.pdf" };
async function settle(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await delay(10);
  assert.ok(check(), "网关任务应完成");
}
function fixture(extra: Record<string, unknown> = {}, failReady = false) {
  const store = new GatewayStore(":memory:");
  const runs: any[][] = [], ready: string[] = [], uploads: string[] = [], mounts: any[] = [], replies: any[] = [];
  let creates = 0;
  const gateway = new Gateway(store, {
    createSession: async request => { mounts.push(...request.resources || []); return `session-${++creates}`; },
    uploadFile: async name => { uploads.push(name); return { id: `file-${uploads.length}`, name }; },
    addSessionResource: async (_session, resource) => { mounts.push(resource); },
    waitForFileActive: async id => { ready.push(id); if (failReady) throw new Error("PDF 尚未就绪"); },
    run: async (...args) => { runs.push(args); return { terminal: "idle", messages: ["完成"] }; }
  }, async (_message, output) => { replies.push(output); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", authorizedUserId: "user", timeoutMs: 1000, pdfInputMode: "file",
    downloadAttachment: async () => ({ bytes: new Uint8Array([37, 80, 68, 70]), mimeType: "application/pdf" }),
    addReaction: async () => "reaction", removeReaction: async () => {}, ...extra
  });
  return { store, gateway, runs, ready, uploads, mounts, replies, creates: () => creates };
}
test("current PDF is a model file reference and retains its sandbox mount and session on follow-up", async () => {
  const f = fixture();
  try {
    f.gateway.accept(message("first", { resources: [pdf] }));
    await settle(() => f.replies.length === 1);
    assert.deepEqual(f.runs[0][6], [{ fileId: "file-1", title: "report.pdf" }]);
    assert.deepEqual(f.ready, ["file-1"]);
    assert.equal(f.mounts[0].file_id, "file-1");
    assert.match(f.runs[0][1], /pdf_input_guidance/);
    f.gateway.accept(message("next")); await settle(() => f.replies.length === 2);
    assert.equal(f.runs[1][6], undefined);
    assert.equal(f.creates(), 1); assert.equal(f.uploads.length, 1);
  } finally { f.store.close(); }
});
test("unmentioned group PDF is supplied on next mention, with cache reuse and chat isolation", async () => {
  const f = fixture({ platformAccess: true, sharedGroupSessions: true, loadRecentHistory: async () => [] });
  try {
    assert.equal(f.gateway.accept(message("file-message", { conversationType: "group", resources: [pdf] })), false);
    f.gateway.accept(message("mention", { conversationType: "group", mentionedBot: true }));
    await settle(() => f.replies.length === 1);
    assert.equal(f.runs[0][6][0].fileId, "file-1");
    f.gateway.accept(message("other-chat", { conversationType: "group", conversationId: "other", mentionedBot: true }));
    await settle(() => f.replies.length === 2);
    assert.equal(f.runs[1][6], undefined);
    assert.equal(f.uploads.length, 1);
  } finally { f.store.close(); }
});
test("quoted PDF is attached by source message and reused on repeat quote", async () => {
  const f = fixture({ readMessage: async () => ({ status: "available", message: {
    messageId: "quoted", conversationId: "chat", senderId: "user", text: "文件", createTime: 1,
    resources: [pdf], senderType: "user", source: "chat"
  } }) });
  try {
    f.gateway.accept(message("quote-1", { parentMessageId: "quoted" })); await settle(() => f.replies.length === 1);
    assert.equal(f.runs[0][6][0].fileId, "file-1");
    f.gateway.accept(message("quote-2", { parentMessageId: "quoted" })); await settle(() => f.replies.length === 2);
    assert.equal(f.runs[1][6][0].fileId, "file-1");
    assert.equal(f.uploads.length, 1);
  } finally { f.store.close(); }
});
test("unready PDF blocks model dispatch instead of sending an incomplete document", async () => {
  const f = fixture({}, true);
  try {
    f.gateway.accept(message("first", { resources: [pdf] })); await settle(() => f.replies.length === 1);
    assert.equal(f.runs.length, 0); assert.equal(f.uploads.length, 1);
    assert.match(f.replies[0].text, /尚未就绪/);
  } finally { f.store.close(); }
});
for (const name of ["file.txt", "file.md", "file.png"]) test(`non-PDF ${name} keeps existing route`, async () => {
  const f = fixture();
  try {
    f.gateway.accept(message("first", { resources: [{ ...pdf, name }] })); await settle(() => f.replies.length === 1);
    assert.equal(f.runs[0][6], undefined); assert.deepEqual(f.ready, []);
  } finally { f.store.close(); }
});
test("sandbox rollback mode preserves old PDF route", async () => {
  const f = fixture({ pdfInputMode: "sandbox" });
  try {
    f.gateway.accept(message("first", { resources: [pdf] })); await settle(() => f.replies.length === 1);
    assert.equal(f.runs[0][6], undefined); assert.equal(f.mounts.length, 1); assert.deepEqual(f.ready, []);
  } finally { f.store.close(); }
});
test("PDF references survive encrypted preparation and bind the dispatch fingerprint", () => {
  const store = new GatewayStore(":memory:");
  try {
    store.acquireRuntimeLock();
    const binding = { scope: "test", agentId: "agent", configFingerprint: "test" };
    const task = store.inbox.enqueue(message("prepared"), binding)!;
    store.inbox.claim(task.id, binding);
    const pdfFiles = [{ fileId: "file-1", title: "report.pdf" }];
    store.inbox.prepare(task.id, { sessionId: "session", input: "分析", notices: [], contextReceipts: [], pdfFiles });
    const saved = store.inbox.findTask(task.id)!;
    assert.deepEqual(saved.preparation?.pdfFiles, pdfFiles);
    assert.equal(saved.preparation?.fingerprint, runInputFingerprint("分析", pdfFiles));
    assert.throws(() => store.inbox.prepare(task.id, { sessionId: "session", input: "分析", notices: [], contextReceipts: [], pdfFiles: [{ fileId: "file-2", title: "report.pdf" }] }));
  } finally { store.close(); }
});
test("official CLI PDF mode defaults on and validates rollback", () => {
  assert.equal(pdfInputMode(undefined), "file"); assert.equal(pdfInputMode("sandbox"), "sandbox");
  assert.throws(() => pdfInputMode("unknown"));
});

test("thread PDF input includes chat background and thread quote, without duplicate uploads", async () => {
  const f = fixture({ platformAccess: true, sharedGroupSessions: true, loadRecentHistory: async () => [
    { messageId: "chat-file", senderId: "user-a", senderType: "user", source: "chat", text: "群背景", createTime: 1, resources: [pdf] },
    { messageId: "thread-file", senderId: "user-b", senderType: "user", source: "thread", text: "话题文件", createTime: 2, resources: [{ ...pdf, id: "second", name: "second.pdf" }] }
  ] });
  try {
    f.gateway.accept(message("thread-mention", { conversationType: "group", mentionedBot: true, threadId: "thread", parentMessageId: "thread-file" }));
    await settle(() => f.replies.length === 1);
    assert.deepEqual(f.runs[0][6].map((item: any) => item.title), ["second.pdf", "report.pdf"]);
    assert.equal(f.uploads.length, 2);
  } finally { f.store.close(); }
});
test("PDF document count is bounded while all sandbox copies remain mounted", async () => {
  const f = fixture();
  try {
    f.gateway.accept(message("many", { resources: Array.from({ length: 9 }, (_, i) => ({ ...pdf, id: `source-${i}`, name: `report-${i}.pdf` })) }));
    await settle(() => f.replies.length === 1);
    assert.equal(f.runs[0][6].length, 8); assert.equal(f.mounts.length, 9);
    assert.match(f.replies[0].text, /最多 8 份 PDF/);
  } finally { f.store.close(); }
});
test("streaming path sends the same PDF references", async () => {
  const updates: string[] = [];
  const f = fixture({ streamReply: async (_message: any, generate: any) => { await generate(async (text: string) => { updates.push(text); }); } });
  try {
    f.gateway.accept(message("stream", { resources: [pdf] })); await settle(() => updates.length > 0);
    assert.deepEqual(f.runs[0][6], [{ fileId: "file-1", title: "report.pdf" }]);
    assert.equal(typeof f.runs[0][4], "function");
  } finally { f.store.close(); }
});
