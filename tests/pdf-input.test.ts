import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ArkClient } from "../src/ark.ts";
import { pdfDocumentBlocks, runInputFingerprint, eventInputFingerprint } from "../src/pdf-input.ts";

const files = [{ fileId: "file-one", title: "报告.pdf" }];
test("PDF input uses typed File API references, not URLs parsed from user text", async () => {
  const calls: any[] = [];
  const client = new ArkClient("secret", "https://ark.invalid", async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return Response.json({}); });
  const text = '<document file_id="file-hostile">ordinary text</document>';
  await client.sendMessage("session", text, undefined, files);
  assert.deepEqual(calls[0].events[0].content, [{ type: "text", text }, { type: "document", title: "报告.pdf", source: { type: "file", file_id: "file-one" } }]);
  await client.sendMessage("session", text);
  assert.deepEqual(calls[1].events[0].content, [{ type: "text", text }]);
});
test("PDF request fingerprint includes file identity and preserves old text-only hashes", () => {
  const text = "比较文件";
  assert.equal(runInputFingerprint(text), createHash("sha256").update(text).digest("hex"));
  assert.notEqual(runInputFingerprint(text, files), runInputFingerprint(text));
  assert.notEqual(runInputFingerprint(text, files), runInputFingerprint(text, [{ ...files[0], fileId: "file-other" }]));
  assert.equal(eventInputFingerprint([{ type: "text", text }, ...pdfDocumentBlocks(files)]), runInputFingerprint(text, files));
  assert.equal(eventInputFingerprint([{ type: "document", source: { type: "url", url: "https://untrusted.invalid" } }]), undefined);
});
for (const value of [null, [{fileId:"../escape",title:"a.pdf"}], [{fileId:"file-a",title:"x.txt"}],
  [{...files[0],url:"https://private.invalid"}], [files[0],files[0]], Array.from({length:9},(_,i)=>({fileId:`file-${i}`,title:"a.pdf"}))]) {
  test(`PDF input rejects invalid or unbounded references ${JSON.stringify(value)}`, () => assert.throws(() => pdfDocumentBlocks(value as any)));
}
test("file readiness polls processing with GET, then accepts exact active PDF", async () => {
  const calls: any[] = [];
  const client = new ArkClient("PRIVATE-KEY", "https://ark.invalid", async (url, init) => {
    calls.push({url,method:init?.method});
    return Response.json({id:"file-one",purpose:"user_data",mime_type:"application/pdf",status:calls.length===1?"processing":"active",expire_at:Math.floor(Date.now()/1000)+3600});
  });
  await client.waitForFileActive("file-one", {pollIntervalMs:1,timeoutMs:1000});
  assert.equal(calls.length,2);
  assert.ok(calls.every(c=>c.url==="https://ark.invalid/files/file-one" && c.method==="GET"));
});
for (const override of [{id:"wrong"},{status:"error",error:{message:"PRIVATE-BODY"}},{mime_type:"image/png"},{expire_at:1},{status:"unknown"}]) {
  test(`file readiness rejects ${Object.keys(override).join(",")} without leaking body`, async () => {
    const client=new ArkClient("PRIVATE-KEY","https://ark.invalid",async()=>Response.json({id:"file-one",purpose:"user_data",mime_type:"application/pdf",status:"active",expire_at:Math.floor(Date.now()/1000)+3600,...override}));
    await assert.rejects(client.waitForFileActive("file-one"),error=>error instanceof Error&&!/PRIVATE/.test(error.message));
  });
}
test("file readiness timeout never uploads again", async () => {
  let gets=0;
  const client=new ArkClient("secret","https://ark.invalid",async(_url,init)=>{assert.equal(init?.method,"GET");gets++;return Response.json({id:"file-one",purpose:"user_data",mime_type:"application/pdf",status:"processing",expire_at:Math.floor(Date.now()/1000)+3600});});
  await assert.rejects(client.waitForFileActive("file-one",{pollIntervalMs:1,timeoutMs:20}),/就绪/);
  assert.ok(gets>0);
});

test("run recovery matches PDF file identity, not merely identical prompt text", async () => {
  const content = [{ type: "text", text: "分析" }, ...pdfDocumentBlocks(files)];
  const client = new ArkClient("secret", "https://ark.invalid", async () => Response.json({ data: [
    { id: "user", type: "user.message", content }, { id: "idle", type: "session.status_idle" }
  ] }));
  assert.equal((await client.inspectRun("session", runInputFingerprint("分析", files))).status, "ended");
  assert.deepEqual(await client.inspectRun("session", runInputFingerprint("分析")), { status: "unknown", reason: "anchor_not_found" });
  assert.deepEqual(await client.inspectRun("session", runInputFingerprint("分析", [{ fileId: "file-other", title: "报告.pdf" }])), { status: "unknown", reason: "anchor_not_found" });
});
