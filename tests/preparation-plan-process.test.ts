import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import test from "node:test";
import { ArkClient } from "../src/ark.ts";
import { Gateway, toConversationKey, type GatewayOptions, type IncomingMessage } from "../src/gateway.ts";
import type { ChannelHistoryMessage } from "../src/channel.ts";
import { GatewayStore } from "../src/store.ts";

const sessionId = "sesn-preparation-process-original";
const options: GatewayOptions = { agentId: "agent", environmentId: "env", vaultId: "bot-vault", appId: "cli",
  platformAccess: true, sharedGroupSessions: true, durableQueue: true, timeoutMs: 1000, progressDelayMs: 60_000 };
const message = (extra: Partial<IncomingMessage> = {}): IncomingMessage => ({ channelType: "lark", installationId: "cli",
  tenantId: "tenant", senderId: "user", conversationId: "chat", conversationType: "group", threadId: "", rootMessageId: "",
  parentMessageId: "", messageId: "original-trigger", eventId: "original-event", text: "请分析这些文件", createTime: 100,
  resources: [], mentionedBot: true, ...extra });
const done = () => ({ terminal: "idle" as const, messages: ["完成"] });
const ready = async (id: string) => ({ sessionId: id, status: "idle" as const, agentId: "agent" });
async function until(check: () => boolean, description: string) {
  for (let i = 0; i < 2000 && !check(); i++) await flush();
  assert.ok(check(), description);
}
type Event = { kind: string; [key: string]: unknown };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ark-preparation-process-"));
  return { path: join(dir, "gateway.db"), ledger: join(dir, "effects.ndjson"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function events(path: string): Event[] {
  try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

// 子进程确实退出并释放运行锁；父进程只恢复原Inbox，不通过发送新消息掩盖恢复缺口。
function exitPreparing(files: ReturnType<typeof fixture>, incoming: IncomingMessage, setup: string) {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { appendFileSync } from 'node:fs';
    import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    import { Gateway, toConversationKey } from ${JSON.stringify(new URL("../src/gateway.ts", import.meta.url).href)};
    const incoming=${JSON.stringify(incoming)}, store=new GatewayStore(${JSON.stringify(files.path)});
    store.acquireRuntimeLock(); store.saveSession(toConversationKey(incoming,true),${JSON.stringify(sessionId)},'agent');
    const record=event=>appendFileSync(${JSON.stringify(files.ledger)},JSON.stringify(event)+'\\n');
    const ark={createSession:async()=>{throw Error('不应重建Session');},
      uploadFile:async(name,mime,bytes,operation)=>{record({kind:'upload',name,bytes:bytes.byteLength,uploadName:operation?.uploadName});return{id:'file-'+name,name};},
      addSessionResource:async(session,resource)=>{record({kind:'mount',session,resource});},
      run:async()=>{record({kind:'run'});throw Error('不应提前派发模型');}};
    const extra={downloadAttachment:async resource=>{record({kind:'download',name:resource.name});return{bytes:new Uint8Array([1,2,3]),mimeType:'application/pdf'};}};
    ${setup}
    new Gateway(store,ark,async()=>{}, {...${JSON.stringify(options)},...extra}).accept(incoming);
    setTimeout(()=>process.exit(99),3000);
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 77, child.stderr || child.stdout);
  assert.equal(events(files.ledger).filter(event => event.kind === "run").length, 0);
}

test("original inbox resumes the completed history and reply observation checkpoint without reading later edits", async () => {
  const files = fixture(), incoming = message({ parentMessageId: "quoted-source" });
  const history: ChannelHistoryMessage = { messageId: "history-source", senderId: "alice", senderType: "user", source: "chat",
    createTime: 70, text: "ORIGINAL_HISTORY_SENTINEL" };
  const quoted: ChannelHistoryMessage = { messageId: "quoted-source", senderId: "bob", senderType: "user", source: "chat",
    createTime: 80, text: "ORIGINAL_QUOTE_SENTINEL" };
  exitPreparing(files, incoming, `extra.loadRecentHistory=async()=>{record({kind:'history'});return[${JSON.stringify(history)}];};
    extra.readMessage=async()=>{record({kind:'quote'});return{status:'available',message:${JSON.stringify(quoted)}};};
    const complete=store.inbox.completePreparationStep.bind(store.inbox);
    store.inbox.completePreparationStep=(expected,planId,id,output)=>{
      const task=complete(expected,planId,id,output);
      if(id==='context'){record({kind:'checkpoint',id});process.exit(77);}
      return task;
    };`);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock();
  try {
    const original = store.inbox.findMessage(incoming)!;
    const context = original.preparationPlan?.steps.find(step => step.id === "context");
    assert.equal(context?.kind, "observation"); assert.equal(context?.state, "completed");
    assert.match(JSON.stringify(context?.output), /ORIGINAL_HISTORY_SENTINEL/);
    assert.match(JSON.stringify(context?.output), /ORIGINAL_QUOTE_SENTINEL/);
    assert.equal(original.preparation, undefined);
    let reads = 0, quotes = 0, creates = 0; const inputs: string[] = [];
    const gateway = new Gateway(store, { createSession: async () => { creates++; return "unexpected"; }, inspectSessionReadiness: ready,
      run: async (id, input) => { assert.equal(id, sessionId); inputs.push(input); return done(); }
    }, async () => {}, { ...options,
      loadRecentHistory: async () => { reads++; return [{ ...history, text: "EDITED_HISTORY_SENTINEL", updateTime: 200 }]; },
      readMessage: async () => { quotes++; return { status: "available", message: { ...quoted, text: "EDITED_QUOTE_SENTINEL", updateTime: 200 } }; }
    });
    gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(incoming);
    await until(() => store.inbox.findMessage(incoming)?.state === "completed", "原上下文准备任务应恢复，不需要新消息");
    assert.equal(store.inbox.findMessage(incoming)!.id, original.id);
    assert.deepEqual({ reads, quotes, creates, runs: inputs.length }, { reads: 0, quotes: 0, creates: 0, runs: 1 });
    assert.match(inputs[0], /ORIGINAL_HISTORY_SENTINEL/); assert.match(inputs[0], /ORIGINAL_QUOTE_SENTINEL/);
    assert.doesNotMatch(inputs[0], /EDITED_(?:HISTORY|QUOTE)_SENTINEL/);
    assert.equal(events(files.ledger).filter(event => event.kind === "history").length, 1);
    assert.equal(events(files.ledger).filter(event => event.kind === "quote").length, 1);
  } finally { await flush(); store.close(); files.cleanup(); }
});

test("original preparing inbox recovers an unknown upload after actual process exit without another download or POST", async () => {
  const files = fixture(), incoming = message({ resources: [{ type: "file", id: "pdf-source", name: "original.pdf" }] });
  exitPreparing(files, incoming, `ark.uploadFile=async(name,mime,bytes,operation)=>{
    record({kind:'upload',name,bytes:bytes.byteLength,uploadName:operation?.uploadName});process.exit(77);
  };`);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock();
  try {
    const original = store.inbox.findMessage(incoming)!;
    assert.equal(original.state, "preparing"); assert.equal(original.preparation, undefined);
    assert.ok(original.preparationPlan, "上传前必须保存完整准备计划及未完成步骤");
    const receipt = store.attachmentTrace.list(incoming).items.find(item => item.stage === "upload")!;
    assert.equal(receipt.status, "pending");
    const uploaded = events(files.ledger).find(event => event.kind === "upload")!;
    const file = { id: "file-original-recovered", object: "file", filename: uploaded.uploadName, bytes: uploaded.bytes,
      purpose: "user_data", status: "active", created_at: Math.floor(receipt.startedAt / 1000), expire_at: Math.floor(Date.now() / 1000) + 3600 };
    let gets = 0, downloads = 0, uploads = 0, mounts = 0, messagePosts = 0; const inputs: string[] = [];
    const client = new ArkClient("fixture-secret", "https://ark.test", async (url, init) => {
      const path = new URL(String(url)).pathname, method = init?.method || "GET";
      if (path.startsWith("/files")) {
        gets++; assert.equal(method, "GET", "恢复不得再次向Files API提交上传");
        return Response.json(String(url).includes("?") ? { data: [file], has_more: false, first_id: file.id, last_id: file.id } : file);
      }
      if (path === `/sessions/${sessionId}/resources`) {
        assert.equal(method, "POST"); mounts++;
        assert.equal(JSON.parse(String(init?.body)).file_id, file.id);
        return Response.json({ id: "resource-original-recovered" });
      }
      if (path === `/sessions/${sessionId}/events/stream`) {
        assert.equal(method, "GET");
        return new Response([
          'data: {"type":"agent.message","content":[{"type":"text","text":"完成"}]}', "",
          'data: {"type":"session.status_idle"}', "", ""
        ].join("\n"), { headers: { "Content-Type": "text/event-stream" } });
      }
      if (path === `/sessions/${sessionId}/events`) {
        if (method === "POST") {
          messagePosts++;
          assert.deepEqual(JSON.parse(String(init?.body)), { events: [{ type: "user.message", content: [{ type: "text", text: inputs[0] }] }] });
        } else assert.equal(method, "GET");
        return Response.json({ data: [] });
      }
      assert.fail(`未预期的模拟请求：${method} ${path}`);
    });
    const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建Session"); },
      inspectSessionReadiness: ready, inspectFileUpload: client.inspectFileUpload.bind(client),
      uploadFile: async () => { uploads++; throw Error("不能重复上传"); },
      addSessionResource: client.addSessionResource.bind(client),
      run: async (id, input, timeout) => { assert.equal(id, sessionId); inputs.push(input); return client.run(id, input, timeout); }
    }, async () => {}, { ...options, downloadAttachment: async () => { downloads++; throw Error("不能重复下载"); } });
    gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(incoming);
    await until(() => store.inbox.findMessage(incoming)?.state === "completed", "原上传中断任务应完成，不需要新消息");
    assert.equal(store.inbox.findMessage(incoming)!.id, original.id);
    assert.deepEqual({ gets, downloads, uploads, mounts, runs: inputs.length }, { gets: 2, downloads: 0, uploads: 0, mounts: 1, runs: 1 });
    assert.equal(messagePosts, 1, "不仅Gateway.run调用一次，真实ArkClient也只能发一次user.message POST");
    assert.match(inputs[0], /original\.pdf/);
    assert.equal(store.attachmentTrace.list(incoming).items.filter(item => item.stage === "upload").length, 1);
  } finally { await flush(); store.close(); files.cleanup(); }
});

