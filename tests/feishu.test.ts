import test from "node:test";
import assert from "node:assert/strict";
import { createFeishuResourceDownloader, normalizeFeishuMessage } from "../src/feishu.ts";

test("normalizeFeishuMessage extracts text and removes mention tokens", () => {
  const result = normalizeFeishuMessage({
    event_id: "evt-1",
    tenant_key: "tenant-1",
    sender: { sender_id: { open_id: "ou-user" } },
    message: {
      message_id: "om-1", chat_id: "oc-1", chat_type: "group", message_type: "text",
      content: JSON.stringify({ text: "@_user_1 帮我总结" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou-bot" } }]
    }
  });
  assert.equal(result?.text, "帮我总结");
  assert.equal(result?.mentionedBot, true);
});

test("normalizeFeishuMessage extracts file resources", () => {
  const result = normalizeFeishuMessage({
    event_id: "evt-file",
    sender: { sender_id: { open_id: "ou-user" } },
    message: {
      message_id: "om-file", chat_id: "oc-1", chat_type: "p2p", message_type: "file",
      content: JSON.stringify({ file_key: "file-v3", file_name: "季度计划.pdf" })
    }
  });
  assert.equal(result?.text, "");
  assert.deepEqual(result?.attachments, [{ key: "file-v3", name: "季度计划.pdf", type: "file" }]);
});

test("normalizeFeishuMessage extracts image resources and ignores unsupported messages", () => {
  const image = normalizeFeishuMessage({
    message: {
      message_id: "om-image", chat_id: "oc-1", chat_type: "p2p", message_type: "image",
      content: JSON.stringify({ image_key: "img-v3" })
    }
  });
  assert.deepEqual(image?.attachments, [{ key: "img-v3", name: "img-v3.jpg", type: "image" }]);
  assert.equal(normalizeFeishuMessage({ message: { message_id: "om-1", chat_id: "oc-1", chat_type: "p2p", message_type: "sticker" } }), undefined);
});

test("normalizeFeishuMessage combines text and images from a rich post", () => {
  const result = normalizeFeishuMessage({
    message: {
      message_id: "om-post", chat_id: "oc-1", chat_type: "p2p", message_type: "post",
      content: JSON.stringify({
        title: "现场反馈",
        content: [
          [{ tag: "text", text: "请分析这张截图" }, { tag: "a", text: "参考链接", href: "https://example.com" }],
          [{ tag: "img", image_key: "img-v3-first" }],
          [{ tag: "text", text: "并给出修复建议" }, { tag: "img", image_key: "img-v3-second" }]
        ]
      })
    }
  });
  assert.equal(result?.text, "现场反馈\n请分析这张截图 参考链接\n并给出修复建议");
  assert.deepEqual(result?.attachments, [
    { key: "img-v3-first", name: "img-v3-first.jpg", type: "image" },
    { key: "img-v3-second", name: "img-v3-second.jpg", type: "image" }
  ]);
});

test("normalizeFeishuMessage supports localized rich post payloads", () => {
  const result = normalizeFeishuMessage({
    message: {
      message_id: "om-post-localized", chat_id: "oc-1", chat_type: "p2p", message_type: "post",
      content: JSON.stringify({ zh_cn: { title: "中文标题", content: [[{ tag: "text", text: "正文" }, { tag: "img", image_key: "img-cn" }]] } })
    }
  });
  assert.equal(result?.text, "中文标题\n正文");
  assert.deepEqual(result?.attachments, [{ key: "img-cn", name: "img-cn.jpg", type: "image" }]);
});

test("resource downloader enforces the byte limit while streaming", async () => {
  const client = {
    im: { messageResource: { get: async () => ({
      headers: { "content-type": "application/pdf" },
      async *getReadableStream() { yield new Uint8Array([1, 2]); yield new Uint8Array([3, 4]); }
    }) } }
  };
  const attachment = { key: "file-v3", name: "report.pdf", type: "file" as const };
  const message = normalizeFeishuMessage({
    message: { message_id: "om-1", chat_id: "oc-1", chat_type: "p2p", message_type: "file", content: JSON.stringify({ file_key: attachment.key, file_name: attachment.name }) }
  })!;
  const result = await createFeishuResourceDownloader(client, 4)(attachment, message);
  assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
  assert.equal(result.mimeType, "application/pdf");
  await assert.rejects(() => createFeishuResourceDownloader(client, 3)(attachment, message), /超过.*限制/);
});
