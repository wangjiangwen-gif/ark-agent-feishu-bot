import test from "node:test";
import assert from "node:assert/strict";
import { inspectLarkReply } from "../src/lark-reply-inspection.ts";
import { replyContentFingerprint } from "../src/reply-delivery.ts";
import type { ChannelMessage } from "../src/channel.ts";

const message: ChannelMessage = { channelType: "lark", installationId: "cli", tenantId: "tenant", senderId: "user",
  conversationId: "chat", conversationType: "group", threadId: "", rootMessageId: "", parentMessageId: "", messageId: "trigger",
  eventId: "event", createTime: 1, text: "question", resources: [], mentionedBot: true };
const query = { mode: "native_card" as const, messageId: "reply", elementId: "body", contentFingerprint: replyContentFingerprint("final") };
const card = () => ({ schema: "2.0", config: { streaming_mode: false }, body: { elements: [{ tag: "markdown", element_id: "body", content: "final" }] } });
const item = () => ({ message_id: "reply", chat_id: "chat", msg_type: "interactive", deleted: false,
  sender: { id: "cli", id_type: "app_id", sender_type: "app", tenant_key: "tenant" }, body: { content: JSON.stringify(card()) } });
async function inspect(value: unknown, current = message, signal = new AbortController().signal) {
  return inspectLarkReply({ im: { message: { get: async () => value } } }, "cli", current, query, signal);
}
test("reads original final card using exact message ID and returns only its fingerprint", async () => {
  const requests: unknown[] = [], before = Date.now();
  const result = await inspectLarkReply({ im: { message: { get: async payload => {
    requests.push(payload); return { code: 0, data: { items: [item()] } };
  } } } }, "cli", message, query, new AbortController().signal);
  assert.deepEqual(requests, [{ path: { message_id: "reply" }, params: { user_id_type: "open_id", card_msg_content_type: "user_card_content" } }]);
  assert.equal(result.status, "confirmed");
  if (result.status === "confirmed") { assert.ok(result.observedAt >= before); assert.equal(result.contentFingerprint, query.contentFingerprint); }
  assert.equal(JSON.stringify(result).includes('"final"'), false);
});
for (const field of ["message_id", "chat_id", "deleted", "msg_type", "sender.id", "sender.id_type", "sender.sender_type", "sender.tenant_key"])
  test(`does not trust a matching body with wrong ${field}`, async () => {
    const value: any = item(), parts = field.split(".");
    if (parts.length === 2) value[parts[0]][parts[1]] = "other";
    else value[field] = field === "deleted" ? true : "other";
    assert.notEqual((await inspect({ code: 0, data: { items: [value] } })).status, "confirmed");
  });
test("thread matching is exact and absence only matches a non-thread reply", async () => {
  const value = { ...item(), thread_id: "thread" };
  assert.equal((await inspect({ code: 0, data: { items: [value] } }, { ...message, threadId: "thread" })).status, "confirmed");
  assert.notEqual((await inspect({ code: 0, data: { items: [value] } })).status, "confirmed");
  assert.notEqual((await inspect({ code: 0, data: { items: [item()] } }, { ...message, threadId: "thread" })).status, "confirmed");
});
for (const fault of ["streaming", "no-settings", "placeholder", "wrong-element", "duplicate-elements", "flattened", "invalid-json", "oversized"]) {
  test(`cannot confirm ${fault} card`, async () => {
    const content: any = card();
    if (fault === "streaming") content.config.streaming_mode = true;
    if (fault === "no-settings") delete content.config.streaming_mode;
    if (fault === "placeholder") content.body.elements[0].content = "Thinking...";
    if (fault === "wrong-element") content.body.elements[0].element_id = "other";
    if (fault === "duplicate-elements") content.body.elements.push({ ...content.body.elements[0] });
    const encoded = fault === "flattened" ? JSON.stringify({ elements: content.body.elements })
      : fault === "invalid-json" ? "{" : fault === "oversized" ? "x".repeat(1024 * 1024 + 1) : JSON.stringify(content);
    assert.notEqual((await inspect({ code: 0, data: { items: [{ ...item(), body: { content: encoded } }] } })).status, "confirmed");
  });
}
test("missing business code, errors, empty or multiple results are not delivery proof", async () => {
  for (const value of [undefined, { data: { items: [item()] } }, { code: 230027 }, { code: 0, data: { items: [] } },
    { code: 0, data: { items: [item(), item()] } }]) assert.notEqual((await inspect(value)).status, "confirmed");
});
test("abort bounds waiting and discards late success", async () => {
  const controller = new AbortController(); let resolve!: (value: unknown) => void;
  const pending = inspectLarkReply({ im: { message: { get: () => new Promise(r => { resolve = r; }) } } }, "cli", message, query, controller.signal);
  controller.abort(); assert.notEqual((await pending).status, "confirmed");
  resolve({ code: 0, data: { items: [item()] } });
});
test("invalid scope, query and pre-aborted input do not make HTTP calls", async () => {
  let calls = 0; const client = { im: { message: { get: async () => { calls++; throw new Error("secret"); } } } };
  for (const current of [{ ...message, installationId: "other" }, { ...message, tenantId: "" }, { ...message, channelType: "other" }])
    assert.notEqual((await inspectLarkReply(client, "cli", current, query, new AbortController().signal)).status, "confirmed");
  await inspectLarkReply(client, "cli", message, { ...query, contentFingerprint: "invalid" }, new AbortController().signal);
  await inspectLarkReply(client, "cli", message, query, AbortSignal.abort());
  assert.equal(calls, 0);
  const failed = await inspectLarkReply(client, "cli", message, query, new AbortController().signal);
  assert.equal(JSON.stringify(failed).includes("secret"), false);
});
