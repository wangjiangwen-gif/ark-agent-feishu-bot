import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { GatewayStore } from "../src/store.ts";
import { Gateway, toConversationKey, type GatewayOptions } from "../src/gateway.ts";
import { LarkChannelAdapter, type LarkChannelPort } from "../src/lark-channel.ts";
import type { ChannelMessage, ReplyDeliveryEvent } from "../src/channel.ts";
import { replyInspectionQuery } from "../src/reply-delivery.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const result = { terminal: "idle" as const, messages: ["final-private-text"] };
const message: ChannelMessage = { channelType: "lark", installationId: "cli", tenantId: "tenant", senderId: "user",
  conversationId: "chat", conversationType: "direct", threadId: "", rootMessageId: "", parentMessageId: "", messageId: "message", eventId: "event",
  createTime: 1, text: "question", resources: [], mentionedBot: false };
const binding = { scope: "scope", agentId: "agent", configFingerprint: "config" };
const options: GatewayOptions = { agentId: "agent", environmentId: "env", vaultId: "bot-vault", appId: "cli", platformAccess: true,
  sharedGroupSessions: true, durableQueue: true, timeoutMs: 1000, sessionCompaction: false };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ark-delivery-")), path = join(dir, "gateway.db");
  const store = new GatewayStore(path); store.acquireRuntimeLock();
  const task = store.receiveMessage(message, binding)!;
  store.inbox.claim(task.id, binding); store.dispatchMessage(task.id, "session", hash("input"));
  return { store, path, id: task.id, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function port(failure?: "content" | "settings") {
  const writes: string[] = [];
  const channel = { createCard: async () => { writes.push("create"); return { cardId: "card" }; },
    send: async () => { writes.push("send"); return { messageId: "reply" }; },
    rawClient: { im: {}, cardkit: { v1: {
      cardElement: { content: async () => { writes.push("content"); return { code: failure === "content" ? 999 : 0 }; } },
      card: { settings: async () => { writes.push("settings"); return { code: failure === "settings" ? 999 : 0 }; } }
    } } }
  } as unknown as LarkChannelPort;
  const adapter = new LarkChannelAdapter({ appId: "cli", appSecret: "", channel,
    streaming: { intervalMs: 1, minChunkChars: 100, maxSteps: 1, printFrequencyMs: 1, printStep: 100, settlePaddingMs: 0 } });
  return { adapter, channel, writes };
}
async function until(check: () => boolean) { for (let n = 0; n < 200 && !check(); n++) { await flush(); await new Promise(r => setTimeout(r, 1)); } assert.ok(check()); }

test("native card confirms final text before Gateway returns and persists encrypted across restart", async () => {
  const f = fixture(), { adapter } = port(); const events: ReplyDeliveryEvent[] = [];
  try {
    await adapter.streamReply(message, async update => {
      f.store.inbox.planReply(f.id, result, result.messages[0]);
      await update(result.messages[0]);
    }, async event => { events.push(event); f.store.inbox.recordReplyDelivery(f.id, event); });
    const task = f.store.inbox.findMessage(message)!;
    assert.equal(task.replyConfirmed, true);
    assert.equal(task.delivery?.phase, "completed");
    assert.equal(task.delivery?.cardId, "card");
    assert.deepEqual(task.delivery?.messageIds, ["reply"]);
    assert.equal(events.at(-1)?.type, "completed");
    for (const path of [f.path, `${f.path}-wal`].filter(existsSync)) assert.equal(readFileSync(path).includes(Buffer.from(result.messages[0])), false);
    f.store.close();
    const reopened = new GatewayStore(f.path); reopened.acquireRuntimeLock();
    try { assert.deepEqual(reopened.inbox.findMessage(message)!.delivery, task.delivery); }
    finally { reopened.close(); }
  } finally { f.close(); }
});

for (const failure of ["content", "settings"] as const) test(`native ${failure} rejection cannot confirm final delivery`, async () => {
  const f = fixture(), { adapter } = port(failure);
  try {
    await assert.rejects(adapter.streamReply(message, async update => {
      f.store.inbox.planReply(f.id, result, result.messages[0]); await update(result.messages[0]);
    }, async event => { f.store.inbox.recordReplyDelivery(f.id, event); }), new RegExp(`CardKit ${failure}`));
    assert.equal(f.store.inbox.findMessage(message)!.replyConfirmed, undefined);
    assert.notEqual(f.store.inbox.findMessage(message)!.delivery?.phase, "completed");
  } finally { f.close(); }
});

test("placeholder and authorization prompt never prove a final reply", async () => {
  const f = fixture(), { adapter } = port();
  try {
    assert.throws(() => f.store.inbox.planReply(f.id, { ...result, authorizationRequired: {} } as any, "请授权"), /授权/);
    await adapter.streamReply(message, async update => { await update("请完成授权"); }, async event => {
      f.store.inbox.recordReplyDelivery(f.id, event);
      if (event.type === "sent") assert.equal(f.store.inbox.findMessage(message)!.replyConfirmed, undefined);
    });
    assert.equal(f.store.inbox.findMessage(message)!.replyConfirmed, undefined);
  } finally { f.close(); }
});

test("different final content cannot satisfy the persisted reply intent", async () => {
  const f = fixture(), { adapter } = port();
  try {
    f.store.inbox.planReply(f.id, result, result.messages[0]);
    await assert.rejects(adapter.streamReply(message, async update => { await update("wrong text"); }, async event => {
      f.store.inbox.recordReplyDelivery(f.id, event);
    }), /正文|回复/);
    assert.equal(f.store.inbox.findMessage(message)!.replyConfirmed, undefined);
  } finally { f.close(); }
});

test("checkpoint failure before card creation prevents the external write", async () => {
  const { adapter, writes } = port();
  await assert.rejects(adapter.streamReply(message, async () => {}, async () => { throw new Error("checkpoint unavailable"); }), /checkpoint/);
  assert.deepEqual(writes, []);
});

test("producer failure may close streaming but never emits completed receipt", async () => {
  const { adapter } = port(); const events: ReplyDeliveryEvent[] = [];
  await assert.rejects(adapter.streamReply(message, async update => { await update("partial"); throw new Error("producer failure"); }, async event => { events.push(event); }), /producer/);
  assert.equal(events.some(event => event.type === "completed"), false);
});

test("plain replies checkpoint all chunk IDs and their exact final body", async () => {
  const f = fixture(), { adapter, channel } = port();
  channel.send = async () => ({ messageId: "reply", chunkIds: ["chunk2"] }) as any;
  try {
    f.store.inbox.planReply(f.id, result, result.messages[0]);
    await adapter.reply(message, { type: "text", text: result.messages[0] }, async event => { f.store.inbox.recordReplyDelivery(f.id, event); });
    assert.deepEqual(f.store.inbox.findMessage(message)!.delivery?.messageIds, ["reply", "chunk2"]);
    assert.equal(f.store.inbox.findMessage(message)!.replyConfirmed, true);
  } finally { f.close(); }
});

test("invalid sequence, missing message IDs and second delivery cannot forge completion", () => {
  const f = fixture();
  try {
    const record = (event: ReplyDeliveryEvent) => f.store.inbox.recordReplyDelivery(f.id, event);
    record({ type: "begin", mode: "native_card" });
    assert.throws(() => record({ type: "completed", contentFingerprint: hash("x") }), /投递/);
    record({ type: "card_created", cardId: "card", elementId: "body" }); record({ type: "sending" });
    assert.throws(() => record({ type: "sent", messageIds: [] }), /ID/);
    record({ type: "sent", messageIds: ["reply"] });
    assert.throws(() => record({ type: "content_pending", sequence: 0, contentFingerprint: hash("x") }), /序号/);
    assert.throws(() => record({ type: "begin", mode: "message" }), /投递/);
  } finally { f.close(); }
});

test("legacy Gateway confirmation cannot bypass an unfinished observed delivery", () => {
  const f = fixture();
  try {
    f.store.inbox.planReply(f.id, result, result.messages[0]);
    f.store.inbox.recordReplyDelivery(f.id, { type: "begin", mode: "message" });
    f.store.inbox.recordReplyDelivery(f.id, { type: "sending" });
    assert.throws(() => f.store.confirmMessageReply(f.id, result), /投递/);
    assert.equal(f.store.inbox.findMessage(message)!.replyConfirmed, undefined);
  } finally { f.close(); }
});

test("observer is awaited before every external native card operation", async () => {
  const { adapter, writes } = port(); let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const running = adapter.streamReply(message, async update => { await update("answer"); }, async event => {
    if (event.type === "sending") await barrier;
  });
  await until(() => writes.includes("create")); await flush();
  assert.deepEqual(writes, ["create"]);
  release(); await running;
  assert.deepEqual(writes, ["create", "send", "content", "settings"]);
});

test("SDK fallback only records the known message ID, never an unverifiable final acknowledgement", async () => {
  const { adapter, channel } = port(); channel.rawClient = undefined;
  const events: ReplyDeliveryEvent[] = [];
  channel.stream = async (_chat, input: any) => {
    await input.markdown({ setContent: async () => {}, append: async () => {} });
    return { messageId: "sdk-reply" } as any;
  };
  await adapter.streamReply(message, async update => { await update("sdk text"); }, async event => { events.push(event); });
  assert.deepEqual(events, [{ type: "begin", mode: "sdk_stream" }, { type: "sending" }, { type: "sent", messageIds: ["sdk-reply"] }]);
  events.length = 0;
  channel.stream = async () => { throw new Error("SDK rejected"); };
  await assert.rejects(adapter.streamReply(message, async () => {}, async event => { events.push(event); }), /SDK rejected/);
  assert.equal(events.at(-1)?.type, "sending");
});

test("authorization continuation resets old delivery targets and late callbacks cannot alter uncertain work", () => {
  const f = fixture();
  try {
    const previousDispatch = f.store.inbox.findMessage(message)!.dispatchId!;
    f.store.inbox.recordReplyDelivery(f.id, { type: "begin", mode: "message" });
    f.store.finishMessage(f.id, "awaiting_authorization");
    f.store.startAuthorizationRecovery(message, "session"); f.store.claimAuthorizationRecovery(message);
    f.store.resumeAuthorizationMessage(message); f.store.dispatchMessage(f.id, "session", hash("input"));
    assert.notEqual(f.store.inbox.findMessage(message)!.dispatchId, previousDispatch);
    assert.throws(() => f.store.inbox.recordReplyDelivery(f.id, { type: "begin", mode: "message" }, previousDispatch), /派发/);
    assert.throws(() => f.store.inbox.planReply(f.id, result, result.messages[0], previousDispatch), /派发/);
    assert.throws(() => f.store.confirmMessageReply(f.id, result, previousDispatch), /派发/);
    assert.equal(f.store.inbox.findMessage(message)!.delivery, undefined);
    assert.equal(f.store.inbox.findMessage(message)!.replyIntent, undefined);
    f.store.finishMessage(f.id, "failed");
    assert.throws(() => f.store.inbox.recordReplyDelivery(f.id, { type: "begin", mode: "message" }), /任务/);
  } finally { f.close(); }
});

test("SDK stream resolution cannot be promoted to a durable final reply", () => {
  const f = fixture();
  try {
    f.store.inbox.planReply(f.id, result, result.messages[0]);
    for (const event of [{ type: "begin", mode: "sdk_stream" }, { type: "sending" }, { type: "sent", messageIds: ["reply"] }] as ReplyDeliveryEvent[]) f.store.inbox.recordReplyDelivery(f.id, event);
    assert.throws(() => f.store.inbox.recordReplyDelivery(f.id, { type: "completed", contentFingerprint: hash(result.messages[0]) }), /SDK/);
    assert.throws(() => f.store.confirmMessageReply(f.id, result), /投递/);
    assert.equal(f.store.inbox.findMessage(message)!.replyConfirmed, undefined);
  } finally { f.close(); }
});

test("actual process exit between native delivery completion and Gateway confirmation is recoverable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-delivery-crash-")), path = join(dir, "gateway.db");
  const worker = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import {GatewayStore} from './src/store.ts'; import {Gateway} from './src/gateway.ts'; import {LarkChannelAdapter} from './src/lark-channel.ts';
    const store=new GatewayStore(${JSON.stringify(path)});store.acquireRuntimeLock();
    const adapter=new LarkChannelAdapter({appId:'cli',appSecret:'',streaming:{intervalMs:1,minChunkChars:100,maxSteps:1,printFrequencyMs:1,printStep:100,settlePaddingMs:0},
      channel:{createCard:async()=>({cardId:'card'}),send:async()=>({messageId:'reply'}),rawClient:{im:{},cardkit:{v1:{
        cardElement:{content:async()=>({code:0})},card:{settings:async()=>({code:0})}}}}}});
    store.confirmMessageReply=()=>process.exit(77);
    const gateway=new Gateway(store,{createSession:async()=>"session",run:async()=>(${JSON.stringify(result)})},async()=>{},
      {...${JSON.stringify(options)},streamReply:adapter.streamReply.bind(adapter)});
    gateway.accept(${JSON.stringify(message)});setTimeout(()=>process.exit(9),2000);
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
  try {
    assert.equal(worker.status, 77, worker.stderr);
    const store = new GatewayStore(path); store.acquireRuntimeLock();
    try {
      assert.equal(store.inbox.findMessage(message)!.state, "dispatched");
      assert.equal(store.inbox.findMessage(message)!.delivery?.phase, "completed");
      let queries = 0;
      const gateway = new Gateway(store, { createSession: async () => { throw new Error("must not create"); }, run: async () => { throw new Error("must not run"); },
        inspectRun: async () => { queries++; return { status: "ended", anchorEventId: "anchor", terminalEventId: "idle", result }; } }, async () => { throw new Error("must not send"); }, options);
      gateway.recoverPendingMessages("lark", "cli");
      await until(() => store.inbox.findMessage(message)?.state === "completed");
      assert.equal(queries, 1);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Gateway recovers crash after adapter final receipt without rerunning MA or resending the reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-delivery-gateway-")), path = join(dir, "gateway.db");
  const store = new GatewayStore(path); store.acquireRuntimeLock(); const { adapter, writes } = port(); let runs = 0;
  try {
    store.confirmMessageReply = () => { throw new Error("crash before Gateway final receipt"); };
    const gateway = new Gateway(store, { createSession: async () => "session", run: async () => { runs++; return result; } }, async () => {},
      { ...options, streamReply: (m, producer, observer) => adapter.streamReply(m, producer, observer) });
    gateway.accept(message); await until(() => store.inbox.findMessage(message)?.state === "uncertain");
    assert.equal(store.inbox.findMessage(message)!.replyConfirmed, true);
    const writeCount = writes.length; store.close();
    const reopened = new GatewayStore(path); reopened.acquireRuntimeLock();
    try {
      const recovered = new Gateway(reopened, { createSession: async () => { throw new Error("must not create"); },
        run: async () => { runs++; throw new Error("must not run"); }, inspectRun: async () => ({ status: "ended", anchorEventId: "anchor", terminalEventId: "idle", result }) },
        async () => { throw new Error("must not reply"); }, options);
      await recovered.reconcilePendingMessage(message);
      assert.equal(reopened.inbox.findMessage(message)!.state, "completed");
      assert.equal(runs, 1); assert.equal(writes.length, writeCount);
    } finally { reopened.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("remote proof requires matching MA result, attempted final body and fresh exact receipt", async () => {
  const f = fixture(), { adapter } = port("settings");
  try {
    f.store.inbox.planReply(f.id, result, result.messages[0]);
    await assert.rejects(adapter.streamReply(message, async update => { await update(result.messages[0]); }, async event => { f.store.inbox.recordReplyDelivery(f.id, event); }));
    const uncertain = f.store.inbox.finish(f.id, "failed");
    const proof = { status: "confirmed" as const, messageId: "reply", elementId: "arkagent_stream_md", contentFingerprint: hash(result.messages[0]), observedAt: Date.now() };
    assert.throws(() => f.store.inbox.recordReplyInspection(uncertain, proof), /核查/);
    const inspected = f.store.inbox.recordInspection(uncertain, { status: "ended", anchorEventId: "a", terminalEventId: "b", result });
    proof.observedAt = Date.now();
    for (const bad of [{ ...proof, messageId: "other" }, { ...proof, elementId: "other" }, { ...proof, contentFingerprint: hash("wrong") },
      { ...proof, observedAt: Date.now() - 31000 }, { ...proof, observedAt: inspected.inspection!.checkedAt - 1 }, { ...proof, observedAt: Date.now() + 60000 }])
      assert.throws(() => f.store.inbox.recordReplyInspection(inspected, bad), /回复/);
    const saved = f.store.inbox.recordReplyInspection(inspected, proof);
    assert.equal(saved.replyConfirmed, true); assert.equal(saved.delivery?.phase, "completed");
    assert.equal(saved.replyInspection?.status, "confirmed");
    assert.throws(() => f.store.inbox.recordReplyInspection(inspected, proof), /版本/);
    assert.equal(f.store.inbox.settleInspection(saved).state, "completed");
  } finally { f.close(); }
});

test("unsupported or unattempted delivery cannot request remote final confirmation", () => {
  assert.equal(replyInspectionQuery(undefined, hash("final")), undefined);
  for (const mode of ["message", "sdk_stream"] as const) assert.equal(replyInspectionQuery({ mode, phase: "sent", sequence: 0, messageIds: ["reply"] }, hash("final")), undefined);
  assert.equal(replyInspectionQuery({ mode: "native_card", phase: "sent", sequence: 0, messageIds: ["reply"], elementId: "body" }, hash("final")), undefined);
  assert.equal(replyInspectionQuery({ mode: "native_card", phase: "finalizing", sequence: 2, messageIds: ["reply"], elementId: "body", contentFingerprint: hash("partial") }, hash("final")), undefined);
});

for (const lost of ["content", "settings"] as const) test(`Gateway recovers remote ${lost} success with lost acknowledgement without writes`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-remote-delivery-")), path = join(dir, "gateway.db");
  const store = new GatewayStore(path); store.acquireRuntimeLock(); const { adapter, channel, writes } = port();
  let text = "Thinking...", streaming = true, gets = 0, runs = 0;
  channel.rawClient!.im.message = { list: async () => ({}), get: async () => {
    gets++; return { code: 0, data: { items: [{ message_id: "reply", chat_id: "chat", deleted: false, msg_type: "interactive",
      sender: { id: "cli", id_type: "app_id", sender_type: "app", tenant_key: "tenant" },
      body: { content: JSON.stringify({ schema: "2.0", config: { streaming_mode: streaming }, body: { elements: [{ tag: "markdown", element_id: "arkagent_stream_md", content: text }] } }) } }] } };
  } };
  channel.rawClient!.cardkit!.v1!.cardElement!.content = async (payload: any) => { writes.push("content"); text = payload.data.content; if (lost === "content") throw new Error("response lost"); return { code: 0 }; };
  channel.rawClient!.cardkit!.v1!.card!.settings = async () => { writes.push("settings"); streaming = false; if (lost === "settings") throw new Error("response lost"); return { code: 0 }; };
  try {
    const gateway = new Gateway(store, { createSession: async () => "session", run: async () => { runs++; return result; } }, async () => {},
      { ...options, streamReply: adapter.streamReply.bind(adapter) });
    gateway.accept(message); await until(() => store.inbox.findMessage(message)?.state === "uncertain");
    assert.equal(store.inbox.findMessage(message)!.replyConfirmed, undefined); const before = writes.length;
    store.close(); const reopened = new GatewayStore(path); reopened.acquireRuntimeLock();
    try {
      const recovered = new Gateway(reopened, { createSession: async () => { throw new Error("must not create"); },
        run: async () => { runs++; throw new Error("must not run"); }, inspectRun: async () => ({ status: "ended", anchorEventId: "a", terminalEventId: "b", result }) },
        async () => { throw new Error("must not send"); }, { ...options, inspectReply: adapter.inspectReply.bind(adapter) });
      await Promise.all([recovered.reconcilePendingMessage(message), recovered.reconcilePendingMessage(message)]);
      const task = reopened.inbox.findMessage(message)!;
      assert.equal(task.state, "completed"); assert.equal(task.replyInspection?.status, "confirmed");
      assert.equal(runs, 1); assert.equal(gets, 1); assert.equal(writes.length, before);
    } finally { reopened.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("unknown remote reply stays blocked and can be inspected again without business replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-reply-unknown-")), path = join(dir, "gateway.db");
  const store = new GatewayStore(path); store.acquireRuntimeLock(); const { adapter } = port("settings");
  try {
    new Gateway(store, { createSession: async () => "session", run: async () => result }, async () => {},
      { ...options, streamReply: adapter.streamReply.bind(adapter) }).accept(message);
    await until(() => store.inbox.findMessage(message)?.state === "uncertain");
    let lookups = 0;
    const recovered = new Gateway(store, { createSession: async () => { throw new Error("unexpected create"); }, run: async () => { throw new Error("unexpected run"); },
      inspectRun: async () => ({ status: "ended", anchorEventId: "a", terminalEventId: "b", result }) }, async () => { throw new Error("unexpected send"); },
      { ...options, inspectReply: async (_m, query) => {
        lookups++;
        if (lookups === 1) throw new Error("upstream-secret");
        return { status: "confirmed", messageId: query.messageId, elementId: query.elementId, contentFingerprint: query.contentFingerprint, observedAt: Date.now() };
      } });
    await recovered.reconcilePendingMessage(message);
    const task = store.inbox.findMessage(message)!;
    assert.equal(task.state, "uncertain"); assert.deepEqual(task.replyInspection, { status: "unknown", reason: "unavailable" });
    assert.equal(task.replyConfirmed, undefined);
    await recovered.reconcilePendingMessage(message);
    assert.equal(store.inbox.findMessage(message)!.state, "completed"); assert.equal(lookups, 2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const change of ["revision", "session"] as const) test(`late remote proof cannot overwrite a changed ${change}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-reply-cas-")), path = join(dir, "gateway.db");
  const store = new GatewayStore(path); store.acquireRuntimeLock(); const { adapter } = port("settings");
  try {
    new Gateway(store, { createSession: async () => "session", run: async () => result }, async () => {},
      { ...options, streamReply: adapter.streamReply.bind(adapter) }).accept(message);
    await until(() => store.inbox.findMessage(message)?.state === "uncertain");
    const recovered = new Gateway(store, { createSession: async () => "unexpected", run: async () => result,
      inspectRun: async () => ({ status: "ended", anchorEventId: "a", terminalEventId: "b", result }) }, async () => {},
      { ...options, inspectReply: async (_m, query) => {
        if (change === "revision") store.recordMessageInspection(store.inbox.findMessage(message)!, { status: "unknown", reason: "history_unavailable" });
        else store.saveSession(toConversationKey(message, true), "replacement", "agent");
        return { status: "confirmed", messageId: query.messageId, elementId: query.elementId, contentFingerprint: query.contentFingerprint, observedAt: Date.now() };
      } });
    await recovered.reconcilePendingMessage(message);
    assert.equal(store.inbox.findMessage(message)!.state, "uncertain");
    assert.equal(store.inbox.findMessage(message)!.replyConfirmed, undefined);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("real process exits after remote settings effect before acknowledgement and GET recovers it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-reply-remote-crash-")), path = join(dir, "gateway.db");
  const worker = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import {GatewayStore} from './src/store.ts'; import {Gateway} from './src/gateway.ts'; import {LarkChannelAdapter} from './src/lark-channel.ts';
    const store=new GatewayStore(${JSON.stringify(path)});store.acquireRuntimeLock();let text='Thinking...';
    const adapter=new LarkChannelAdapter({appId:'cli',appSecret:'',streaming:{intervalMs:1,minChunkChars:100,maxSteps:1,printFrequencyMs:1,printStep:100,settlePaddingMs:0},
      channel:{createCard:async()=>({cardId:'card'}),send:async()=>({messageId:'reply'}),rawClient:{im:{},cardkit:{v1:{
        cardElement:{content:async p=>{text=p.data.content;return {code:0}}},card:{settings:async()=>{
          process.stdout.write(JSON.stringify({schema:'2.0',config:{streaming_mode:false},body:{elements:[{tag:'markdown',element_id:'arkagent_stream_md',content:text}]}}));process.exit(78);
        }}}}}}});
    new Gateway(store,{createSession:async()=>"session",run:async()=>(${JSON.stringify(result)})},async()=>{},
      {...${JSON.stringify(options)},streamReply:adapter.streamReply.bind(adapter)}).accept(${JSON.stringify(message)});setTimeout(()=>process.exit(9),2000);
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
  try {
    assert.equal(worker.status, 78, worker.stderr); const remoteCard = JSON.parse(worker.stdout);
    const store = new GatewayStore(path); store.acquireRuntimeLock(); let reads = 0;
    try {
      assert.equal(store.inbox.findMessage(message)!.delivery?.phase, "finalizing");
      assert.equal(store.inbox.findMessage(message)!.replyConfirmed, undefined);
      const { adapter, channel, writes } = port();
      channel.rawClient!.im.message = { list: async () => ({}), get: async () => { reads++; return { code: 0, data: { items: [{ message_id: "reply",
        chat_id: "chat", msg_type: "interactive", deleted: false, sender: { id: "cli", id_type: "app_id", sender_type: "app", tenant_key: "tenant" }, body: { content: JSON.stringify(remoteCard) } }] } }; } };
      const gateway = new Gateway(store, { createSession: async () => { throw new Error("must not create"); }, run: async () => { throw new Error("must not run"); },
        inspectRun: async () => ({ status: "ended", anchorEventId: "a", terminalEventId: "b", result }) }, async () => { throw new Error("must not send"); },
        { ...options, inspectReply: adapter.inspectReply.bind(adapter) });
      gateway.recoverPendingMessages("lark", "cli");
      await until(() => store.inbox.findMessage(message)?.state === "completed");
      assert.equal(reads, 1); assert.deepEqual(writes, []);
      assert.equal(store.inbox.findMessage(message)?.replyInspection?.status, "confirmed");
    } finally { store.close(); }
    const reloaded = new GatewayStore(path); reloaded.acquireRuntimeLock();
    try { assert.equal(reloaded.inbox.findMessage(message)?.replyInspection?.status, "confirmed"); }
    finally { reloaded.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
