import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArkClient } from "../src/ark.ts";
import { Gateway, toConversationKey, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import { AttachmentTraceStore } from "../src/attachment-trace.ts";

const file = { id: "resource", type: "file", file_id: "file", mount_path: "/mnt/session/uploads/mnt/data/a.pdf", access: "read_only" };
const query = { sessionId: "session", fileId: "file", mountPath: "/mnt/data/a.pdf" };

test("mount inspection uses the documented resource list and binds its proof to the exact request", async () => {
  const requests: string[] = [];
  const client = new ArkClient("secret", "https://ark.test", async (url, init) => {
    requests.push(`${init?.method || "GET"} ${url}`);
    return Response.json({ data: [file] });
  });
  const result = await client.inspectFileMount(query);
  assert.equal(result.status, "confirmed");
  assert.deepEqual(result.status === "confirmed" && { ...result, checkedAt: 0 }, { status: "confirmed", ...query, resourceId: "resource", checkedAt: 0 });
  assert.deepEqual(requests, ["GET https://ark.test/sessions/session/resources"]);
});

for (const [name, data] of Object.entries({
  absent: [], otherFile: [{ ...file, file_id: "other" }], otherPath: [{ ...file, mount_path: "/elsewhere" }],
  unverifiedPathAlias: [{ ...file, mount_path: "/mnt/data/a.pdf" }],
  noId: [{ ...file, id: undefined }], unknownAccess: [{ ...file, access: "denied" }],
  conflictingPath: [file, { ...file, id: "other", file_id: "other" }], duplicate: [file, file],
  invalidEnvelope: undefined, malformedRow: [file, null]
})) test(`mount inspection does not confirm ${name} or authorize another POST`, async () => {
  const client = new ArkClient("secret", "https://ark.test", async () => Response.json({ data }));
  assert.equal((await client.inspectFileMount(query)).status, "unknown");
});

test("mount inspection redacts HTTP errors and cancels a stalled response body", async () => {
  const failed = new ArkClient("secret", "https://ark.test", async () => new Response("PRIVATE-CONTENT", { status: 403 }));
  assert.deepEqual(await failed.inspectFileMount(query), { status: "unknown", reason: "resources_unavailable" });
  let cancelled = false;
  const stalled = new ArkClient("secret", "https://ark.test", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')); }, cancel() { cancelled = true; }
  })), { inspectionTimeoutMs: 20 });
  const keepAlive = setInterval(() => {}, 10);
  try { assert.equal((await stalled.inspectFileMount(query)).status, "unknown"); }
  finally { clearInterval(keepAlive); }
  assert.equal(cancelled, true);
});

