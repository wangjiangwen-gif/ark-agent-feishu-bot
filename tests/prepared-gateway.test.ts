import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as flush } from "node:timers/promises";
import { Gateway, toConversationKey, type IncomingMessage, type GatewayOptions } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";

const options: GatewayOptions = { agentId: "agent", environmentId: "env", vaultId: "bot-vault", appId: "cli",
  platformAccess: true, sharedGroupSessions: true, durableQueue: true, timeoutMs: 1000 };
const message = (id: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({ channelType: "lark", installationId: "cli",
  tenantId: "tenant", senderId: "user", conversationId: "chat", conversationType: "direct", threadId: "", rootMessageId: "",
  parentMessageId: "", messageId: id, eventId: id, text: id, createTime: 100, resources: [], mentionedBot: false, ...extra });
const first = message("first");
const done = () => ({ terminal: "idle" as const, messages: ["done"] });
async function until(check: () => boolean) { for (let n = 0; n < 200 && !check(); n++) await flush(); assert.ok(check()); }
function fixture() { const dir = mkdtempSync(join(tmpdir(), "ark-prepared-")); return { path: join(dir, "gateway.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) }; }

function exitDuringPreparation(path: string, incoming = first, setup = "", phase: "ready" | "dispatched" | "before_ready" = "ready") {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    import { Gateway } from ${JSON.stringify(new URL("../src/gateway.ts", import.meta.url).href)};
    const store = new GatewayStore(${JSON.stringify(path)}); store.acquireRuntimeLock();
    const dispatch = store.dispatchMessage.bind(store);
    store.dispatchMessage = (...args) => { if (${JSON.stringify(phase)} === 'dispatched') dispatch(...args); process.exit(77); };
    if (${JSON.stringify(phase)} === 'before_ready') store.inbox.prepare = () => process.exit(77);
    let extra = {};
    ${setup}
    const gateway = new Gateway(store, { createSession: async () => ${JSON.stringify(incoming.conversationId === first.conversationId ? "original-session" : `session-${incoming.conversationId}`)},
      uploadFile: async name => ({ id: 'uploaded-file', name }), addSessionFile: async () => {},
      run: async () => { throw new Error('不能提前派发'); } }, async () => {}, { ...${JSON.stringify(options)}, ...extra });
    gateway.accept(${JSON.stringify(incoming)});
    setTimeout(() => process.exit(99), 3000);
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 77, child.stderr);
}

test("ready input survives a real process exit and resumes once without preparation side effects", async () => {
  const files = fixture(); exitDuringPreparation(files.path);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock();
  let calls = 0, inspections = 0, hooks = 0; const runs: string[] = [];
  try {
    const saved = store.inbox.findMessage(first)!;
    assert.ok(saved.preparation); assert.equal(saved.sessionId, undefined);
    const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建"); },
      inspectSessionReadiness: async (sessionId) => { inspections++; return { status: "idle", sessionId, agentId: "agent" }; },
      run: async (session, input) => { assert.equal(session, "original-session"); calls++; runs.push(input); return done(); }
    }, async () => {}, { ...options, beforeCreateSession: async () => { hooks++; } });
    gateway.recoverPendingMessages("lark", "cli"); gateway.recoverPendingMessages("lark", "cli");
    await Promise.all([gateway.reconcilePendingMessage(first), gateway.reconcilePendingMessage(first)]);
    await until(() => store.inbox.findMessage(first)?.state === "completed");
    assert.deepEqual(runs, [saved.preparation!.input]); assert.equal(calls, 1); assert.equal(inspections, 1); assert.equal(hooks, 1);
  } finally { store.close(); files.cleanup(); }
});

test("ready group input preserves historical TXT, quoted Markdown and current PDF after restart", async () => {
  const files = fixture();
  const incoming = message("files", { conversationType: "group", mentionedBot: true, parentMessageId: "quoted",
    resources: [{ type: "file", id: "pdf-id", name: "sample.pdf" }] });
  const history = [
    { messageId: "txt", senderId: "alice", senderType: "user", text: "文件", createTime: 80, resources: [{ type: "file", id: "txt-id", name: "history.txt" }] },
    { messageId: "quoted", senderId: "bob", senderType: "user", text: "引用文件", createTime: 90, resources: [{ type: "file", id: "md-id", name: "quote.md" }] }
  ];
  exitDuringPreparation(files.path, incoming, `extra = {
    loadRecentHistory: async () => ${JSON.stringify(history)},
    downloadAttachment: async resource => ({ bytes: new TextEncoder().encode(resource.id === 'pdf-id' ? '%PDF-fixture' : '原文内容-' + resource.id), mimeType: resource.id === 'pdf-id' ? 'application/pdf' : 'text/plain' })
  };`);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock();
  try {
    const saved = store.inbox.findMessage(incoming)!; assert.ok(saved.preparation);
    assert.match(saved.preparation!.input, /原文内容-txt-id/); assert.match(saved.preparation!.input, /原文内容-md-id/);
    assert.match(saved.preparation!.input, /\/mnt\/session\/uploads/);
    const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建"); },
      uploadFile: async () => { assert.fail("不能重传"); }, addSessionFile: async () => { assert.fail("不能重复挂载"); },
      inspectSessionReadiness: async (sessionId) => ({ status: "idle", sessionId, agentId: "agent" }),
      run: async (_s, input) => { assert.equal(input, saved.preparation!.input); return done(); }
    }, async () => {}, { ...options, loadRecentHistory: async () => { assert.fail("不能用重启后的群历史替换输入"); },
      readMessage: async () => { assert.fail("不能重读引用"); }, downloadAttachment: async () => { assert.fail("不能重新下载"); } });
    gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(incoming);
    await until(() => store.inbox.findMessage(incoming)?.state === "completed");
    for (const receipt of saved.preparation!.contextReceipts) assert.equal(store.contextFingerprint("original-session", receipt.id), receipt.fingerprint);
    assert.equal(store.getConversationContextCursor(toConversationKey(incoming, true), "original-session"), 100);
  } finally { store.close(); files.cleanup(); }
});

