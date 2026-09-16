import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as flush } from "node:timers/promises";
import { advanceReplyDelivery, replyInspectionQuery, replyContentFingerprint as hash } from "../src/reply-delivery.ts";
import { inspectLarkReply } from "../src/lark-reply-inspection.ts";
import { GatewayStore } from "../src/store.ts";
import { Gateway, type GatewayOptions } from "../src/gateway.ts";
import { LarkChannelAdapter, type LarkChannelPort } from "../src/lark-channel.ts";
import type { ChannelMessage } from "../src/channel.ts";

const message: ChannelMessage = { channelType: "lark", installationId: "app", tenantId: "tenant", senderId: "user",
  conversationId: "chat", conversationType: "group", threadId: "", rootMessageId: "", parentMessageId: "", messageId: "trigger",
  eventId: "event", createTime: 1, text: "question", resources: [], mentionedBot: true };
const parts = ["PRIVATE-第一部分\n", "第二部分 😀  "];
const finalText = parts.join("");
const result = { terminal: "idle" as const, messages: [finalText] };
const query = () => ({ mode: "text_messages" as const, messageIds: ["reply-1", "reply-2"], contentFingerprint: hash(finalText) });
const row = (index: number) => ({ message_id: `reply-${index + 1}`, chat_id: "chat", msg_type: "text", deleted: false,
  sender: { id: "app", id_type: "app_id", sender_type: "app", tenant_key: "tenant" }, body: { content: JSON.stringify({ text: parts[index] }) } });
const options: GatewayOptions = { agentId: "agent", environmentId: "env", vaultId: "vault", appId: "app",
  platformAccess: true, sharedGroupSessions: true, durableQueue: true, timeoutMs: 1000, sessionCompaction: false };

function api(items: unknown[], calls: string[] = []) {
  return { im: { message: { get: async (input: any) => {
    calls.push(input.path.message_id);
    return { code: 0, data: { items: [items[Number(input.path.message_id.slice(-1)) - 1]] } };
  } } } };
}

