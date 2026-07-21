import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFeishuMessage } from "../src/feishu.ts";

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

test("normalizeFeishuMessage ignores non-text messages", () => {
  assert.equal(normalizeFeishuMessage({ message: { message_id: "om-1", chat_id: "oc-1", chat_type: "p2p", message_type: "image" } }), undefined);
});