for (const phase of ["before_ready", "dispatched"] as const) test(`${phase} exit never replays preparation or MA requests`, async () => {
  const files = fixture(); exitDuringPreparation(files.path, first, "", phase);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock(); let runs = 0;
  try {
    const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建"); },
      run: async () => { runs++; return done(); }, inspectSessionReadiness: async (sessionId) => ({ status: "idle", sessionId, agentId: "agent" }),
      inspectRun: async () => ({ status: "unknown", reason: "history_unavailable" }) }, async () => {}, options);
    gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(first);
    await until(() => store.inbox.findMessage(first)?.state === "uncertain");
    assert.equal(runs, 0); assert.equal(store.inbox.findMessage(first)!.state, "uncertain");
  } finally { store.close(); files.cleanup(); }
});

for (const status of ["running", "upgrading", "failed", "unknown", "unavailable"] as const) test(`ready task remains paused when MA is ${status}`, async () => {
  const files = fixture(); exitDuringPreparation(files.path);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock(); let runs = 0;
  try {
    const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建"); }, run: async () => { runs++; return done(); },
      inspectSessionReadiness: async (sessionId) => { if (status === "unavailable") throw new Error("offline"); return { status, sessionId, agentId: "agent" }; }
    }, async () => {}, options);
    gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(first);
    assert.equal(runs, 0); assert.equal(store.inbox.findMessage(first)!.state, "uncertain");
  } finally { store.close(); files.cleanup(); }
});

for (const change of ["config", "session", "during_inspection"] as const) test(`ready task cannot resume after ${change} binding change`, async () => {
  const files = fixture(); exitDuringPreparation(files.path);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock(); let runs = 0;
  try {
    if (change === "session") store.saveSession(toConversationKey(first, true), "replacement", "agent");
    const gateway = new Gateway(store, { createSession: async () => "must-not-create", run: async () => { runs++; return done(); },
      inspectSessionReadiness: async (sessionId) => {
        if (change === "during_inspection") store.saveSession(toConversationKey(first, true), "replacement", "agent");
        return { status: "idle", sessionId, agentId: "agent" };
      }
    }, async () => {}, { ...options, ...(change === "config" ? { environmentId: "changed" } : {}) });
    gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(first);
    assert.equal(runs, 0); assert.equal(store.inbox.findMessage(first)!.state, "uncertain");
  } finally { store.close(); files.cleanup(); }
});

test("ready recovery holds same-scope FIFO while another conversation proceeds", async () => {
  const files = fixture(); exitDuringPreparation(files.path);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), runs: string[] = [];
  try {
    const saved = store.inbox.findMessage(first)!;
    const gateway = new Gateway(store, { createSession: async () => "independent", inspectSessionReadiness: async (sessionId) => ({ status: "idle", sessionId, agentId: "agent" }),
      run: async (_s, input) => { runs.push(input); if (input === saved.preparation!.input) await gate; return done(); }
    }, async () => {}, options);
    gateway.recoverPendingMessages("lark", "cli");
    const second = message("second"), other = message("other", { conversationId: "other-chat" });
    gateway.accept(second); gateway.accept(other);
    await until(() => store.inbox.findMessage(other)?.state === "completed");
    assert.equal(store.inbox.findMessage(second)!.state, "queued");
    release(); await until(() => store.inbox.findMessage(second)?.state === "completed");
    assert.equal(runs.filter(input => input === saved.preparation!.input).length, 1);
    assert.ok(runs.findIndex(input => input.includes("second")) > runs.indexOf(saved.preparation!.input));
  } finally { release(); await flush(); store.close(); files.cleanup(); }
});

