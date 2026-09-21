import test from "node:test";
import assert from "node:assert/strict";
import { inspectLarkReaction } from "../src/lark-reactions.ts";
import type { ChannelMessage } from "../src/channel.ts";

const message: ChannelMessage = { channelType: "lark", installationId: "cli", tenantId: "tenant", senderId: "user", conversationId: "chat",
  conversationType: "group", threadId: "", rootMessageId: "", parentMessageId: "", messageId: "om-1", eventId: "event", createTime: 1,
  text: "hi", resources: [], mentionedBot: true };
const item = (id = "rid", app = "cli", kind = "app") => ({ reaction_id: id, operator: { operator_id: app, operator_type: kind },
  reaction_type: { emoji_type: "Get" }, action_time: "100001" });
const page = (items: unknown[], has_more = false, page_token = "") => ({ code: 0, data: { items, has_more, page_token } });
const client = (list: (p: any) => Promise<any>) => ({ im: { v1: { messageReaction: { list } } } });
const query = { emoji: "Get" as const, reactionId: "rid" };

test("reaction inspection traverses pages and matches both app ID and emoji", async () => {
  const calls: any[] = [];
  const result = await inspectLarkReaction(client(async p => { calls.push(p); return calls.length === 1
    ? page([item("other", "other-app"), item("human", "user", "user")], true, "next") : page([item()]); }), "cli", message, query, new AbortController().signal);
  assert.deepEqual(result, { status: "present", reactionId: "rid" });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { path: { message_id: "om-1" }, params: { reaction_type: "Get", page_size: 50, user_id_type: "open_id", page_token: "next" } });
});

test("unknown creation only adopts one matching app reaction within its creation window", async () => {
  const c = client(async () => page([item("other", "other-app"), item()]));
  assert.deepEqual(await inspectLarkReaction(c, "cli", message, { emoji: "Get", createdAt: 100000 }, new AbortController().signal), { status: "present", reactionId: "rid" });
  for (const createdAt of [undefined, 100002, 1]) {
    assert.equal((await inspectLarkReaction(c, "cli", message, { emoji: "Get", createdAt }, new AbortController().signal)).status, "unknown");
  }
});

test("absence requires a complete valid response, never another app's reaction", async () => {
  assert.deepEqual(await inspectLarkReaction(client(async () => page([item("other", "other-app")])), "cli", message, query, new AbortController().signal), { status: "absent" });
  assert.equal((await inspectLarkReaction(client(async () => page([item("rid", "other-app")])), "cli", message, query, new AbortController().signal)).status, "unknown");
});

for (const [name, response] of [
  ["business error", { code: 230001, msg: "private-error", data: { items: [], has_more: false } }],
  ["missing fields", { code: 0, data: { items: [] } }],
  ["missing cursor", page([], true)],
  ["malformed identity", page([{ ...item(), operator: {} }])],
  ["wrong emoji", page([{ ...item(), reaction_type: { emoji_type: "OnIt" } }])],
  ["conflicting duplicate", page([item(), { ...item(), operator: { operator_type: "user", operator_id: "user" } }])],
  ["ambiguous same app", page([item(), item("second")])]
] as const) {
  test(`reaction inspection remains unknown for ${name}`, async () => {
    const result = await inspectLarkReaction(client(async () => response), "cli", message, { emoji: "Get", createdAt: 100000 }, new AbortController().signal);
    assert.equal(result.status, "unknown"); assert.equal(JSON.stringify(result).includes("private-error"), false);
  });
}

test("reaction inspection bounds pagination, handles loops, and rejects wrong installations before I/O", async () => {
  let calls = 0;
  const c = client(async () => { calls++; return page([], true, `cursor-${calls}`); });
  assert.equal((await inspectLarkReaction(c, "other-app", message, query, new AbortController().signal)).status, "unknown");
  assert.equal(calls, 0);
  assert.equal((await inspectLarkReaction(c, "cli", message, query, new AbortController().signal)).status, "unknown");
  assert.equal(calls, 20);
  calls = 0;
  assert.equal((await inspectLarkReaction(client(async () => { calls++; return page([], true, "same"); }), "cli", message, query, new AbortController().signal)).status, "unknown");
  assert.equal(calls, 2);
});

test("reaction inspection abort returns without waiting for a stuck SDK promise", async () => {
  const abort = new AbortController();
  const result = inspectLarkReaction(client(() => new Promise(() => {})), "cli", message, query, abort.signal);
  abort.abort(); assert.equal((await result).status, "unknown");
});
