import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ArkClient, ArkHttpError } from "../src/ark.ts";
import { Gateway, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import { AttachmentTraceStore } from "../src/attachment-trace.ts";
import { DatabaseSync } from "node:sqlite";

const uploadName = "arkagent-12345678-1234-4234-8234-123456789abc.pdf";
const query = () => ({ uploadName, bytes: 3, startedAt: Date.now() - 1000 });
const remoteFile = (q = query()) => ({ id: "file-confirmed", object: "file", filename: q.uploadName, bytes: q.bytes,
  purpose: "user_data", status: "active", created_at: Math.floor(q.startedAt / 1000), expire_at: Math.floor(Date.now() / 1000) + 3600 });
const page = (data: unknown[], more = false) => ({ data, has_more: more, first_id: (data[0] as any)?.id || "", last_id: (data.at(-1) as any)?.id || "" });

test("upload can use an opaque remote name without changing the ordinary API default", async () => {
  const names: string[] = [];
  const client = new ArkClient("secret", "https://ark.test", async (_url, init) => {
    names.push(((init!.body as FormData).get("file") as File).name);
    return Response.json({ id: "file", filename: names.at(-1) });
  });
  await client.uploadFile("原文.pdf", "application/pdf", new Uint8Array([1]), { uploadName });
  await client.uploadFile("原文.pdf", "application/pdf", new Uint8Array([1]));
  assert.deepEqual(names, [uploadName, "原文.pdf"]);
});

test("upload inspection confirms a unique operation only after all pages and detail validation", async () => {
  const q = query(), file = remoteFile(q), requests: string[] = [];
  const client = new ArkClient("secret", "https://ark.test", async (url, init) => {
    assert.equal(init?.method || "GET", "GET"); requests.push(String(url));
    if (requests.length === 1) return Response.json(page([{ ...file, id: "unrelated", filename: "other.pdf" }], true));
    if (requests.length === 2) return Response.json(page([file]));
    return Response.json(file);
  });
  const proof = await client.inspectFileUpload(q);
  assert.equal(proof.status, "confirmed");
  assert.deepEqual(proof.status === "confirmed" && { ...proof, checkedAt: 0 }, { status: "confirmed", ...q, fileId: "file-confirmed", checkedAt: 0 });
  assert.match(requests[0], /\/files\?purpose=user_data&limit=100&order=desc$/);
  assert.match(requests[1], /&after=unrelated$/);
  assert.equal(requests[2], "https://ark.test/files/file-confirmed");
});

for (const [name, patch] of Object.entries({ differentName: { filename: "original.pdf" }, wrongBytes: { bytes: 4 }, wrongPurpose: { purpose: "agent" },
  processing: { status: "processing" }, expired: { expire_at: 1 }, ancient: { created_at: 1 }, future: { created_at: 9999999999 }, missingId: { id: "" }
})) test(`upload inspection does not adopt ${name}`, async () => {
  const q = query();
  const client = new ArkClient("secret", "https://ark.test", async url => Response.json(String(url).includes("?") ? page([{ ...remoteFile(q), ...patch }]) : { ...remoteFile(q), ...patch }));
  assert.equal((await client.inspectFileUpload(q)).status, "unknown");
});

test("duplicate operation names and a changed detail response remain unknown", async () => {
  const q = query(), file = remoteFile(q);
  const duplicate = new ArkClient("secret", "https://ark.test", async () => Response.json(page([file, { ...file, id: "file-other" }])));
  assert.equal((await duplicate.inspectFileUpload(q)).status, "unknown");
  let calls = 0;
  const changed = new ArkClient("secret", "https://ark.test", async () => Response.json(++calls === 1 ? page([file]) : { ...file, status: "error" }));
  assert.equal((await changed.inspectFileUpload(q)).status, "unknown");
});

const message = (id: string): IncomingMessage => ({ channelType: "lark", installationId: "app", tenantId: "tenant", conversationId: "chat", conversationType: "group",
  senderId: "user", eventId: id, messageId: id, threadId: "", rootMessageId: "", parentMessageId: "", createTime: 100, text: "分析原文", resources: [], mentionedBot: true });
const history = [{ messageId: "source", senderId: "user", senderType: "user", source: "chat", text: "文件", createTime: 50,
  resources: [{ id: "source-file", name: "原文.pdf", type: "file" }] }];

test("Gateway process exit after remote upload recovers the original File ID without another download or POST", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ark-upload-crash-")), path = join(directory, "gateway.db"), remotePath = join(directory, "remote.json");
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { writeFileSync } from 'node:fs';
    import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    import { Gateway } from ${JSON.stringify(new URL("../src/gateway.ts", import.meta.url).href)};
    const store = new GatewayStore(${JSON.stringify(path)});
    new Gateway(store, {
      createSession: async () => 'session',
      uploadFile: async (name, mime, bytes, options) => {
        writeFileSync(${JSON.stringify(remotePath)}, JSON.stringify({ name, bytes: bytes.byteLength, uploadName: options?.uploadName })); process.exit(79);
      }, run: async () => { throw new Error('must not run'); }
    }, async () => {}, {
      agentId: 'agent', environmentId: 'env', vaultId: 'vault', timeoutMs: 5000, platformAccess: true, sharedGroupSessions: true,
      downloadAttachment: async () => ({ bytes: new Uint8Array([1,2,3]), mimeType: 'application/pdf' }), loadRecentHistory: async () => ${JSON.stringify(history)}
    }).accept(${JSON.stringify(message("first"))});
  `], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 79, child.stderr);
  const uploaded = JSON.parse(readFileSync(remotePath, "utf8"));
  assert.match(uploaded.uploadName, /^arkagent-[a-f0-9-]{36}\.pdf$/);
  assert.equal(uploaded.name, "原文.pdf");
  const store = new GatewayStore(path), receipts = store.attachmentTrace.list(message("source")).items;
  const original = receipts.find(r => r.stage === "upload")!;
  assert.equal(original.status, "pending"); assert.equal(original.uploadName, uploaded.uploadName);
  const q = { uploadName: uploaded.uploadName, bytes: uploaded.bytes, startedAt: original.startedAt }, file = remoteFile(q);
  let gets = 0, mounts = 0, runs = 0;
  const client = new ArkClient("secret", "https://ark.test", async url => { gets++; return Response.json(String(url).includes("?") ? page([file]) : file); });
  const replies: string[] = [];
  const gateway = new Gateway(store, {
    createSession: async () => { assert.fail("不能重建Session"); }, uploadFile: async () => { assert.fail("不能重复上传"); },
    inspectFileUpload: client.inspectFileUpload.bind(client),
    addSessionResource: async (_session, resource) => { mounts++; assert.equal(resource.file_id, "file-confirmed"); assert.match(String(resource.mount_path), /原文\.pdf$/); },
    run: async (_session, input) => { runs++; assert.match(input, /原文.pdf/); assert.doesNotMatch(input, /arkagent-[a-f0-9-]{36}/); return { terminal: "idle", messages: ["完成"] }; }
  }, async (_source, output) => { if (output.type === "text") replies.push(output.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, platformAccess: true, sharedGroupSessions: true,
    downloadAttachment: async () => { assert.fail("不能重新下载"); }, loadRecentHistory: async () => history as any
  });
  gateway.accept(message("after"));
  for (let i = 0; i < 200 && !replies.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(replies.length, 1); assert.equal(gets, 2); assert.equal(mounts, 1); assert.equal(runs, 1);
  assert.equal(store.getAttachment(original.attachmentKey)?.fileId, "file-confirmed");
  const updated = store.attachmentTrace.list(message("source")).items;
  assert.equal(updated.filter(r => r.stage === "upload").length, 1);
  assert.equal(updated.find(r => r.stage === "upload")?.status, "pending");
  assert.equal(updated.find(r => r.stage === "upload_check")?.status, "succeeded");
  store.close();
});

for (const fault of ["missing-more", "repeated-cursor", "empty-more", "bad-last", "too-many-rows", "second-page-error", "over-limit"])
test(`upload scan rejects incomplete pagination: ${fault}`, async () => {
  const q = query(), file = remoteFile(q); let calls = 0;
  const client = new ArkClient("secret", "https://ark.test", async () => {
    calls++;
    if (fault === "missing-more") return Response.json({ data: [file] });
    if (fault === "empty-more") return Response.json(page([], true));
    if (fault === "bad-last") return Response.json({ ...page([file], true), last_id: "other" });
    if (fault === "too-many-rows") return Response.json(page(Array.from({ length: 101 }, (_, i) => ({ ...file, id: `file-${i}` }))));
    if (fault === "second-page-error" && calls > 1) return new Response("PRIVATE TOKEN", { status: 503 });
    if (fault === "over-limit") return Response.json(page([{ ...file, id: `file-${calls}`, filename: "other.pdf" }], true));
    return Response.json(page([file], true));
  });
  const result = await client.inspectFileUpload(q);
  assert.equal(result.status, "unknown"); assert.ok(calls <= 20);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("upload scan timeout cancels the body and caller abort does not send a request", async () => {
  let cancelled = false, calls = 0;
  const client = new ArkClient("secret", "https://ark.test", async () => { calls++; return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')); }, cancel() { cancelled = true; }
  })); }, { inspectionTimeoutMs: 20 });
  assert.equal((await client.inspectFileUpload(query(), AbortSignal.abort())).status, "unknown");
  assert.equal(calls, 0);
  const keepAlive = setInterval(() => {}, 10);
  try { assert.equal((await client.inspectFileUpload(query())).status, "unknown"); }
  finally { clearInterval(keepAlive); }
  assert.equal(cancelled, true); assert.equal(calls, 1);
});

test("upload scan enforces a total response-byte budget", async () => {
  const q = query(); let calls = 0;
  const client = new ArkClient("secret", "https://ark.test", async () => {
    calls++;
    return Response.json({ ...page([{ ...remoteFile(q), id: `other-${calls}`, filename: "other.pdf" }], true), padding: "x".repeat(3 * 1024 * 1024) });
  });
  assert.equal((await client.inspectFileUpload(q)).status, "unknown"); assert.equal(calls, 2);
});

test("upload intent excludes simultaneous claims and shares only the same source across Thread contexts", () => {
  const db = new DatabaseSync(":memory:"), traces = new AttachmentTraceStore(db), source = message("source"), key = "a".repeat(64);
  const intent = traces.beginUpload(source, key, "原文.pdf", { bytes: 3, sha256: "b".repeat(64) });
  assert.throws(() => traces.beginUpload(source, key, "原文.pdf", { bytes: 3, sha256: "b".repeat(64) }), /待核实/);
  assert.throws(() => traces.beginUpload({ ...source, threadId: "thread" }, key, "原文.pdf", { bytes: 3, sha256: "b".repeat(64) }), /待核实/);
  assert.equal(traces.latestUpload({ ...source, threadId: "thread" }, key)?.id, intent.id);
  for (const patch of [{ channelType: "other" }, { installationId: "other" }, { tenantId: "other" }, { conversationId: "other" }, { messageId: "other" }]) {
    assert.equal(traces.latestUpload({ ...source, ...patch }, key), undefined);
  }
  db.close();
});

test("upload confirmation preserves the source byte hash and is fresh, CAS-bound and atomic", () => {
  const db = new DatabaseSync(":memory:"), traces = new AttachmentTraceStore(db), source = message("source"), key = "a".repeat(64);
  const intent = traces.beginUpload(source, key, "原文.pdf", { bytes: 3, sha256: "b".repeat(64) });
  const checkedAfter = Date.now(), proof = { status: "confirmed" as const, uploadName: intent.uploadName!, bytes: 3, startedAt: intent.startedAt, fileId: "file", checkedAt: Date.now() };
  for (const patch of [{ uploadName }, { bytes: 4 }, { startedAt: intent.startedAt - 1 }, { checkedAt: checkedAfter - 1 }, { checkedAt: Date.now() + 60_000 }]) {
    assert.throws(() => traces.confirmUpload(source, key, intent.id, { ...proof, ...patch }, checkedAfter));
  }
  assert.throws(() => traces.confirmUpload({ ...source, installationId: "other" }, key, intent.id, proof, checkedAfter));
  db.exec("CREATE TRIGGER fail_proof BEFORE UPDATE ON attachment_stage_receipts WHEN NEW.stage='upload_check' BEGIN SELECT RAISE(ABORT, 'disk'); END;");
  assert.throws(() => traces.confirmUpload(source, key, intent.id, proof, checkedAfter), /disk/);
  assert.equal(traces.list(source).items.length, 1);
  db.exec("DROP TRIGGER fail_proof");
  traces.confirmUpload(source, key, intent.id, proof, checkedAfter);
  assert.equal(traces.confirmedUpload(source, key)?.sha256, "b".repeat(64));
  assert.equal(traces.confirmedUpload(source, key)?.fileId, "file");
  assert.throws(() => traces.confirmUpload(source, key, intent.id, proof, checkedAfter), /变化/);
  assert.equal(traces.list(source).items[0].status, "pending");
  db.close();
});

for (const legacy of [true, false]) test(`unknown ${legacy ? "legacy" : "new"} upload does not redownload or POST again`, async () => {
  const store = new GatewayStore(":memory:"), source = message("source"), replies: string[] = []; let downloads = 0, uploads = 0, gets = 0;
  const gateway = new Gateway(store, {
    createSession: async () => "session", uploadFile: async () => { uploads++; throw new Error("response lost"); },
    inspectFileUpload: async () => { gets++; return { status: "unknown", reason: "not_found" }; },
    run: async (_session, input) => { assert.doesNotMatch(input, /已挂载到/); return { terminal: "idle", messages: ["尚未分析"] }; }
  }, async (_source, output) => { if (output.type === "text") replies.push(output.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, platformAccess: true, sharedGroupSessions: true,
    downloadAttachment: async () => { downloads++; return { bytes: new Uint8Array([1,2,3]), mimeType: "application/pdf" }; }, loadRecentHistory: async () => history as any
  });
  const send = async (id: string) => { const count = replies.length; gateway.accept(message(id));
    for (let i = 0; i < 200 && replies.length === count; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(replies.length, count + 1); };
  await send("first");
  if (legacy) {
    const previous = store.attachmentTrace.latestUpload(source, store.attachmentTrace.list(source).items[0].attachmentKey)!;
    (store as any).db.prepare("UPDATE attachment_stage_receipts SET details=json_remove(details, '$.uploadName') WHERE id=?").run(previous.id);
  }
  await send("second");
  assert.equal(downloads, 1); assert.equal(uploads, 1); assert.equal(gets, legacy ? 0 : 1);
  assert.match(replies[1], /上传结果待核实/);
  store.close();
});

test("confirmed upload lookup survives cache save failure without another remote scan", async () => {
  const store = new GatewayStore(":memory:"), replies: string[] = [];
  let uploads = 0, downloads = 0, gets = 0, mounts = 0, failedCache = false;
  const save = store.saveAttachment.bind(store);
  store.saveAttachment = (...args) => { if (!failedCache) { failedCache = true; throw new Error("disk"); } return save(...args); };
  const gateway = new Gateway(store, {
    createSession: async () => "session",
    uploadFile: async () => { uploads++; throw new Error("response lost"); },
    inspectFileUpload: async q => { gets++; return { status: "confirmed", ...q, fileId: "file-confirmed", checkedAt: Date.now() }; },
    addSessionResource: async (_session, resource) => { mounts++; assert.equal(resource.file_id, "file-confirmed"); },
    run: async () => ({ terminal: "idle", messages: ["完成"] })
  }, async (_source, output) => { if (output.type === "text") replies.push(output.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, platformAccess: true, sharedGroupSessions: true,
    downloadAttachment: async () => { downloads++; return { bytes: new Uint8Array([1,2,3]), mimeType: "application/pdf" }; }, loadRecentHistory: async () => history as any
  });
  for (let count = 0; count < 3; count++) {
    gateway.accept(message(`turn-${count}`));
    for (let i = 0; i < 200 && replies.length <= count; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(replies.length, count + 1);
  }
  assert.equal(uploads, 1); assert.equal(downloads, 1); assert.equal(gets, 1); assert.equal(mounts, 1);
  store.close();
});

test("explicit upload rejection permits a new attempt with a new operation name", async () => {
  const store = new GatewayStore(":memory:"), replies: string[] = [], names: string[] = [];
  let uploads = 0, mounts = 0;
  const gateway = new Gateway(store, {
    createSession: async () => "session",
    uploadFile: async (name, _type, _bytes, options) => {
      names.push(options!.uploadName);
      if (++uploads === 1) throw new ArkHttpError("rejected", 400, "InvalidParameter");
      return { id: "file", name };
    }, addSessionResource: async () => { mounts++; }, run: async () => ({ terminal: "idle", messages: ["完成"] })
  }, async (_source, output) => { if (output.type === "text") replies.push(output.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, platformAccess: true, sharedGroupSessions: true,
    downloadAttachment: async () => ({ bytes: new Uint8Array([1,2,3]), mimeType: "application/pdf" }), loadRecentHistory: async () => history as any
  });
  for (let count = 0; count < 2; count++) {
    gateway.accept(message(`turn-${count}`));
    for (let i = 0; i < 200 && replies.length <= count; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(replies.length, count + 1);
  }
  assert.equal(uploads, 2); assert.equal(mounts, 1); assert.notEqual(names[0], names[1]);
  store.close();
});

test("late upload proof cannot replace a successful response with a different File ID", () => {
  const db = new DatabaseSync(":memory:"), traces = new AttachmentTraceStore(db), source = message("source"), key = "a".repeat(64);
  const intent = traces.beginUpload(source, key, "原文.pdf", { bytes: 3, sha256: "b".repeat(64) });
  const checkedAfter = Date.now();
  traces.finish(intent.id, "succeeded", { fileId: "file-response" });
  assert.throws(() => traces.confirmUpload(source, key, intent.id, { status: "confirmed", uploadName: intent.uploadName!, bytes: 3,
    startedAt: intent.startedAt, fileId: "different-file", checkedAt: Date.now() }, checkedAfter), /变化/);
  assert.equal(traces.confirmedUpload(source, key)?.fileId, "file-response");
  db.close();
});

test("legacy names and invalid upload queries never initiate account file scans", async () => {
  let calls = 0;
  const client = new ArkClient("secret", "https://ark.test", async () => { calls++; return Response.json(page([])); });
  for (const patch of [{ uploadName: "原文.pdf" }, { uploadName: "../secret" }, { bytes: -1 }, { bytes: NaN }, { startedAt: 0 }, { startedAt: Date.now() + 60_000 }]) {
    assert.equal((await client.inspectFileUpload({ ...query(), ...patch })).status, "unknown");
  }
  assert.equal(calls, 0);
});

test("generic HTTP400 upload response does not become a definite rejection", async () => {
  const store = new GatewayStore(":memory:"), replies: string[] = []; let uploads = 0;
  const gateway = new Gateway(store, {
    createSession: async () => "session", uploadFile: async () => { uploads++; throw new ArkHttpError("unknown rejection", 400); },
    run: async () => ({ terminal: "idle", messages: ["尚未分析"] })
  }, async (_source, output) => { if (output.type === "text") replies.push(output.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, platformAccess: true, sharedGroupSessions: true,
    downloadAttachment: async () => ({ bytes: new Uint8Array([1,2,3]), mimeType: "application/pdf" }), loadRecentHistory: async () => history as any
  });
  for (let count = 0; count < 2; count++) {
    gateway.accept(message(`turn-${count}`));
    for (let i = 0; i < 200 && replies.length <= count; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(replies.length, count + 1);
  }
  assert.equal(uploads, 1); assert.match(replies[1], /上传结果待核实/);
  store.close();
});