test("Store rolls back preparation claim if its paired event update fails", () => {
  const files = fixture(); exitDuringPreparation(files.path);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock();
  const db = new DatabaseSync(files.path);
  try {
    const task = store.recoverMessages("lark", "cli").interrupted[0];
    db.exec("CREATE TRIGGER deny_resume BEFORE UPDATE ON processed_events WHEN NEW.status='processing' BEGIN SELECT RAISE(ABORT, 'fixture update failure'); END");
    assert.throws(() => store.claimPreparedMessage(task, task.binding), /fixture update failure/);
    assert.deepEqual(store.inbox.findMessage(first), task);
    assert.deepEqual({ ...db.prepare("SELECT status, dispatched FROM processed_events").get() }, { status: "uncertain", dispatched: 0 });
  } finally { db.close(); store.close(); files.cleanup(); }
});

test("recovery revalidates Session after direct credential hook without running a stale input", async () => {
  const files = fixture(); exitDuringPreparation(files.path);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock(); let runs = 0;
  try {
    const gateway = new Gateway(store, { createSession: async () => "must-not-create", run: async () => { runs++; return done(); },
      inspectSessionReadiness: async (sessionId) => ({ status: "idle", sessionId, agentId: "agent" })
    }, async () => {}, { ...options, beforeDirectTurn: async () => { store.saveSession(toConversationKey(first, true), "replacement", "agent"); } });
    gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(first);
    assert.equal(runs, 0); assert.equal(store.inbox.findMessage(first)!.state, "uncertain");
    assert.ok(store.inbox.findMessage(first)!.preparation);
  } finally { store.close(); files.cleanup(); }
});

test("existing Session and developer hook are not recreated when a ready task resumes", async () => {
  const files = fixture();
  const hook = "async (_message, request) => ({ ...request, metadata: { ready_hook: true } })";
  exitDuringPreparation(files.path, first, `store.saveSession(${JSON.stringify(toConversationKey(first, true))}, 'existing', 'agent');
    extra = { buildSessionRequest: ${hook}, sessionConfigurationRevision: 'hook-v1' };`);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock(); let calls = 0;
  try {
    const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建"); }, inspectSessionReadiness: async (sessionId) => ({ status: "idle", sessionId, agentId: "agent" }),
      run: async session => { assert.equal(session, "existing"); calls++; return done(); }
    }, async () => {}, { ...options, sessionConfigurationRevision: "hook-v1", buildSessionRequest: async () => { assert.fail("不能重跑hook"); } });
    gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(first);
    await until(() => store.inbox.findMessage(first)?.state === "completed"); assert.equal(calls, 1);
  } finally { store.close(); files.cleanup(); }
});

test("prepared group recovery refreshes Bot credentials before calling MA", async () => {
  const files = fixture(); const group = message("group", { conversationType: "group", mentionedBot: true });
  exitDuringPreparation(files.path, group);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock(); let refreshed = false, runs = 0;
  try {
    const gateway = new Gateway(store, { createSession: async () => "must-not-create", inspectSessionReadiness: async (sessionId) => ({ status: "idle", sessionId, agentId: "agent" }),
      run: async () => { assert.equal(refreshed, true); runs++; return done(); }
    }, async () => {}, { ...options, beforeCreateSession: async () => { refreshed = true; } });
    gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(group);
    await until(() => store.inbox.findMessage(group)?.state === "completed"); assert.equal(runs, 1);
  } finally { store.close(); files.cleanup(); }
});

test("a slow restored task does not serialize restoration of a different chat", async () => {
  const files = fixture(); const other = message("other", { conversationId: "other-chat" });
  exitDuringPreparation(files.path); exitDuringPreparation(files.path, other);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock();
  let release!: () => void; const gate = new Promise<void>(yes => { release = yes; });
  try {
    const saved = store.inbox.findMessage(first)!.preparation!;
    const gateway = new Gateway(store, { createSession: async () => "must-not-create", inspectSessionReadiness: async (sessionId) => ({ status: "idle", sessionId, agentId: "agent" }),
      run: async (_s, input) => { if (input === saved.input) await gate; return done(); }
    }, async () => {}, options);
    gateway.recoverPendingMessages("lark", "cli");
    await until(() => store.inbox.findMessage(other)?.state === "completed");
    assert.equal(store.inbox.findMessage(first)!.state, "dispatched");
    release(); await until(() => store.inbox.findMessage(first)?.state === "completed");
  } finally { release(); await flush(); store.close(); files.cleanup(); }
});

