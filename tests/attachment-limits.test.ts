import test from "node:test";
import assert from "node:assert/strict";
import { createFeishuResourceDownloader, MAX_FEISHU_FILE_BYTES, normalizeFeishuMessage } from "../src/feishu.ts";
import { attachmentSizeError, isAttachmentSizeMessage } from "../src/attachment-limits.ts";

const MiB = 1024 * 1024;
const attachment = { id: "file-test", name: "large.pdf", type: "file" as const };
const message = normalizeFeishuMessage({ message: { message_id: "om-test", chat_id: "oc-test", chat_type: "p2p", message_type: "file", content: JSON.stringify({ file_key: attachment.id, file_name: attachment.name }) } })!;
function client(bytes: number, declared: boolean, counters = { chunks: 0 }) {
  return { im: { messageResource: { get: async () => ({
    headers: { "content-type": "application/pdf", ...(declared ? { "content-length": String(bytes) } : {}) },
    async *getReadableStream() {
      const chunk = new Uint8Array(MiB);
      for (let offset = 0; offset < bytes; offset += MiB) { counters.chunks++; yield chunk.subarray(0, Math.min(MiB, bytes - offset)); }
    }
  }) } } };
}
test("default file cap is 100 MiB and exactly 100 MiB streams successfully", async () => {
  assert.equal(MAX_FEISHU_FILE_BYTES, 100 * MiB);
  const result = await createFeishuResourceDownloader(client(100 * MiB, false))(attachment, message);
  assert.equal(result.bytes.byteLength, 100 * MiB);
});
test("declared oversized file is rejected without reading its body and reports exact size", async () => {
  const count = { chunks: 0 };
  await assert.rejects(createFeishuResourceDownloader(client(100 * MiB + 1, true, count))(attachment, message), /104857601.*104857600.*单文件上限 100 MiB/);
  assert.equal(count.chunks, 0);
});
test("chunked oversized file stops at the limit without requiring content-length", async () => {
  const count = { chunks: 0 };
  await assert.rejects(createFeishuResourceDownloader(client(101 * MiB, false, count))(attachment, message), /至少.*超过.*100 MiB/);
  assert.equal(count.chunks, 101);
});
test("remaining turn budget is reported separately from the single file cap", async () => {
  await assert.rejects(createFeishuResourceDownloader(client(80 * MiB, true))(attachment, message, 50 * MiB), /单文件上限 100 MiB，本轮剩余 50 MiB/);
});
test("size diagnostics whitelist numbers and units, not arbitrary SDK payloads", () => {
  const text = attachmentSizeError(100 * MiB + 1, 100 * MiB, 200 * MiB).message;
  assert.equal(isAttachmentSizeMessage(text), true);
  assert.equal(isAttachmentSizeMessage(text + " SECRET_URL"), false);
});