function message(id: string, patch: Partial<IncomingMessage> = {}): IncomingMessage {
  return { channelType: "lark", installationId: "app", tenantId: "tenant", conversationId: "chat", conversationType: "group",
    senderId: "user", eventId: id, messageId: id, threadId: "", rootMessageId: "", parentMessageId: "", createTime: 100,
    text: "分析附件", resources: [], mentionedBot: true, ...patch };
}
async function send(gateway: Gateway, id: string, replies: string[]) {
  const count = replies.length;
  gateway.accept(message(id));
  for (let i = 0; i < 200 && replies.length === count; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(replies.length, count + 1);
  await new Promise(resolve => setTimeout(resolve, 5));
}

for (const mode of ["confirmed", "unknown", "wrong-session", "stale", "session-changed", "unavailable", "no-inspector"]) test(`Gateway reopens an unknown mount: ${mode}, without another POST`, async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ark-mount-recovery-")), "gateway.db");
  let store = new GatewayStore(path), posts = 0, gets = 0, uploads = 0;
  const replies: string[] = [], inputs: string[] = [];
  let remote: Record<string, unknown> | undefined;
  const makeGateway = () => new Gateway(store, {
    createSession: async () => "session", uploadFile: async name => { uploads++; return { id: "file", name }; },
    addSessionResource: async (_session, resource) => { posts++; remote = resource; throw new Error("response lost PRIVATE"); },
    inspectFileMount: mode === "no-inspector" ? undefined : async q => {
      gets++;
      if (mode === "unavailable") throw new Error("PRIVATE ERROR");
      if (mode === "session-changed") store.saveSession(toConversationKey(message("two"), true), "replacement", "agent");
      return mode === "unknown" ? { status: "unknown", reason: "not_found" }
        : { status: "confirmed", ...q, sessionId: mode === "wrong-session" ? "other" : q.sessionId,
          resourceId: "resource", checkedAt: Date.now() - (mode === "stale" ? 60_000 : 0) };
    },
    run: async (_id, input) => { inputs.push(input); return { terminal: "idle", messages: ["完成"] }; }
  }, async (_message, output) => { if (output.type === "text") replies.push(output.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, platformAccess: true, sharedGroupSessions: true,
    downloadAttachment: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" }),
    loadRecentHistory: async () => [{ messageId: "source", senderId: "user", senderType: "user", source: "chat", text: "文件", createTime: 50,
      resources: [{ id: "source-file", name: "a.pdf", type: "file" }] }]
  });
  await send(makeGateway(), "one", replies);
  assert.equal(posts, 1); assert.equal(gets, 0); assert.ok(remote);
  store.close(); store = new GatewayStore(path);
  await send(makeGateway(), "two", replies);
  assert.equal(posts, 1); assert.equal(gets, mode === "no-inspector" ? 0 : 1); assert.equal(uploads, 1);
  assert.doesNotMatch(replies.join(""), /PRIVATE/);
  if (mode === "confirmed") {
    assert.match(inputs[1], /已挂载到/);
    const records = store.attachmentTrace.list(message("source")).items;
    assert.equal(records.filter(r => r.stage === "mount" && r.status === "error").length, 1);
    assert.equal(records.filter(r => r.stage === "mount_check" && r.status === "succeeded").length, 1);
    await send(makeGateway(), "three", replies);
    assert.equal(gets, 1); assert.equal(posts, 1);
  } else {
    assert.doesNotMatch(inputs[1], /已挂载到/);
    assert.match(replies[1], /附件提示/);
  }
  store.close();
});

for (const point of ["before-response", "before-marker"]) test(`actual process exits ${point}; recovery keeps the original file and Session`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ark-mount-crash-")), path = join(directory, "gateway.db"), remotePath = join(directory, "remote.json");
  const source = { messageId: "source", senderId: "user", senderType: "user", source: "chat", text: "文件", createTime: 50,
    resources: [{ id: "source-file", name: "a.pdf", type: "file" }] };
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { writeFileSync } from 'node:fs';
    import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    import { Gateway } from ${JSON.stringify(new URL("../src/gateway.ts", import.meta.url).href)};
    const store = new GatewayStore(${JSON.stringify(path)});
    if (${JSON.stringify(point)} === 'before-marker') store.markAttachmentMounted = () => process.exit(78);
    new Gateway(store, {
      createSession: async () => 'session', uploadFile: async name => ({ id: 'file', name }),
      addSessionResource: async (session, resource) => {
        writeFileSync(${JSON.stringify(remotePath)}, JSON.stringify({ session, resource, posts: 1 }));
        if (${JSON.stringify(point)} === 'before-response') process.exit(78);
      }, run: async () => { throw new Error('must not run'); }
    }, async () => {}, {
      agentId: 'agent', environmentId: 'env', vaultId: 'vault', timeoutMs: 5000, platformAccess: true, sharedGroupSessions: true,
      downloadAttachment: async () => ({ bytes: new Uint8Array([1,2,3]), mimeType: 'application/pdf' }),
      loadRecentHistory: async () => [${JSON.stringify(source)}]
    }).accept(${JSON.stringify(message("first"))});
  `], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 78, child.stderr);
  const remote = JSON.parse(readFileSync(remotePath, "utf8"));
  assert.equal(remote.posts, 1);
  const store = new GatewayStore(path), replies: string[] = [];
  let gets = 0, runs = 0;
  const client = new ArkClient("secret", "https://ark.test", async (url, init) => {
    gets++; assert.equal(init?.method || "GET", "GET"); assert.equal(url, "https://ark.test/sessions/session/resources");
    return Response.json({ data: [{ ...remote.resource, id: "resource", mount_path: `/mnt/session/uploads/${remote.resource.mount_path.replace(/^\/+/, "")}` }] });
  });
  const gateway = new Gateway(store, {
    createSession: async () => { assert.fail("不能创建替代Session"); },
    uploadFile: async () => { assert.fail("不能重复上传"); },
    addSessionResource: async () => { assert.fail("不能重复挂载"); },
    inspectFileMount: client.inspectFileMount.bind(client),
    run: async (session, input) => { runs++; assert.equal(session, "session"); assert.match(input, /已挂载到/); return { terminal: "idle", messages: ["完成"] }; }
  }, async (_message, output) => { if (output.type === "text") replies.push(output.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, platformAccess: true, sharedGroupSessions: true,
    downloadAttachment: async () => { assert.fail("不能重复下载"); }, loadRecentHistory: async () => [source as any]
  });
  await send(gateway, "after-restart", replies);
  assert.equal(runs, 1); assert.equal(gets, point === "before-response" ? 1 : 0);
  const records = store.attachmentTrace.list(message("source")).items;
  const mount = records.find(r => r.stage === "mount")!;
  assert.equal(store.isAttachmentMounted("session", mount.attachmentKey), true);
  assert.equal(mount.status, point === "before-response" ? "pending" : "succeeded");
  store.close();
});

test("mount proof is scoped, fresh, bound to the old receipt and saved atomically", () => {
  const db = new DatabaseSync(":memory:"), traces = new AttachmentTraceStore(db), key = "a".repeat(64), source = message("source");
  const original = traces.begin(source, key, "mount", query);
  const checkedAfter = Date.now();
  const proof = { status: "confirmed" as const, ...query, resourceId: "resource", checkedAt: Date.now() };
  for (const patch of [{ installationId: "other" }, { tenantId: "other" }, { conversationId: "other" }, { threadId: "other" }, { messageId: "other" }]) {
    assert.throws(() => traces.confirmMount({ ...source, ...patch }, key, original, proof, checkedAfter));
  }
  for (const patch of [{ sessionId: "other" }, { fileId: "other" }, { mountPath: "/other" }, { checkedAt: checkedAfter - 1 }, { checkedAt: Date.now() + 60_000 }]) {
    assert.throws(() => traces.confirmMount(source, key, original, { ...proof, ...patch }, checkedAfter));
  }
  db.exec("CREATE TRIGGER fail_proof BEFORE UPDATE ON attachment_stage_receipts WHEN NEW.stage='mount_check' BEGIN SELECT RAISE(ABORT, 'disk'); END;");
  assert.throws(() => traces.confirmMount(source, key, original, proof, checkedAfter), /disk/);
  assert.equal(traces.list(source).items.length, 1);
  db.exec("DROP TRIGGER fail_proof");
  traces.confirmMount(source, key, original, proof, checkedAfter);
  assert.equal(traces.latestMount(source, key, "session")?.resourceId, "resource");
  assert.throws(() => traces.confirmMount(source, key, original, proof, checkedAfter), /变化/);
  assert.equal(traces.list(source).items[0].status, "pending");
  db.close();
});

test("explicit InvalidParameter response remains distinguishable from unknown failure", async () => {
  const client = new ArkClient("secret", "https://ark.test", async () => Response.json({ error: { code: "InvalidParameter" } }, { status: 400 }));
  await assert.rejects(client.addSessionFile("session", "file", "path"), error => (error as any).status === 400 && (error as any).code === "InvalidParameter");
});

test("resource inspection rejects over-limit data and honors an already aborted caller", async () => {
  let calls = 0;
  const client = new ArkClient("secret", "https://ark.test", async () => { calls++; return Response.json({ data: Array.from({ length: 1001 }, () => file) }); });
  assert.equal((await client.inspectFileMount(query)).status, "unknown");
  assert.equal((await client.inspectFileMount(query, AbortSignal.abort())).status, "unknown");
  assert.equal(calls, 1);
  const huge = new ArkClient("secret", "https://ark.test", async () => new Response(" ".repeat(4 * 1024 * 1024 + 1)));
  assert.equal((await huge.inspectFileMount(query)).status, "unknown");
});

test("direct attachment recovery follows the same verified path without another upload or mount", async () => {
  const store = new GatewayStore(":memory:"), replies: string[] = [];
  const source = message("direct", { conversationType: "direct", resources: [{ id: "source-file", name: "a.pdf", type: "file" }] });
  const key = createHash("sha256").update(JSON.stringify([source.channelType, source.installationId, source.tenantId, source.conversationId, source.messageId, "source-file"])).digest("hex");
  store.saveSession(toConversationKey(source, true), "session", "agent");
  store.saveAttachment(key, { name: "a.pdf", bytes: 3, fileId: "file", mountPath: query.mountPath });
  store.attachmentTrace.begin(source, key, "mount", query);
  let gets = 0;
  const gateway = new Gateway(store, {
    createSession: async () => { assert.fail("不能重建Session"); },
    addSessionResource: async () => { assert.fail("不能重挂载"); },
    inspectFileMount: async q => { gets++; return { status: "confirmed", ...q, resourceId: "resource", checkedAt: Date.now() }; },
    run: async (id, input) => { assert.equal(id, "session"); assert.match(input, /文件已挂载到/); return { terminal: "idle", messages: ["完成"] }; }
  }, async (_message, output) => { if (output.type === "text") replies.push(output.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, authorizedUserId: "user",
    downloadAttachment: async () => { assert.fail("不能重新下载"); }
  });
  gateway.accept(source);
  for (let i = 0; i < 200 && !replies.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(replies.length, 1); assert.equal(gets, 1);
  assert.equal(store.isAttachmentMounted("session", key), true);
  store.close();
});

test("new Session never reuses a previous Session mount proof", () => {
  const store = new GatewayStore(":memory:"), source = message("source"), key = "a".repeat(64);
  const id = store.attachmentTrace.begin(source, key, "mount", query);
  store.attachmentTrace.finish(id, "succeeded");
  assert.equal(store.attachmentTrace.latestMount(source, key, "new-session"), undefined);
  store.close();
});

test("resource list error or incomplete envelope cannot confirm a mount", async () => {
  for (const patch of [{ error: { code: "Failure" } }, { has_more: true }, { next_page: "page" }]) {
    const client = new ArkClient("secret", "https://ark.test", async () => Response.json({ data: [file], ...patch }));
    assert.equal((await client.inspectFileMount(query)).status, "unknown");
  }
});

test("mount lookup uses a bounded index across historical receipts", () => {
  const db = new DatabaseSync(":memory:"), traces = new AttachmentTraceStore(db), source = message("source"), key = "a".repeat(64);
  traces.begin(source, key, "mount", query);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM attachment_stage_receipts WHERE scope=? AND attachment_key=?
    AND json_extract(details, '$.sessionId')=? AND (stage='mount' OR (stage='mount_check' AND status='succeeded'))
    ORDER BY sequence DESC LIMIT 1`).all("scope", key, "session");
  assert.match(JSON.stringify(plan), /SEARCH.*attachment_mount_lookup/);
  assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/);
  db.close();
});
