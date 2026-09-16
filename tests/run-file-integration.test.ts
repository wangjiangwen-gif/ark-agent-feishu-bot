import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArkClient, resultFromEvents, type ArkEvent } from "../src/ark.ts";
import { Gateway, resultToReply, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import { RunFileObserver } from "../src/run-file-observation.ts";

const read: ArkEvent = { id: "read", type: "agent.tool_use", name: "read", input: '{"file_path":"/mnt/session/uploads/secret.pdf"}' };
const document: ArkEvent = { id: "document", type: "agent.tool_result", tool_use_id: "read", is_error: false,
  content: [{ type: "document", source: { type: "base64", data: "PRIVATE-PDF-BYTES" } }] };
const reply: ArkEvent = { id: "reply", type: "agent.message", content: [{ type: "text", text: "稍后分析" }] };
const idle: ArkEvent = { id: "idle", type: "session.status_idle" };
const message = (patch: Partial<IncomingMessage> = {}): IncomingMessage => ({ channelType: "lark", installationId: "app", tenantId: "tenant",
  conversationId: "chat", conversationType: "direct", senderId: "user", eventId: "event", messageId: "message", threadId: "",
  rootMessageId: "", parentMessageId: "", createTime: 100, text: "分析文件", resources: [], mentionedBot: false, ...patch });
const options = { agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 1000, platformAccess: true, sharedGroupSessions: true };
function observation() { const files = new RunFileObserver(); [read, document, reply].forEach(event => files.observe(event)); return files.snapshot()!; }
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), "异步流程应在测试时限内完成");
}

for (const mode of ["sse", "poll"] as const) {
  for (const [name, events, expected] of [
    ["promise after document", [read, document, reply, idle], "after_reads"],
    ["only an earlier reply", [reply, read, document, idle], "before_reads_finished"],
    ["no reply", [read, document, idle], "none"],
    ["missing result", [read, reply, idle], "unknown"]
  ] as const) test(`${mode}: ${name} preserves observations without approving business success or repeating input`, async () => {
    let posts = 0;
    const previous = [{ ...read, id: "old-read" }, { ...document, id: "old-document", tool_use_id: "old-read" }, { ...idle, id: "old-idle" }];
    const client = new ArkClient("test-key", "https://example.invalid", async (url, init) => {
      if (init?.method === "POST") { posts++; return Response.json({}); }
      if (String(url).includes("/events/stream")) {
        if (mode === "poll") return new Response("", { status: 503 });
        const bytes = new TextEncoder().encode([...previous, ...events].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
        return new Response(new ReadableStream({ start(controller) {
          for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
          controller.close();
        } }));
      }
      return Response.json({ data: mode === "poll" && posts ? [...previous, { id: "input", type: "user.message", content: [{ type: "text", text: "分析" }] }, ...events] : [] });
    }, { sseHeadStartMs: 0, eventPollIntervalMs: 10 });
    // 基线查询返回空；旧事件用时间戳隔离，避免依赖本机与平台时钟完全相等。
    previous.forEach(event => { event.processed_at = "2000-01-01T00:00:00Z"; });
    const output = await client.run("session", "分析", 1000);
    assert.equal(output.terminal, "idle"); assert.equal(posts, 1);
    assert.equal(output.fileObservation?.replyTiming, expected);
    assert.equal(output.fileObservation?.businessResult, "not_assessed");
    assert.equal(output.fileObservation?.reads.length, 1);
    assert.doesNotMatch(JSON.stringify(output.fileObservation), /PRIVATE|secret.pdf|old-read/);
  });
}

test("history collection resets file observations between runs and detects conflicting duplicates", () => {
  const stamp = (event: ArkEvent, n = 1000) => ({ ...event, processed_at: new Date(n).toISOString() });
  const events = [read, document, { ...document, is_error: true }, reply, idle].map(e => stamp(e));
  assert.equal(resultFromEvents(events, 0)?.fileObservation?.ambiguous, true);
  const next = resultFromEvents([...events, stamp({ ...reply, id: "next-reply" }, 2000), stamp({ ...idle, id: "next-idle" }, 2000)], 2000)!;
  assert.equal(next.fileObservation, undefined);
});

test("an introduction before document reads is not delivered as the final answer", () => {
  const files = new RunFileObserver();
  [reply, read, document].forEach(event => files.observe(event));
  assert.throws(() => resultToReply({ terminal: "idle", messages: ["我来读取文件"], fileObservation: files.snapshot() }), /未收到读取后的回复/);
  assert.equal(resultToReply({ terminal: "idle", messages: ["稍后分析"], fileObservation: observation() }), "稍后分析");
  // 有歧义时仅展示诊断，不凭不完整事件顺序覆盖已有结果。
  assert.equal(resultToReply({ terminal: "idle", messages: ["可用回复"], fileObservation: { ...observation(), ambiguous: true, replyTiming: "unknown" } }), "可用回复");
});

for (const streaming of [false, true]) test(`Gateway reports confirmed early end with streaming=${streaming} and never auto-reruns`, async () => {
  const store = new GatewayStore(":memory:");
  const files = new RunFileObserver(); [reply, read, document].forEach(event => files.observe(event));
  const replies: string[] = []; let runs = 0;
  const gateway = new Gateway(store, { createSession: async () => "session", run: async () => {
    runs++; return { terminal: "idle", messages: ["我来读取文件"], fileObservation: files.snapshot() };
  } }, async (_message, outbound) => { if (outbound.type === "text") replies.push(outbound.text); }, { ...options,
    ...(streaming ? { streamReply: async (_message: IncomingMessage, producer: (update: (snapshot: string) => Promise<void>) => Promise<void>) => {
      await producer(async text => { replies.push(text); });
    } } : {})
  });
  gateway.accept(message()); await until(() => replies.length > 0 && store.listAuditLogs().length === 1);
  assert.match(replies.join(""), /未收到读取后的回复/);
  assert.doesNotMatch(replies.join(""), /我来读取文件/);
  assert.equal(store.listAuditLogs()[0].status, "failed"); assert.equal(runs, 1);
  store.close();
});

for (const terminal of ["idle", "failed"] as const) test(`Gateway audit retains ${terminal} observations after reopen without triggering another run`, async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ark-run-audit-")), "gateway.db");
  let store = new GatewayStore(path);
  let runs = 0, creates = 0;
  const replies: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => { creates++; return "session"; },
    run: async () => { runs++; return { terminal, messages: ["稍后分析"], fileObservation: observation() }; }
  }, async (_message, outbound) => { if (outbound.type === "text") replies.push(outbound.text); }, options);
  gateway.accept(message());
  await until(() => replies.length === 1 && store.listAuditLogs().length === 1);
  const status = terminal === "idle" ? "succeeded" : "failed";
  assert.equal(store.listAuditLogs()[0].status, status);
  store.close(); store = new GatewayStore(path);
  const record = store.listAuditLogs()[0];
  assert.deepEqual(record.fileObservation, observation());
  assert.equal(record.fileObservation?.businessResult, "not_assessed");
  assert.equal(runs, 1); assert.equal(creates, 1);
  // 诊断只在管理员审计展示，不作为历史对话文本再次注入模型。
  assert.ok(store.listSessionAudit("session").every(row => row.fileObservation === undefined));
  store.close();
});

