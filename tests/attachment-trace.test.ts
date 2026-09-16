import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { GatewayStore } from "../src/store.ts";
import { Gateway, type IncomingMessage } from "../src/gateway.ts";
import { ArkClient, ArkHttpError } from "../src/ark.ts";

const key = "a".repeat(64);
const message = (patch: Partial<IncomingMessage> = {}): IncomingMessage => ({
  channelType: "lark", installationId: "app", tenantId: "tenant", conversationId: "chat",
  conversationType: "direct", senderId: "user", eventId: "event", messageId: "message",
  threadId: "", rootMessageId: "", parentMessageId: "", createTime: 100,
  text: "分析文件", resources: [], mentionedBot: false, ...patch
});

for (const stage of ["upload", "mount", "create"] as const) test(`Gateway persists safe MA diagnostics for ${stage} failures after database reopen`, async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ark-error-trace-")), "gateway.db");
  let store = new GatewayStore(path);
  const replies: string[] = [];
  const source = message({ messageId: "source", eventId: "source", createTime: 50, conversationType: stage === "mount" ? "group" : "direct",
    resources: [{ id: "file", name: "a.pdf", type: "file" }] });
  let calls = 0;
  const client = new ArkClient("PRIVATE-KEY", "https://example.invalid", async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: "APIAccountRpmRateLimitExceeded", message: "PRIVATE-KEY FILE-CONTENT" } }),
      { status: 429, headers: { "x-request-id": "request-trace-123" } });
  });
  const gateway = new Gateway(store, {
    createSession: async request => stage === "create" ? client.createSession(request) : "session",
    uploadFile: async (name, mime, bytes) => stage === "upload" ? client.uploadFile(name, mime, bytes) : { id: "file", name },
    addSessionResource: async (id, resource) => client.addSessionResource(id, resource),
    run: async () => ({ terminal: "idle", messages: ["完成"] })
  }, async (_chat, content) => { replies.push(content); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 1000, authorizedUserId: "user", platformAccess: true, sharedGroupSessions: true,
    loadRecentHistory: async () => [{ messageId: source.messageId, senderId: "user", senderType: "user", source: "chat", text: "附件", createTime: 50, resources: source.resources }],
    downloadAttachment: async () => ({ bytes: new Uint8Array([1]), mimeType: "application/pdf" })
  });
  await execute(gateway, stage === "mount" ? message({ conversationType: "group", mentionedBot: true }) : source, replies);
  store.close(); store = new GatewayStore(path);
  const record = store.attachmentTrace.list(source).items.find(item => item.status === "error")!;
  assert.equal(record.stage, stage === "upload" ? "upload" : "mount");
  assert.deepEqual(record.failure, { kind: "rate_limit", status: 429, code: "APIAccountRpmRateLimitExceeded", requestId: "request-trace-123" });
  assert.equal(record.rejected, undefined); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(record) + replies.join(""), /PRIVATE-KEY|FILE-CONTENT/);
  store.close();
});

test("attachment failure metadata drops unknown fields and invalid diagnostic values", () => {
  const store = new GatewayStore(":memory:");
  const id = store.attachmentTrace.begin(message(), key, "download");
  store.attachmentTrace.finish(id, "error", { failure: { kind: "PRIVATE", status: 200, code: "https://SECRET", requestId: "bad\nID", message: "FILE-CONTENT", cause: "TOKEN" } } as never);
  assert.deepEqual(store.attachmentTrace.list(message()).items[0].failure, { kind: "unknown" });
  store.close();
});

test("attachment stages persist exact byte hashes without body or arbitrary error payload", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ark-attachment-trace-")), "gateway.db");
  let store = new GatewayStore(path);
  const id = store.attachmentTrace.begin(message(), key, "download");
  store.attachmentTrace.finish(id, "succeeded", { bytes: 3, sha256: "b".repeat(64), secret: "PRIVATE-BODY" } as never);
  store.close(); store = new GatewayStore(path);
  const entries = store.attachmentTrace.list(message()).items;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].stage, "download");
  assert.equal(entries[0].status, "succeeded");
  assert.equal(entries[0].bytes, 3);
  assert.equal(entries[0].sha256, "b".repeat(64));
  assert.ok(entries[0].durationMs! >= 0);
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE-BODY|secret|分析文件/);
  assert.throws(() => store.attachmentTrace.finish(id, "succeeded"), /结束/);
  store.close();
});