for (const pauseAt of ["inspection", "credential_hook"] as const) test(`new authorization pause during ${pauseAt} prevents prepared dispatch`, async () => {
  const files = fixture(); exitDuringPreparation(files.path);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock(); let runs = 0, gateway: Gateway;
  try {
    gateway = new Gateway(store, { createSession: async () => "must-not-create", run: async () => { runs++; return done(); },
      inspectSessionReadiness: async (sessionId) => { if (pauseAt === "inspection") gateway.setAuthorizationWaiting([first], "new-flow", true); return { status: "idle", sessionId, agentId: "agent" }; }
    }, async () => {}, { ...options, beforeDirectTurn: async () => { if (pauseAt === "credential_hook") gateway.setAuthorizationWaiting([first], "new-flow", true); } });
    gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(first); await flush();
    assert.equal(runs, 0); assert.equal(store.inbox.findMessage(first)!.state, "uncertain");
    assert.ok(store.inbox.findMessage(first)!.preparation);
  } finally { store.close(); files.cleanup(); }
});

test("explicit prepared recovery can recheck an idle Session after the startup check found it running", async () => {
  const files = fixture(); exitDuringPreparation(files.path);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock(); let idle = false, runs = 0;
  try {
    const gateway = new Gateway(store, { createSession: async () => "must-not-create", run: async () => { runs++; return done(); },
      inspectSessionReadiness: async (sessionId) => ({ status: idle ? "idle" : "running", sessionId, agentId: "agent" }) }, async () => {}, options);
    gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(first);
    const item = gateway.listRecoveryTasks("lark", "cli").items[0];
    assert.equal(item.preparationReady, true); assert.equal(item.sessionId, "original-session");
    await assert.rejects(gateway.controlRecoveryTask("lark", "cli", item.id, item.revision, "reconcile"), /派发证据/);
    await assert.rejects(gateway.controlRecoveryTask("lark", "cli", item.id, item.revision, "resume_prepared"), /尚未安全领取/);
    assert.equal(runs, 0); idle = true;
    await gateway.controlRecoveryTask("lark", "cli", item.id, item.revision, "resume_prepared");
    await until(() => store.inbox.findMessage(first)?.state === "completed"); assert.equal(runs, 1);
    await assert.rejects(gateway.controlRecoveryTask("lark", "cli", item.id, item.revision, "resume_prepared"), /版本或状态/);
  } finally { store.close(); files.cleanup(); }
});

test("prepared recovery lookup times out and aborts without dispatching", async t => {
  const files = fixture(); exitDuringPreparation(files.path);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock(); let signal: AbortSignal | undefined;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const gateway = new Gateway(store, { createSession: async () => "must-not-create", run: async () => { assert.fail("不能派发"); },
      inspectSessionReadiness: async (_s, abort) => { signal = abort; return new Promise(() => {}); }
    }, async () => {}, options);
    gateway.recoverPendingMessages("lark", "cli"); const pending = gateway.reconcilePendingMessage(first);
    await until(() => Boolean(signal)); t.mock.timers.tick(5001); await pending;
    assert.equal(signal!.aborted, true); assert.equal(store.inbox.findMessage(first)!.state, "uncertain");
  } finally { t.mock.timers.reset(); store.close(); files.cleanup(); }
});

for (const mismatch of ["session", "agent", "missing_agent"] as const) test(`idle readiness with ${mismatch} mismatch cannot resume a prepared task`, async () => {
  const files = fixture(); exitDuringPreparation(files.path);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock(); let runs = 0;
  try {
    const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建"); }, run: async () => { runs++; return done(); },
      inspectSessionReadiness: async sessionId => ({ status: "idle", sessionId: mismatch === "session" ? "different-session" : sessionId,
        agentId: mismatch === "missing_agent" ? undefined : mismatch === "agent" ? "different-agent" : "agent" })
    }, async () => {}, options);
    gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(first);
    assert.equal(runs, 0); assert.equal(store.inbox.findMessage(first)!.state, "uncertain");
  } finally { store.close(); files.cleanup(); }
});

test("prepared recovery never substitutes historical idle events for current Session readiness", async () => {
  const files = fixture(); exitDuringPreparation(files.path);
  const store = new GatewayStore(files.path); store.acquireRuntimeLock(); let stats = 0;
  try {
    const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建"); }, run: async () => { assert.fail("不能派发"); },
      getSessionStats: async () => { stats++; return { status: "idle", eventCount: 10 }; }
    }, async () => {}, options);
    gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(first);
    assert.equal(stats, 0); assert.equal(store.inbox.findMessage(first)!.state, "uncertain");
  } finally { store.close(); files.cleanup(); }
});