for (const point of ["during-download", "before-upload-intent"] as const) test(`original pending attachment stays paused without persistent bytes or an upload intent: ${point}`, async () => {
  const files = fixture(), incoming = message({ resources: [{ type: "file", id: "pdf-source", name: "original.pdf" }] });
  exitPreparing(files, incoming, point === "during-download"
    ? "extra.downloadAttachment=async resource=>{record({kind:'download',name:resource.name});process.exit(77);};"
    : "store.attachmentTrace.beginUpload=()=>process.exit(77);");
  const store = new GatewayStore(files.path); store.acquireRuntimeLock();
  try {
    const original = store.inbox.findMessage(incoming)!;
    assert.ok(original.preparationPlan?.steps.some(step => step.kind === "attachment" && step.state === "pending"));
    const receipts = store.attachmentTrace.list(incoming).items;
    assert.equal(receipts.filter(item => item.stage === "upload").length, 0);
    assert.equal(receipts.find(item => item.stage === "download")?.status, point === "during-download" ? "pending" : "succeeded");
    assert.equal(store.getAttachment(receipts.find(item => item.stage === "download")!.attachmentKey), undefined);
    let downloads = 0, uploads = 0, mounts = 0, inspections = 0, runs = 0;
    const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能创建替代Session"); }, inspectSessionReadiness: ready,
      inspectFileUpload: async () => { inspections++; return { status: "unknown", reason: "not_found" }; },
      uploadFile: async name => { uploads++; return { id: "unexpected-file", name }; },
      addSessionResource: async () => { mounts++; }, run: async () => { runs++; return done(); }
    }, async () => {}, { ...options, downloadAttachment: async () => { downloads++; return { bytes: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" }; } });
    gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(incoming);
    for (let i = 0; i < 20; i++) await flush();
    const current = store.inbox.findMessage(incoming)!;
    assert.equal(current.id, original.id); assert.equal(current.state, "uncertain");
    assert.equal(current.preparation, undefined);
    assert.deepEqual({ downloads, uploads, mounts, inspections, runs }, { downloads: 0, uploads: 0, mounts: 0, inspections: 0, runs: 0 });
    assert.equal(events(files.ledger).filter(event => event.kind === "download").length, 1);
  } finally { await flush(); store.close(); files.cleanup(); }
});

function historyFiles(): ChannelHistoryMessage[] {
  return Array.from({ length: 9 }, (_, index) => ({ messageId: `source-${index}`, senderId: "alice", senderType: "user", source: "chat",
    createTime: 10 + index, text: `文件 ${index}`, resources: [{ type: "file", id: `resource-${index}`, name: `part-${index}.pdf` }] }));
}

async function uninterruptedInput(bytes: number): Promise<{ input: string; uploads: string[]; mounts: string[] }> {
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock(); const incoming = message();
  store.saveSession(toConversationKey(incoming, true), sessionId, "agent");
  const inputs: string[] = [], uploads: string[] = [], mounts: string[] = [];
  try {
    new Gateway(store, { createSession: async () => { assert.fail("不能重建"); },
      uploadFile: async name => { uploads.push(name); return { id: `file-${name}`, name }; },
      addSessionResource: async (_id, resource) => { mounts.push(String(resource.file_id)); },
      run: async (_id, input) => { inputs.push(input); return done(); }
    }, async () => {}, { ...options, loadRecentHistory: async () => historyFiles(), downloadAttachment: async (resource, _message, maxBytes) => {
      if (bytes > (maxBytes ?? Infinity)) throw Error(`文件 ${resource.name} 超过本轮剩余 1 MB 限制`);
      return { bytes: new Uint8Array(bytes), mimeType: "application/pdf" };
    } }).accept(incoming);
    await until(() => store.inbox.findMessage(incoming)?.state === "completed", "无中断基准任务应完成");
    assert.equal(inputs.length, 1); return { input: inputs[0], uploads, mounts };
  } finally { await flush(); store.close(); }
}

for (const bytes of [3, 6 * 1024 * 1024]) test(`original inbox keeps the selected historical eight and byte budget after two mounts (${bytes} bytes each)`, async () => {
  const baseline = await uninterruptedInput(bytes), files = fixture(), incoming = message();
  assert.deepEqual(baseline.uploads, Array.from({ length: bytes === 3 ? 8 : 6 }, (_, i) => `part-${i + 1}.pdf`));
  exitPreparing(files, incoming, `extra.loadRecentHistory=async()=>${JSON.stringify(historyFiles())};
    extra.downloadAttachment=async(resource,source,maxBytes)=>{
      record({kind:'download',name:resource.name,maxBytes});
      if(${bytes}>maxBytes)throw Error('文件 '+resource.name+' 超过本轮剩余 1 MB 限制');
      return{bytes:new Uint8Array(${bytes}),mimeType:'application/pdf'};
    };
    let finished=0;const mark=store.markAttachmentMounted.bind(store);
    store.markAttachmentMounted=(...args)=>{mark(...args);if(++finished===2)process.exit(77);};`);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock();
  try {
    const original = store.inbox.findMessage(incoming)!;
    assert.ok(original.preparationPlan); assert.equal(original.preparation, undefined);
    const before = events(files.ledger);
    assert.equal(before.filter(event => event.kind === "mount").length, 2);
    let reads = 0; const uploads: string[] = [], mounts: string[] = [], downloads: string[] = [], inputs: string[] = [];
    const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建Session"); }, inspectSessionReadiness: ready,
      uploadFile: async name => { uploads.push(name); return { id: `file-${name}`, name }; },
      addSessionResource: async (id, resource) => { assert.equal(id, sessionId); mounts.push(String(resource.file_id)); },
      run: async (id, input) => { assert.equal(id, sessionId); inputs.push(input); return done(); }
    }, async () => {}, { ...options, loadRecentHistory: async () => { reads++; return historyFiles().reverse(); },
      downloadAttachment: async (resource, _message, maxBytes) => {
        downloads.push(resource.name);
        if (bytes > (maxBytes ?? Infinity)) throw Error(`文件 ${resource.name} 超过本轮剩余 1 MB 限制`);
        return { bytes: new Uint8Array(bytes), mimeType: "application/pdf" };
      } });
    gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(incoming);
    await until(() => store.inbox.findMessage(incoming)?.state === "completed", "原历史附件任务应恢复完成");
    assert.equal(store.inbox.findMessage(incoming)!.id, original.id); assert.equal(reads, 0);
    assert.deepEqual([...before.filter(event => event.kind === "upload").map(event => event.name), ...uploads], baseline.uploads);
    assert.deepEqual([...before.filter(event => event.kind === "mount").map(event => (event.resource as { file_id: string }).file_id), ...mounts], baseline.mounts);
    assert.ok(!downloads.includes("part-0.pdf"), "不能补入原先未入选的第九个附件");
    assert.ok(!downloads.includes("part-1.pdf") && !downloads.includes("part-2.pdf"), "已完成附件不得重新下载");
    assert.deepEqual(inputs, [baseline.input], "恢复不得改变附件选择、预算、上下文或失败提示");
    if (bytes > 3) assert.match(inputs[0], /文件大小超过本轮剩余额度，请缩小文件或分批处理/, "预算提示不能在步骤重放包装时退化成不明原因");
  } finally { await flush(); store.close(); files.cleanup(); }
});