async function until(check: () => boolean) {
  for (let n = 0; n < 200 && !check(); n++) { await flush(); await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.ok(check());
}

function inspectedTextFixture() {
  const dir = mkdtempSync(join(tmpdir(), "ark-text-proof-")), path = join(dir, "gateway.db");
  const store = new GatewayStore(path); store.acquireRuntimeLock();
  const binding = { scope: "scope", agentId: "agent", configFingerprint: "config" };
  const task = store.receiveMessage(message, binding)!;
  store.inbox.claim(task.id, binding); store.dispatchMessage(task.id, "session", hash("input"));
  store.inbox.planReply(task.id, result, finalText);
  for (const event of [{ type: "begin", mode: "message", textFingerprint: hash(finalText) },
    { type: "sending" }, { type: "sent", messageIds: query().messageIds }] as const) store.inbox.recordReplyDelivery(task.id, event);
  const uncertain = store.inbox.finish(task.id, "failed");
  const inspected = store.inbox.recordInspection(uncertain, { status: "ended", anchorEventId: "a", terminalEventId: "b", result });
  return { store, path, inspected, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const textProof = () => ({ status: "confirmed" as const, ...query(), observedAt: Date.now() });

test("text delivery records its intended body before send and creates a bounded exact query", () => {
  const begun = advanceReplyDelivery(undefined, { type: "begin", mode: "message", textFingerprint: hash(finalText) });
  const sending = advanceReplyDelivery(begun, { type: "sending" });
  const sent = advanceReplyDelivery(sending, { type: "sent", messageIds: ["reply-1", "reply-1", "reply-2"] });
  assert.deepEqual(replyInspectionQuery(sent, hash(finalText)), query());
  assert.equal(replyInspectionQuery(sending, hash(finalText)), undefined);
  assert.equal(replyInspectionQuery(sent, hash("different")), undefined);
  assert.equal(replyInspectionQuery({ ...sent, messageIds: Array.from({ length: 51 }, (_, n) => `id-${n}`) }, hash(finalText)), undefined);
  assert.throws(() => advanceReplyDelivery(undefined, { type: "begin", mode: "native_card", textFingerprint: hash(finalText) }), /正文/);
  assert.throws(() => advanceReplyDelivery(undefined, { type: "begin", mode: "message", textFingerprint: "bad" }), /正文/);
});

test("reads all saved text chunks in order without trimming, storing text or issuing writes", async () => {
  const calls: string[] = [];
  const proof = await inspectLarkReply(api([row(0), row(1)], calls), "app", message, query(), new AbortController().signal);
  assert.equal(proof.status, "confirmed");
  assert.equal(proof.mode, "text_messages");
  assert.deepEqual(proof.messageIds, query().messageIds);
  assert.equal(proof.contentFingerprint, hash(finalText));
  assert.deepEqual(calls, ["reply-1", "reply-2"]);
  assert.doesNotMatch(JSON.stringify(proof), /PRIVATE|第一部分|第二部分/);
});

for (const problem of ["missing", "deleted", "body", "sender", "tenant", "chat", "thread", "message_id", "post", "invalid-json", "oversized"]) {
  test(`a ${problem} text chunk prevents whole-reply confirmation`, async () => {
    const items: any[] = [row(0), row(1)];
    switch (problem) {
      case "missing": items[1] = undefined; break;
      case "deleted": items[1].deleted = true; break;
      case "body": items[1].body.content = JSON.stringify({ text: parts[1].trim() }); break;
      case "sender": items[1].sender.id = "other"; break;
      case "tenant": items[1].sender.tenant_key = "other"; break;
      case "chat": items[1].chat_id = "other"; break;
      case "thread": items[1].thread_id = "other"; break;
      case "message_id": items[1].message_id = "other"; break;
      case "post": items[1].msg_type = "post"; break;
      case "invalid-json": items[1].body.content = "PRIVATE-{"; break;
      case "oversized": items[1].body.content = "x".repeat(1024 * 1024 + 1); break;
    }
    const calls: string[] = [];
    const proof = await inspectLarkReply(api(items, calls), "app", message, query(), new AbortController().signal);
    assert.equal(proof.status, "unknown");
    assert.deepEqual(calls, ["reply-1", "reply-2"]);
    assert.doesNotMatch(JSON.stringify(proof), /PRIVATE/);
  });
}

test("text proof requires every ID exactly once and rejects unsafe queries before HTTP", async () => {
  const calls: string[] = [];
  for (const messageIds of [[], ["reply-1", "reply-1"], [""], Array.from({ length: 51 }, (_, n) => `id-${n}`)]) {
    assert.equal((await inspectLarkReply(api([], calls), "app", message, { ...query(), messageIds }, new AbortController().signal)).status, "unknown");
  }
  assert.equal(calls.length, 0);
  const reversed = await inspectLarkReply(api([row(0), row(1)], calls), "app", message, { ...query(), messageIds: ["reply-2", "reply-1"] }, new AbortController().signal);
  assert.equal(reversed.status, "unknown");
});

test("cancelling a text chunk query prevents subsequent reads and ignores late success", async () => {
  const controller = new AbortController(); let finish!: (value: unknown) => void;
  let calls = 0;
  const client = { im: { message: { get: async () => { calls++; return new Promise(resolve => { finish = resolve; }); } } } };
  const waiting = inspectLarkReply(client, "app", message, query(), controller.signal);
  controller.abort();
  assert.equal((await waiting).status, "unknown");
  assert.equal(calls, 1);
  finish({ code: 0, data: { items: [row(0)] } });
});

test("text recovery binds each read to the original query despite caller mutation", async () => {
  const original = query(); const calls: string[] = [];
  const client = api([row(0), row(1)], calls), get = client.im.message.get;
  client.im.message.get = async input => {
    if (!calls.length) { original.messageIds[1] = "other"; original.contentFingerprint = hash("changed"); }
    return get(input);
  };
  const proof = await inspectLarkReply(client, "app", message, original, new AbortController().signal);
  assert.equal(proof.status, "confirmed"); assert.deepEqual(calls, ["reply-1", "reply-2"]);
});

test("adapter persists text intent, but SDK markdown replies cannot masquerade as plain text", async () => {
  const events: any[] = [];
  const channel = { send: async () => ({ messageId: "reply-1", chunkIds: ["reply-1", "reply-2"] }) } as unknown as LarkChannelPort;
  const adapter = new LarkChannelAdapter({ appId: "app", appSecret: "", channel });
  await adapter.reply(message, { type: "text", text: finalText }, async event => { events.push(event); });
  assert.equal(events[0].textFingerprint, hash(finalText));
  events.length = 0;
  await adapter.reply(message, { type: "markdown", markdown: finalText }, async event => { events.push(event); });
  assert.equal(events[0].textFingerprint, undefined);
});

for (const scope of ["direct", "group", "thread"] as const) test(`real ${scope} Gateway exits after saved text IDs; restart completes without a second send`, async () => {
  const current: ChannelMessage = { ...message, conversationType: scope === "direct" ? "direct" : "group",
    threadId: scope === "thread" ? "thread-1" : "", rootMessageId: scope === "thread" ? "root-1" : "" };
  const items = [row(0), row(1)].map(item => ({ ...item, thread_id: current.threadId }));
  const dir = mkdtempSync(join(tmpdir(), "ark-text-recovery-")), path = join(dir, "gateway.db");
  try {
    const code = `
      import { GatewayStore } from './src/store.ts';
      import { Gateway } from './src/gateway.ts';
      import { LarkChannelAdapter } from './src/lark-channel.ts';
      const store = new GatewayStore(${JSON.stringify(path)}); store.acquireRuntimeLock();
      const adapter = new LarkChannelAdapter({ appId:'app', appSecret:'', channel:{ send:async()=>({ messageId:'reply-1', chunkIds:['reply-1','reply-2'] }) } });
      const gateway = new Gateway(store, { createSession:async()=> 'session', run:async()=> (${JSON.stringify(result)}) },
        (message, outbound, observer) => adapter.reply(message, outbound, async event => {
          await observer(event); if (event.type === 'sent') process.exit(81);
        }), ${JSON.stringify(options)});
      gateway.accept(${JSON.stringify(current)});
      setTimeout(()=>process.exit(82), 3000);
    `;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
    assert.equal(child.status, 81, child.stderr);
    assert.equal(readFileSync(path).includes(Buffer.from(finalText)), false);
    const store = new GatewayStore(path); store.acquireRuntimeLock();
    try {
      const calls: string[] = []; let runs = 0, sends = 0;
      const before = store.inbox.findMessage(current)!;
      assert.equal(before.replyConfirmed, undefined); assert.equal(before.delivery?.phase, "sent");
      const gateway = new Gateway(store, { createSession: async () => { throw new Error("must not create"); },
        run: async () => { runs++; return result; }, inspectRun: async () => ({ status: "ended", anchorEventId: "a", terminalEventId: "b", result }) },
        async () => { sends++; }, { ...options, inspectReply: (m, q, signal) => inspectLarkReply(api(items, calls), "app", m, q, signal) });
      store.recoverMessages("lark", "app");
      await gateway.reconcilePendingMessage(current);
      const after = store.inbox.findMessage(current)!;
      assert.equal(after.state, "completed"); assert.equal(after.replyInspection?.status, "confirmed");
      assert.equal(after.sessionId, before.sessionId); assert.deepEqual(calls, ["reply-1", "reply-2"]);
      assert.equal(runs, 0); assert.equal(sends, 0);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("all text proof fields and their saved order must match before a checkpoint is committed", () => {
  const f = inspectedTextFixture();
  try {
    const proof = textProof();
    for (const invalid of [{ ...proof, messageIds: ["reply-2", "reply-1"] }, { ...proof, messageIds: ["reply-1"] },
      { ...proof, messageIds: ["reply-1", "reply-1"] }, { ...proof, mode: "native_card" }, { ...proof, mode: undefined },
      { ...proof, contentFingerprint: hash("different") }, { ...proof, observedAt: f.inspected.inspection!.checkedAt - 1 },
      { ...proof, observedAt: Date.now() + 60000 }]) {
      assert.throws(() => f.store.inbox.recordReplyInspection(f.inspected, invalid as any), /回复/);
      assert.deepEqual(f.store.inbox.findMessage(message), f.inspected);
    }
    const saved = f.store.inbox.recordReplyInspection(f.inspected, proof);
    assert.equal(saved.replyConfirmed, true);
    assert.throws(() => f.store.inbox.recordReplyInspection(f.inspected, proof), /版本/);
    const persisted = f.store.inbox.findMessage(message);
    f.store.close();
    const reopened = new GatewayStore(f.path); reopened.acquireRuntimeLock();
    try { assert.deepEqual(reopened.inbox.findMessage(message), persisted); }
    finally { reopened.close(); }
  } finally { f.close(); }
});

test("failed text proof persistence leaves no confirmation and can be retried with fresh evidence", () => {
  const f = inspectedTextFixture(), db = new DatabaseSync(f.path);
  try {
    db.exec("CREATE TRIGGER reject_text_proof BEFORE UPDATE ON gateway_message_inbox BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    assert.throws(() => f.store.inbox.recordReplyInspection(f.inspected, textProof()), /injected failure/);
    assert.deepEqual(f.store.inbox.findMessage(message), f.inspected);
    db.exec("DROP TRIGGER reject_text_proof;");
    const saved = f.store.inbox.recordReplyInspection(f.inspected, textProof());
    assert.equal(f.store.inbox.settleInspection(saved).state, "completed");
  } finally { db.close(); f.close(); }
});

test("text confirmation cannot be used when the current MA result differs from the saved reply intent", () => {
  const f = inspectedTextFixture();
  try {
    const changed = f.store.inbox.recordInspection(f.inspected, { status: "ended", anchorEventId: "a", terminalEventId: "b",
      result: { ...result, messages: ["changed"] } });
    assert.throws(() => f.store.inbox.recordReplyInspection(changed, textProof()), /原运行/);
    assert.equal(f.store.inbox.findMessage(message)!.replyConfirmed, undefined);
  } finally { f.close(); }
});

for (const problem of ["missing", "wrong-thread"] as const) test(`${problem} chunk blocks later work until complete text proof is available`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-text-blocked-")), path = join(dir, "gateway.db");
  const store = new GatewayStore(path); store.acquireRuntimeLock();
  const current = { ...message, threadId: "thread-1", rootMessageId: "root-1" };
  const next = { ...current, messageId: "next-message", eventId: "next-event", text: "next question" };
  const adapter = new LarkChannelAdapter({ appId: "app", appSecret: "", channel: {
    send: async () => ({ messageId: "reply-1", chunkIds: ["reply-1", "reply-2"] })
  } as unknown as LarkChannelPort });
  try {
    new Gateway(store, { createSession: async () => "session", run: async () => result },
      (m, outbound, observer) => adapter.reply(m, outbound, async event => {
        await observer!(event); if (event.type === "sent") throw new Error("lost completion");
      }), options).accept(current);
    await until(() => store.inbox.findMessage(current)?.state === "uncertain");
    let readable = false, runs = 0, sends = 0;
    const calls: string[] = [];
    const recovered = new Gateway(store, { createSession: async () => { throw new Error("must reuse session"); },
      run: async () => { runs++; return { terminal: "idle", messages: ["next response"] }; },
      inspectRun: async () => ({ status: "ended", anchorEventId: "a", terminalEventId: "b", result }) },
      async () => { sends++; }, { ...options, inspectReply: (m, q, signal) => {
        const items: any[] = [row(0), row(1)].map(item => ({ ...item, thread_id: "thread-1" }));
        if (!readable) { if (problem === "missing") items[1] = undefined; else items[1].thread_id = "other-thread"; }
        return inspectLarkReply(api(items, calls), "app", m, q, signal);
      } });
    await recovered.reconcilePendingMessage(current);
    recovered.accept(next); await flush();
    assert.equal(store.inbox.findMessage(current)!.state, "uncertain");
    assert.equal(store.inbox.findMessage(current)!.replyConfirmed, undefined);
    assert.equal(store.inbox.findMessage(next)!.state, "queued");
    assert.equal(runs, 0); assert.equal(sends, 0);
    readable = true;
    await recovered.reconcilePendingMessage(current);
    await until(() => store.inbox.findMessage(next)?.state === "completed");
    assert.equal(store.inbox.findMessage(current)!.state, "completed");
    assert.equal(runs, 1); assert.equal(sends, 1);
    assert.deepEqual(calls, ["reply-1", "reply-2", "reply-1", "reply-2"]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("total text inspection bytes are bounded even when every chunk is individually valid", async () => {
  let reads = 0;
  const text = "x".repeat(900000);
  const client = { im: { message: { get: async (input: any) => {
    reads++;
    return { code: 0, data: { items: [{ ...row(0), message_id: input.path.message_id, body: { content: JSON.stringify({ text }) } }] } };
  } } } };
  const proof = await inspectLarkReply(client, "app", message, { mode: "text_messages",
    messageIds: Array.from({ length: 6 }, (_, n) => `reply-${n}`), contentFingerprint: hash(text.repeat(6)) }, new AbortController().signal);
  assert.deepEqual(proof, { status: "unknown", reason: "invalid_response" });
  assert.equal(reads, 5);
});

test("50 text chunks are read sequentially and a normal successful send needs no inspection", async () => {
  let reads = 0, active = 0, maximum = 0;
  const client = { im: { message: { get: async (input: any) => {
    reads++; maximum = Math.max(maximum, ++active); await flush(); active--;
    return { code: 0, data: { items: [{ ...row(0), message_id: input.path.message_id, body: { content: JSON.stringify({ text: "x" }) } }] } };
  } } } };
  const proof = await inspectLarkReply(client, "app", message, { mode: "text_messages",
    messageIds: Array.from({ length: 50 }, (_, n) => `reply-${n}`), contentFingerprint: hash("x".repeat(50)) }, new AbortController().signal);
  assert.equal(proof.status, "confirmed"); assert.equal(reads, 50); assert.equal(maximum, 1);
  const adapter = new LarkChannelAdapter({ appId: "app", appSecret: "", channel: {
    send: async () => ({ messageId: "reply-1" }), rawClient: client
  } as unknown as LarkChannelPort });
  await adapter.reply(message, { type: "text", text: finalText });
  assert.equal(reads, 50);
});

test("text intent persistence failure prevents sending and a mismatched completion cannot confirm it", async () => {
  let sends = 0;
  const adapter = new LarkChannelAdapter({ appId: "app", appSecret: "", channel: {
    send: async () => { sends++; return { messageId: "reply-1" }; }
  } as unknown as LarkChannelPort });
  await assert.rejects(adapter.reply(message, { type: "text", text: finalText }, async () => { throw new Error("disk full"); }), /disk full/);
  assert.equal(sends, 0);
  const begun = advanceReplyDelivery(undefined, { type: "begin", mode: "message", textFingerprint: hash(finalText) });
  const sent = advanceReplyDelivery(advanceReplyDelivery(begun, { type: "sending" }), { type: "sent", messageIds: ["reply-1"] });
  assert.throws(() => advanceReplyDelivery(sent, { type: "completed", contentFingerprint: hash("changed") }), /正文/);
  assert.equal(sent.phase, "sent");
});

test("querying text replies snapshots the original chat, thread and tenant", async () => {
  const mutable = { ...message, threadId: "thread-1" };
  let calls = 0;
  const client = { im: { message: { get: async () => {
    mutable.conversationId = "changed-chat"; mutable.threadId = "changed-thread"; mutable.tenantId = "changed-tenant";
    return { code: 0, data: { items: [{ ...row(calls++), thread_id: "thread-1" }] } };
  } } } };
  assert.equal((await inspectLarkReply(client, "app", mutable, query(), new AbortController().signal)).status, "confirmed");
  assert.equal(calls, 2);
});

test("text begin and completion bind the sent body even if the caller mutates outbound while sending", async () => {
  const outbound = { type: "text" as const, text: finalText }, events: any[] = [];
  const adapter = new LarkChannelAdapter({ appId: "app", appSecret: "", channel: {
    send: async (_chat: string, input: any) => {
      assert.equal(input.text, finalText); outbound.text = "changed"; return { messageId: "reply-1" };
    }
  } as unknown as LarkChannelPort });
  await adapter.reply(message, outbound, async event => { events.push(event); });
  assert.equal(events[0].textFingerprint, hash(finalText));
  assert.equal(events.at(-1).contentFingerprint, hash(finalText));
});