test("unfinished writes remain unknown after reopening and traces are scope isolated", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ark-attachment-trace-")), "gateway.db");
  let store = new GatewayStore(path);
  store.attachmentTrace.begin(message(), key, "upload");
  store.close(); store = new GatewayStore(path);
  assert.equal(store.attachmentTrace.list(message()).items[0].status, "pending");
  for (const patch of [{ tenantId: "other" }, { installationId: "other" }, { conversationId: "other" }, { threadId: "other" }, { messageId: "other" }]) {
    assert.equal(store.attachmentTrace.list(message(patch)).items.length, 0);
  }
  store.close();
});

async function execute(gateway: Gateway, incoming: IncomingMessage, replies: string[]): Promise<void> {
  const before = replies.length;
  gateway.accept(incoming);
  for (let count = 0; count < 200 && replies.length === before; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(replies.length > before, "网关应完成该轮回复");
  await new Promise(resolve => setTimeout(resolve, 5));
}

test("new Session traces each initial file mount before running", async () => {
  const store = new GatewayStore(":memory:");
  const replies: string[] = [];
  const incoming = message({ resources: [{ id: "file-a", name: "a.pdf", type: "file" }, { id: "file-b", name: "b.pdf", type: "file" }] });
  let downloads = 0, uploads = 0;
  const gateway = new Gateway(store, {
    createSession: async () => "session",
    uploadFile: async name => ({ id: `file-${++uploads}`, name }),
    run: async () => {
      const records = store.attachmentTrace.list(incoming).items;
      assert.equal(records.filter(item => item.stage === "mount" && item.status === "succeeded").length, 2);
      return { terminal: "idle", messages: ["完成"] };
    }
  }, async () => { replies.push("reply"); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, authorizedUserId: "user",
    downloadAttachment: async () => { downloads++; return { bytes: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" }; }
  });
  await execute(gateway, incoming, replies);
  assert.equal(downloads, 2); assert.equal(uploads, 2);
  const records = store.attachmentTrace.list(incoming).items;
  assert.equal(records.length, 6);
  assert.ok(records.every(item => item.status === "succeeded"));
  assert.equal(records[0].sha256, createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex"));
  assert.ok(records.filter(item => item.stage === "mount").every(item => item.sessionId === "session"));
  assert.ok(records.every(item => !["read", "understood"].includes(item.stage)));
  store.close();
});

test("history multi-file failure is isolated and never claimed mounted", async () => {
  const store = new GatewayStore(":memory:");
  const replies: string[] = [];
  const source = message({ messageId: "history", eventId: "history", createTime: 50, conversationType: "group" });
  let prompt = "";
  const gateway = new Gateway(store, {
    createSession: async () => "session",
    uploadFile: async name => { if (name === "bad.pdf") throw new Error("PRIVATE-TOKEN"); return { id: "file-ok", name }; },
    addSessionResource: async () => undefined,
    run: async (_id, input) => { prompt = input; return { terminal: "idle", messages: ["结果"] }; }
  }, async () => { replies.push("reply"); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000,
    platformAccess: true, sharedGroupSessions: true,
    loadRecentHistory: async () => [{ messageId: source.messageId, senderId: source.senderId, senderType: "user", source: "chat", text: "附件", createTime: 50,
      resources: [{ id: "good", name: "good.pdf", type: "file" }, { id: "bad", name: "bad.pdf", type: "file" }] }],
    downloadAttachment: async () => ({ bytes: new Uint8Array([1]), mimeType: "application/pdf" })
  });
  await execute(gateway, message({ conversationType: "group", mentionedBot: true }), replies);
  const records = store.attachmentTrace.list(source).items;
  assert.equal(records.filter(item => item.stage === "mount").length, 1);
  assert.equal(records.filter(item => item.status === "error").length, 1);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE-TOKEN/);
  assert.doesNotMatch(prompt, /PRIVATE-TOKEN/);
  assert.match(prompt, /good.pdf/);
  assert.match(prompt, /未能挂载/);
  store.close();
});

test("attachment trace pagination does not mix messages or omit entries", () => {
  const store = new GatewayStore(":memory:");
  for (let n = 0; n < 203; n++) store.attachmentTrace.begin(message(), key, "cache");
  store.attachmentTrace.begin(message({ messageId: "other" }), key, "cache");
  const first = store.attachmentTrace.list(message());
  const second = store.attachmentTrace.list(message(), first.next);
  assert.equal(first.items.length, 200); assert.equal(second.items.length, 3);
  assert.equal(second.next, undefined);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 203);
  assert.throws(() => store.attachmentTrace.list(message(), -1), /游标/);
  store.close();
});

test("upload outcome remains pending after actual Gateway process exits during the request", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ark-attachment-crash-")), "gateway.db");
  const incoming = message({ resources: [{ id: "file", name: "a.pdf", type: "file" }] });
  const code = `
    import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    import { Gateway } from ${JSON.stringify(new URL("../src/gateway.ts", import.meta.url).href)};
    const store = new GatewayStore(${JSON.stringify(path)});
    const gateway = new Gateway(store, {
      createSession: async () => { throw new Error('must not create'); },
      uploadFile: async () => { process.exit(79); },
      run: async () => { throw new Error('must not run'); }
    }, async () => {}, {
      agentId: 'agent', environmentId: 'env', vaultId: 'vault', timeoutMs: 5000, authorizedUserId: 'user',
      downloadAttachment: async () => ({ bytes: new Uint8Array([1,2,3]), mimeType: 'application/pdf' })
    });
    gateway.accept(${JSON.stringify(incoming)});
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 79, result.stderr);
  const store = new GatewayStore(path);
  assert.deepEqual(store.attachmentTrace.list(incoming).items.map(item => [item.stage, item.status]), [["download", "succeeded"], ["upload", "pending"]]);
  assert.equal(store.attachmentTrace.list(incoming).items[1].finishedAt, undefined);
  store.close();
});

for (const failedStage of ["download", "mount", "create"] as const) test(`records ${failedStage} errors without promoting attachment readiness`, async () => {
  const store = new GatewayStore(":memory:");
  const replies: string[] = [];
  const source = message({ messageId: "source", eventId: "source", createTime: 50, conversationType: failedStage === "create" ? "direct" : "group",
    resources: [{ id: "file", name: "a.pdf", type: "file" }] });
  let runCount = 0;
  const gateway = new Gateway(store, {
    createSession: async () => { if (failedStage === "create") throw new Error("create failed"); return "session"; },
    uploadFile: async name => ({ id: "file-id", name }),
    addSessionResource: async () => { throw new Error("mount failed"); },
    run: async () => { runCount++; return { terminal: "idle", messages: ["完成"] }; }
  }, async () => { replies.push("reply"); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, authorizedUserId: "user",
    platformAccess: true, sharedGroupSessions: true,
    loadRecentHistory: async () => [{ messageId: source.messageId, senderId: source.senderId, senderType: "user", source: "chat", text: "文件", createTime: 50, resources: source.resources }],
    downloadAttachment: async () => { if (failedStage === "download") throw new Error("download failed"); return { bytes: new Uint8Array([1]), mimeType: "application/pdf" }; }
  });
  await execute(gateway, failedStage === "create" ? source : message({ conversationType: "group", mentionedBot: true }), replies);
  const records = store.attachmentTrace.list(source).items;
  assert.equal(records.at(-1)?.stage, failedStage === "download" ? "download" : "mount");
  assert.equal(records.at(-1)?.status, "error");
  assert.equal(records.filter(item => item.stage === "mount" && item.status === "succeeded").length, 0);
  if (failedStage === "create") assert.equal(runCount, 0);
  store.close();
});

test("uploaded file cache survives reopen and is reused without another download or upload", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ark-attachment-cache-")), "gateway.db");
  const source = message({ messageId: "source", eventId: "source", createTime: 50, conversationType: "group" });
  let store = new GatewayStore(path), downloads = 0, uploads = 0, mounts = 0;
  const replies: string[] = [];
  const makeGateway = () => new Gateway(store, {
    createSession: async () => "session", uploadFile: async name => { uploads++; return { id: "file-id", name }; },
    addSessionResource: async () => { mounts++; if (mounts === 1) throw new ArkHttpError("mount rejected", 400, "InvalidParameter"); },
    run: async () => ({ terminal: "idle", messages: ["结果"] })
  }, async () => { replies.push("reply"); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, platformAccess: true, sharedGroupSessions: true,
    loadRecentHistory: async () => [{ messageId: source.messageId, senderId: source.senderId, senderType: "user", source: "chat", text: "文件", createTime: 50,
      resources: [{ id: "file", name: "a.pdf", type: "file" }] }],
    downloadAttachment: async () => { downloads++; return { bytes: new Uint8Array([1]), mimeType: "application/pdf" }; }
  });
  await execute(makeGateway(), message({ conversationType: "group", mentionedBot: true }), replies);
  store.close(); store = new GatewayStore(path);
  await execute(makeGateway(), message({ messageId: "next", eventId: "next", createTime: 200, conversationType: "group", mentionedBot: true }), replies);
  assert.equal(downloads, 1); assert.equal(uploads, 1); assert.equal(mounts, 2);
  const records = store.attachmentTrace.list(source).items;
  assert.deepEqual(records.map(item => [item.stage, item.status]), [["download", "succeeded"], ["upload", "succeeded"], ["mount", "error"], ["cache", "succeeded"], ["mount", "succeeded"]]);
  assert.equal(records[3].sha256, records[0].sha256);
  store.close();
});

test("confirmed upload receipt recovers a crash before cache save without uploading twice", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ark-attachment-confirmed-")), "gateway.db");
  const source = message({ resources: [{ id: "file", name: "a.pdf", type: "file" }], conversationType: "group", mentionedBot: true, createTime: 50 });
  const code = `
    import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    import { Gateway } from ${JSON.stringify(new URL("../src/gateway.ts", import.meta.url).href)};
    const store = new GatewayStore(${JSON.stringify(path)});
    store.saveAttachment = () => { process.exit(79); };
    new Gateway(store, {
      createSession: async () => 'session',
      uploadFile: async name => ({ id: 'confirmed-file', name }),
      run: async () => { throw new Error('must not run'); }
    }, async () => {}, {
      agentId: 'agent', environmentId: 'env', vaultId: 'vault', timeoutMs: 5000, platformAccess: true, sharedGroupSessions: true,
      downloadAttachment: async () => ({ bytes: new Uint8Array([1,2,3]), mimeType: 'application/pdf' })
    }).accept(${JSON.stringify(source)});
  `;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 79, child.stderr);
  const store = new GatewayStore(path), replies: string[] = [];
  let downloads = 0, uploads = 0, mountedId = "";
  const gateway = new Gateway(store, {
    createSession: async () => "session", uploadFile: async name => { uploads++; return { id: "duplicate-file", name }; },
    addSessionResource: async (_id, resource) => { mountedId = String(resource.file_id); },
    run: async () => ({ terminal: "idle", messages: ["结果"] })
  }, async () => { replies.push("reply"); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, platformAccess: true, sharedGroupSessions: true,
    loadRecentHistory: async () => [{ messageId: source.messageId, senderId: source.senderId, senderType: "user", source: "chat", text: "文件", createTime: 50, resources: source.resources }],
    downloadAttachment: async () => { downloads++; return { bytes: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" }; }
  });
  await execute(gateway, message({ messageId: "next", eventId: "next", conversationType: "group", mentionedBot: true, createTime: 200 }), replies);
  assert.equal(mountedId, "confirmed-file"); assert.equal(downloads, 0); assert.equal(uploads, 0);
  assert.equal(store.attachmentTrace.list(source).items.filter(item => item.stage === "upload").length, 1);
  store.close();
});

test("inline files are prepared as text, not reported as a filesystem mount", async () => {
  const store = new GatewayStore(":memory:");
  const replies: string[] = [];
  const incoming = message({ resources: [{ id: "text", name: "notes.txt", type: "file" }] });
  const gateway = new Gateway(store, { createSession: async () => "session", run: async () => ({ terminal: "idle", messages: ["完成"] }) },
    async () => { replies.push("reply"); }, { agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, authorizedUserId: "user",
      downloadAttachment: async () => ({ bytes: new TextEncoder().encode("PRIVATE-CONTENT"), mimeType: "text/plain" }) });
  await execute(gateway, incoming, replies);
  const records = store.attachmentTrace.list(incoming).items;
  assert.deepEqual(records.map(item => item.stage), ["download", "inline"]);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE-CONTENT/);
  store.close();
});