test("an interrupted non-idempotent preparation hook stays uncertain and is never invoked again", async () => {
  const files = fixture(), incoming = message();
  exitPreparing(files, incoming, "extra.beforeCreateSession=async()=>{record({kind:'hook'});process.exit(77);};");
  const store = new GatewayStore(files.path); store.acquireRuntimeLock();
  try {
    const original = store.inbox.findMessage(incoming)!;
    assert.ok(original.preparationPlan?.steps.some(step => step.kind === "hook" && step.state === "pending"));
    let hooks = 0, runs = 0, creates = 0;
    const gateway = new Gateway(store, { createSession: async () => { creates++; return "unexpected"; }, inspectSessionReadiness: ready,
      run: async () => { runs++; return done(); } }, async () => {}, { ...options, beforeCreateSession: async () => { hooks++; } });
    gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(incoming);
    for (let i = 0; i < 20; i++) await flush();
    const current = store.inbox.findMessage(incoming)!;
    assert.equal(current.id, original.id); assert.equal(current.state, "uncertain");
    assert.deepEqual({ hooks, runs, creates }, { hooks: 0, runs: 0, creates: 0 });
    assert.equal(events(files.ledger).filter(event => event.kind === "hook").length, 1);
  } finally { await flush(); store.close(); files.cleanup(); }
});