test("audit migration preserves legacy rows and strips non-diagnostic payload on both write and read", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ark-run-migration-")), "gateway.db");
  let store = new GatewayStore(path);
  const old = store.addAuditLog({ tenantKey: "tenant", openId: "user", chatId: "chat", messageId: "old", action: "message", status: "succeeded" });
  store.close();
  let db = new DatabaseSync(path); db.exec("ALTER TABLE audit_logs DROP COLUMN file_observation"); db.close();
  store = new GatewayStore(path);
  assert.equal(store.listAuditLogs()[0].id, old.id); assert.equal(store.listAuditLogs()[0].fileObservation, undefined);
  const log = store.addAuditLog({ tenantKey: "tenant", openId: "user", chatId: "chat", messageId: "new", action: "message", status: "succeeded",
    fileObservation: { ...observation(), source: "SECRET", businessResult: "succeeded" } as never });
  store.close(); db = new DatabaseSync(path);
  assert.doesNotMatch(String(db.prepare("SELECT file_observation FROM audit_logs WHERE id=?").get(log.id)!.file_observation), /SECRET|succeeded/);
  db.prepare("UPDATE audit_logs SET file_observation=? WHERE id=?").run(JSON.stringify({ ...observation(), source: "SECRET" }), log.id);
  db.close(); store = new GatewayStore(path);
  assert.doesNotMatch(JSON.stringify(store.listAuditLogs()[0].fileObservation), /SECRET/);
  store.close();
});

