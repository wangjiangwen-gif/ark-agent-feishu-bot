import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { setImmediate as flush } from "node:timers/promises";
import { GatewayStore } from "../src/store.ts";
import { Gateway, toConversationKey, type GatewayOptions } from "../src/gateway.ts";
import type { ChannelMessage } from "../src/channel.ts";
import { ArkClient, type RunInspection } from "../src/ark.ts";
import { LarkChannelAdapter, type LarkChannelPort } from "../src/lark-channel.ts";

const message = (id = "first"): ChannelMessage => ({ channelType: "lark", installationId: "cli", tenantId: "tenant", senderId: "user",
  conversationId: "chat", conversationType: "direct", threadId: "", rootMessageId: "", parentMessageId: "", messageId: id, eventId: id,
  createTime: 1, text: id, resources: [], mentionedBot: false });
const binding = { scope: "scope", agentId: "agent", configFingerprint: "config" };
const fp = "a".repeat(64);
const ended: RunInspection = { status: "ended", anchorEventId: "anchor", terminalEventId: "idle", result: { terminal: "idle", messages: ["private-result-secret"] } };
const options: GatewayOptions = { agentId: "agent", environmentId: "env", vaultId: "bot-vault", appId: "cli", platformAccess: true,
  sharedGroupSessions: true, durableQueue: true, timeoutMs: 1000, sessionCompaction: false };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ark-reconciliation-")), path = join(dir, "gateway.db");
  const store = new GatewayStore(path); store.acquireRuntimeLock(); const db = new DatabaseSync(path);
  return { path, store, db, close() { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function interrupted(store: GatewayStore, delivered: boolean) {
  const task = store.receiveMessage(message(), binding)!;
  store.inbox.claim(task.id, binding); store.dispatchMessage(task.id, "session", fp);
  if (delivered) store.confirmMessageReply(task.id, ended.result);
  return store.finishMessage(task.id, "failed");
}

test("confirmed reply and inspection survive restart encrypted and settle atomically", () => {
  const f = fixture();
  try {
    const task = interrupted(f.store, true);
    const inspected = f.store.recordMessageInspection(task, ended);
    assert.equal(inspected.replyConfirmed, true);
    assert.deepEqual(inspected.inspection?.observation, ended);
    assert.equal(readFileSync(f.path).includes(Buffer.from("private-result-secret")), false);
    f.store.close();
    const reopened = new GatewayStore(f.path); reopened.acquireRuntimeLock();
    try {
      const saved = reopened.inbox.findMessage(message())!;
      assert.deepEqual(saved.inspection?.observation, ended);
      assert.equal(reopened.settleInspectedMessage(saved).state, "completed");
      assert.equal(f.db.prepare("SELECT status FROM processed_events").get()!.status, "completed");
    } finally { reopened.close(); }
  } finally { f.close(); }
});

for (const [name, observation, delivered] of [
  ["unknown", { status: "unknown", reason: "history_unavailable" }, true],
  ["running", { status: "running", anchorEventId: "anchor" }, true],
  ["missing delivery confirmation", ended, false],
  ["authorization still required", { ...ended, result: { ...ended.result, authorizationRequired: { identity: "user", errorType: "authentication", subtype: "token_missing" } } }, true]
] as const) {
  test(`reconciliation does not complete ${name}`, () => {
    const f = fixture();
    try {
      const inspected = f.store.recordMessageInspection(interrupted(f.store, delivered), observation as RunInspection);
      assert.throws(() => f.store.settleInspectedMessage(inspected), /核查|回复|授权/);
      assert.equal(f.store.inbox.findMessage(message())!.state, "uncertain");
    } finally { f.close(); }
  });
}

test("stale inspection and changed Session evidence cannot overwrite a newer checkpoint", () => {
  const f = fixture();
  try {
    const task = interrupted(f.store, true);
    assert.throws(() => f.store.recordMessageInspection({ ...task, sessionId: "other" }, ended), /变化|绑定/);
    f.store.recordMessageInspection(task, ended);
    assert.throws(() => f.store.recordMessageInspection(task, ended), /变化|版本/);
    assert.throws(() => f.store.settleInspectedMessage(task), /变化|版本/);
  } finally { f.close(); }
});

test("settlement failure rolls back inbox and event records together", () => {
  const f = fixture();
  try {
    const task = f.store.recordMessageInspection(interrupted(f.store, true), ended);
    f.db.exec("CREATE TRIGGER fail_settlement BEFORE UPDATE ON processed_events BEGIN SELECT RAISE(ABORT, 'injected'); END");
    assert.throws(() => f.store.settleInspectedMessage(task), /injected/);
    assert.equal(f.store.inbox.findMessage(message())!.revision, task.revision);
    assert.equal(f.db.prepare("SELECT status FROM processed_events").get()!.status, "uncertain");
  } finally { f.close(); }
});

test("reply confirmation is restricted to dispatched work and is cleared on authorization continuation", () => {
  const f = fixture();
  try {
    const task = f.store.receiveMessage(message(), binding)!;
    assert.throws(() => f.store.confirmMessageReply(task.id, ended.result), /状态|网关/);
    f.store.inbox.claim(task.id, binding);
    assert.throws(() => f.store.confirmMessageReply(task.id, ended.result), /状态/);
    f.store.dispatchMessage(task.id, "session", fp); f.store.confirmMessageReply(task.id, ended.result);
    f.store.finishMessage(task.id, "awaiting_authorization");
    f.store.startAuthorizationRecovery(message(), "session"); f.store.claimAuthorizationRecovery(message());
    f.store.resumeAuthorizationMessage(message()); f.store.dispatchMessage(task.id, "session", "b".repeat(64));
    assert.equal(f.store.inbox.findMessage(message())!.replyConfirmed, undefined);
  } finally { f.close(); }
});

async function until(check: () => boolean) { for (let n = 0; n < 100 && !check(); n++) await flush(); assert.ok(check()); }
async function failedAfterReply(store: GatewayStore) {
  const gateway = new Gateway(store, { createSession: async () => "session", run: async () => ended.result }, async () => {}, options);
  const original = store.addAuditLog.bind(store);
  store.addAuditLog = () => { throw new Error("crash after reply receipt"); };
  gateway.accept(message()); await until(() => store.inbox.findMessage(message())?.state === "uncertain");
  store.addAuditLog = original; await flush();
  return store.inbox.findMessage(message())!;
}

test("Gateway reconciles confirmed replies and releases queued followers without replaying the original request", async () => {
  const f = fixture(); let creates = 0; const inputs: string[] = []; let inspections = 0;
  try {
    const task = await failedAfterReply(f.store);
    assert.equal(task.replyConfirmed, true);
    f.store.receiveMessage(message("later"), task.binding);
    const restarted = new Gateway(f.store, { createSession: async () => { creates++; return "wrong"; }, run: async (_s, input) => {
      inputs.push(input); return { terminal: "idle", messages: ["later result"] };
    }, inspectRun: async (session, fingerprint) => { inspections++; assert.equal(session, "session"); assert.equal(fingerprint, task.requestFingerprint); return ended; } }, async () => {}, options);
    restarted.recoverPendingMessages("lark", "cli"); restarted.recoverPendingMessages("lark", "cli");
    await until(() => f.store.inbox.findMessage(message("later"))?.state === "completed");
    assert.equal(f.store.inbox.findMessage(message())!.state, "completed");
    assert.equal(creates, 0); assert.equal(inspections, 1); assert.equal(inputs.length, 1);
    assert.ok(inputs[0].includes("later"));
  } finally { f.close(); }
});

test("Gateway does not inspect with changed Agent binding or release an externally replaced Session", async () => {
  const f = fixture(); let inspections = 0;
  try {
    await failedAfterReply(f.store);
    const ark = { createSession: async () => "wrong", run: async () => ({ terminal: "idle" as const, messages: [] }), inspectRun: async () => { inspections++; return ended; } };
    const changed = new Gateway(f.store, ark, async () => {}, { ...options, agentId: "changed" });
    await changed.reconcilePendingMessage(message());
    assert.equal(inspections, 0);
    const current = new Gateway(f.store, ark, async () => {}, options);
    f.store.saveSession(toConversationKey(message(), true), "replacement", "agent");
    await current.reconcilePendingMessage(message());
    assert.equal(inspections, 0); assert.equal(f.store.inbox.findMessage(message())!.state, "uncertain");
  } finally { f.close(); }
});

test("a delivered reply for different runtime content cannot settle the inspected task", () => {
  const f = fixture();
  try {
    const task = f.store.recordMessageInspection(interrupted(f.store, true), { ...ended, result: { terminal: "idle", messages: ["different reply"] } });
    assert.throws(() => f.store.settleInspectedMessage(task), /回复/);
    assert.equal(f.store.inbox.findMessage(message())!.state, "uncertain");
  } finally { f.close(); }
});

test("stale persisted completion must be re-inspected before releasing the queue", t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const f = fixture();
  try {
    const task = f.store.recordMessageInspection(interrupted(f.store, true), ended);
    t.mock.timers.tick(30_001);
    assert.throws(() => f.store.settleInspectedMessage(task), /核查/);
  } finally { f.close(); }
});

test("Gateway persists unknown inspection and a later explicit query can release only the original task", async () => {
  const f = fixture(); let response: RunInspection = { status: "unknown", reason: "history_unavailable" }; let calls = 0;
  try {
    await failedAfterReply(f.store);
    const gateway = new Gateway(f.store, { createSession: async () => { throw new Error("must not create"); }, run: async () => { throw new Error("must not replay"); },
      inspectRun: async () => { calls++; return response; } }, async () => { throw new Error("must not resend"); }, options);
    await gateway.reconcilePendingMessage(message());
    assert.equal(f.store.inbox.findMessage(message())!.inspection?.observation.status, "unknown");
    assert.equal(f.store.inbox.findMessage(message())!.state, "uncertain");
    response = ended;
    await gateway.reconcilePendingMessage(message());
    assert.equal(f.store.inbox.findMessage(message())!.state, "completed"); assert.equal(calls, 2);
  } finally { f.close(); }
});

test("Session replacement during an in-flight inspection invalidates the result", async () => {
  const f = fixture(); let resolve!: (value: RunInspection) => void; let queried = false;
  try {
    await failedAfterReply(f.store);
    const gateway = new Gateway(f.store, { createSession: async () => "unused", run: async () => ended.result,
      inspectRun: async () => { queried = true; return new Promise<RunInspection>(yes => { resolve = yes; }); } }, async () => {}, options);
    const pending = gateway.reconcilePendingMessage(message()); await until(() => queried);
    f.store.saveSession(toConversationKey(message(), true), "replacement", "agent");
    resolve(ended); await pending;
    assert.equal(f.store.inbox.findMessage(message())!.state, "uncertain");
    assert.equal(f.store.inbox.findMessage(message())!.inspection, undefined);
  } finally { f.close(); }
});

test("inspection does not remove an independent authorization pause", async () => {
  const f = fixture(); let runs = 0;
  try {
    const task = await failedAfterReply(f.store); f.store.receiveMessage(message("later"), task.binding);
    const gateway = new Gateway(f.store, { createSession: async () => "unused", run: async () => { runs++; return ended.result; }, inspectRun: async () => ended }, async () => {}, options);
    gateway.setAuthorizationWaiting([message()], "another-flow", true);
    gateway.recoverPendingMessages("lark", "cli");
    await until(() => f.store.inbox.findMessage(message())!.state === "completed");
    assert.equal(runs, 0); assert.equal(f.store.inbox.findMessage(message("later"))!.state, "queued");
    gateway.setAuthorizationWaiting([message()], "another-flow", false);
    await until(() => f.store.inbox.findMessage(message("later"))!.state === "completed");
    assert.equal(runs, 1);
  } finally { f.close(); }
});

test("real Gateway process exit after reply confirmation recovers with GET history and never repeats the first MA call", async () => {
  const f = fixture(); f.store.close();
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import {GatewayStore} from './src/store.ts'; import {Gateway} from './src/gateway.ts';
    const store=new GatewayStore(${JSON.stringify(f.path)});store.acquireRuntimeLock();
    const confirm=store.confirmMessageReply.bind(store);store.confirmMessageReply=(id,result)=>{confirm(id,result);process.exit(0);};
    const gateway=new Gateway(store,{createSession:async()=>"session",run:async(_s,input)=>{process.stdout.write(JSON.stringify({input}));return ${JSON.stringify(ended.result)};}},async()=>{},${JSON.stringify(options)});
    gateway.accept(${JSON.stringify(message())});gateway.accept(${JSON.stringify(message("later"))});
    setTimeout(()=>process.exit(9),2000);
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  const originalInput = JSON.parse(child.stdout).input;
  const store = new GatewayStore(f.path); store.acquireRuntimeLock(); let reads = 0, runs = 0;
  const client = new ArkClient("fake", "https://example.invalid", (async (_url, init) => {
    assert.equal(init?.method || "GET", "GET"); reads++;
    return Response.json({ data: [
      { id: "anchor", type: "user.message", content: [{ type: "text", text: originalInput }] },
      { id: "running", type: "session.status_running" },
      { id: "reply", type: "agent.message", content: [{ type: "text", text: ended.result.messages[0] }] },
      { id: "idle", type: "session.status_idle" }
    ] });
  }) as typeof fetch);
  try {
    assert.equal(store.inbox.findMessage(message())!.state, "dispatched");
    const gateway = new Gateway(store, { createSession: async () => { throw new Error("must reuse"); }, inspectRun: client.inspectRun.bind(client),
      run: async (_s, input) => { assert.ok(input.includes("later")); runs++; return ended.result; } }, async () => {}, options);
    gateway.recoverPendingMessages("lark", "cli");
    await until(() => store.inbox.findMessage(message("later"))?.state === "completed");
    assert.equal(store.inbox.findMessage(message())!.state, "completed");
    assert.equal(reads, 1); assert.equal(runs, 1);
  } finally { store.close(); f.close(); }
});

test("Gateway never confirms delivery when native CardKit returns an HTTP-success business error", async () => {
  const f = fixture();
  const port = { createCard: async () => ({ cardId: "card" }), send: async () => ({ messageId: "reply" }), rawClient: {
    im: { messageResource: { get: async () => { throw new Error("unused"); } } }, cardkit: { v1: {
      cardElement: { content: async () => ({ code: 230001 }) }, card: { settings: async () => ({ code: 0 }) }
    } }
  } } as unknown as LarkChannelPort;
  const adapter = new LarkChannelAdapter({ appId: "cli", appSecret: "secret", channel: port,
    streaming: { intervalMs: 1, printFrequencyMs: 1, printStep: 100, settlePaddingMs: 0 } });
  const gateway = new Gateway(f.store, { createSession: async () => "session", run: async () => ended.result, inspectRun: async () => ended }, async () => {},
    { ...options, streamReply: adapter.streamReply.bind(adapter) });
  try {
    gateway.accept(message()); await until(() => f.store.inbox.findMessage(message())?.state === "uncertain");
    assert.equal(f.store.inbox.findMessage(message())!.replyConfirmed, undefined);
    await gateway.reconcilePendingMessage(message());
    assert.equal(f.store.inbox.findMessage(message())!.state, "uncertain");
  } finally { f.close(); }
});

test("legacy encrypted input remains readable without inventing a reply receipt", () => {
  const f = fixture();
  try {
    const task = f.store.receiveMessage(message(), binding)!;
    const key = JSON.stringify(["lark", "cli", "first"]);
    const context = JSON.stringify(["message-inbox", task.sequence, task.id, key, "lark", "cli", "scope", "agent", "config", "queued", "", 1, null, null, null]);
    const legacy = f.store.credentials.sealAuthorization(JSON.stringify(message()), context);
    f.db.prepare("UPDATE gateway_message_inbox SET secret=? WHERE id=?").run(legacy, task.id);
    assert.deepEqual(f.store.inbox.findMessage(message())!.message, message());
    assert.equal(f.store.inbox.findMessage(message())!.replyConfirmed, undefined);
    f.store.inbox.claim(task.id, binding);
    assert.equal(f.store.inbox.findMessage(message())!.state, "preparing");
    assert.equal(f.store.inbox.findMessage(message())!.replyConfirmed, undefined);
  } finally { f.close(); }
});

test("reconciliation validates the stored Agent even when the Session ID was not changed", async () => {
  const f = fixture(); let inspections = 0;
  try {
    await failedAfterReply(f.store);
    f.store.saveSession(toConversationKey(message(), true), "session", "another-agent");
    const gateway = new Gateway(f.store, { createSession: async () => "unused", run: async () => ended.result,
      inspectRun: async () => { inspections++; return ended; } }, async () => {}, options);
    await gateway.reconcilePendingMessage(message());
    assert.equal(inspections, 0); assert.equal(f.store.inbox.findMessage(message())!.state, "uncertain");
  } finally { f.close(); }
});