for (const source of ["direct", "history", "quote", "plain"] as const) test(`file guidance is scoped to ${source} inputs without changing Session system configuration`, async () => {
  const store = new GatewayStore(":memory:");
  const resources = [{ id: "file", type: "file" as const, name: "a.pdf" }];
  const historical = { messageId: "file-source", senderId: "user", senderType: "user" as const, source: "chat" as const, text: "附件", createTime: 50, resources };
  let input = "", request: Record<string, unknown> | undefined;
  const gateway = new Gateway(store, {
    createSession: async value => { request = value; return "session"; }, uploadFile: async name => ({ id: "file", name }),
    addSessionResource: async () => undefined, run: async (_id, value) => { input = value; return { terminal: "idle", messages: ["完成"] }; }
  }, async () => undefined, { ...options,
    loadRecentHistory: async () => source === "history" ? [historical] : [],
    readMessage: async () => ({ status: "available", message: historical }),
    downloadAttachment: async () => ({ bytes: new Uint8Array([1]), mimeType: "application/pdf" })
  });
  gateway.accept(message({ resources: source === "direct" ? resources : [], conversationType: source === "history" ? "group" : "direct",
    mentionedBot: source === "history", parentMessageId: source === "quote" ? "file-source" : "" }));
  await until(() => store.listAuditLogs().length > 0);
  assert.equal(store.listAuditLogs()[0].status, "succeeded");
  assert.equal(input.includes("<file_processing_guidance>"), source !== "plain");
  assert.equal(request?.system, undefined); assert.equal(request?.agent, "agent");
  store.close();
});

test("corrupt stored file diagnostics fail with a safe error instead of echoing JSON contents", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ark-run-corrupt-")), "gateway.db");
  let store = new GatewayStore(path);
  const log = store.addAuditLog({ tenantKey: "tenant", openId: "user", chatId: "chat", messageId: "new", action: "message", status: "succeeded" });
  store.close(); const db = new DatabaseSync(path);
  db.prepare("UPDATE audit_logs SET file_observation=? WHERE id=?").run("PRIVATE-CORRUPT-CONTENT", log.id);
  db.close(); store = new GatewayStore(path);
  assert.throws(() => store.listAuditLogs(), error => error instanceof Error && !error.message.includes("PRIVATE") && /文件读取观测/.test(error.message));
  store.close();
});

for (const failure of [false, true]) test(`streaming delivery failure=${failure} keeps observations without another MA run`, async () => {
  const store = new GatewayStore(":memory:");
  let runs = 0; const snapshots: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => "session",
    run: async (_id, _input, _timeout, _progress, update) => {
      runs++; await update?.("正在阅读");
      return { terminal: "idle", messages: ["稍后分析"], fileObservation: observation() };
    }
  }, async () => undefined, { ...options, streamReply: async (_message, producer) => {
    await producer(async value => { snapshots.push(value); });
    if (failure) throw new Error("交付失败");
  } });
  gateway.accept(message()); await until(() => store.listAuditLogs().length === 1);
  assert.deepEqual(snapshots, ["正在阅读", "稍后分析"]);
  assert.equal(runs, 1); assert.deepEqual(store.listAuditLogs()[0].fileObservation, observation());
  assert.equal(store.listAuditLogs()[0].status, failure ? "failed" : "succeeded");
  store.close();
});

test("Gateway awaits both downloads and Session mounts before starting PDF analysis", async () => {
  const store = new GatewayStore(":memory:");
  const release: Array<() => void> = []; let uploads = 0, runs = 0, created = false;
  let finishMount: (() => void) | undefined;
  const gateway = new Gateway(store, { createSession: async () => {
    created = true; await new Promise<void>(resolve => { finishMount = resolve; }); return "session";
  }, uploadFile: async name => ({ id: "file-" + (++uploads), name }),
  run: async () => { runs++; return { terminal: "idle", messages: ["完成"] }; }
  }, async () => undefined, { ...options, downloadAttachment: async () => {
    await new Promise<void>(resolve => release.push(resolve)); return { bytes: new Uint8Array([1]), mimeType: "application/pdf" };
  } });
  gateway.accept(message({ resources: ["a", "b"].map(id => ({ id, name: id + ".pdf", type: "file" as const })) }));
  await until(() => release.length === 1); assert.equal(runs, 0); assert.equal(created, false); release[0]();
  await until(() => release.length === 2); assert.equal(runs, 0); assert.equal(created, false); release[1]();
  await until(() => created); assert.equal(uploads, 2); assert.equal(runs, 0); finishMount!();
  await until(() => store.listAuditLogs().length === 1); assert.equal(runs, 1); store.close();
});
