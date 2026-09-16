import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as flush } from "node:timers/promises";
import { Gateway, toConversationKey, type IncomingMessage, type GatewayOptions } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import { requestEnvironmentId } from "../src/session-config.ts";

const options: GatewayOptions = { agentId: "agent", environmentId: "env", vaultId: "vault", platformAccess: true,
  sharedGroupSessions: true, perMessageSessions: true, timeoutMs: 1000, progressDelayMs: 60_000 };
const message = (id: string): IncomingMessage => ({ channelType: "lark", installationId: "cli", tenantId: "tenant", senderId: "user",
  conversationId: "chat", conversationType: "group", threadId: "", rootMessageId: "", parentMessageId: "", messageId: id,
  eventId: id, text: id, createTime: 100, resources: [], mentionedBot: true });
const runProcess = (gateway: Gateway, incoming: IncomingMessage) => (gateway as any).process(incoming, toConversationKey(incoming, true));
const done = () => ({ terminal: "idle" as const, messages: ["done"] });
async function until(check: () => boolean) { for (let i = 0; i < 1000 && !check(); i++) await flush(); assert.ok(check()); }
function proof(query: any, sessionId = "confirmed-session") {
  return { status: "confirmed" as const, sessionId, operationId: query.operationId, requestFingerprint: query.requestFingerprint,
    agentId: query.agentId, environmentId: requestEnvironmentId(query.request)!, sessionStatus: "idle", checkedAt: Date.now() };
}

test("independent isolated messages can create sessions concurrently in one group", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  let posts = 0, release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const runs: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => {
    const id = `session-${++posts}`; if (posts === 1) await barrier; return id;
  }, run: async id => { runs.push(id); return done(); } }, async () => {}, options);
  const first = runProcess(gateway, message("first")); await until(() => posts === 1);
  const second = runProcess(gateway, message("second")).then(() => true, () => false);
  await flush(); release(); await first;
  assert.equal(await second, true, "同群的另一条独立消息不能被前一个独立Session的创建意图阻挡");
  assert.equal(posts, 2); assert.equal(runs.length, 2);
});

for (const isolated of [false, true]) test(`${isolated ? "isolated" : "shared"} confirmed creation survives exit before ready without another POST`, async t => {
  const dir = mkdtempSync(join(tmpdir(), "ark-create-boundary-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db"), incoming = message("first"), config = { ...options, perMessageSessions: isolated };
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    import { Gateway, toConversationKey } from ${JSON.stringify(new URL("../src/gateway.ts", import.meta.url).href)};
    const store=new GatewayStore(${JSON.stringify(path)});
    store.pendingInlineSources=()=>process.exit(77);
    const gateway=new Gateway(store,{createSession:async()=> 'confirmed-session',run:async()=>{throw Error('不能派发');}},async()=>{},${JSON.stringify(config)});
    gateway.process(${JSON.stringify(incoming)},toConversationKey(${JSON.stringify(incoming)},true));
    setTimeout(()=>process.exit(99),3000);
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 77, child.stderr);
  const store = new GatewayStore(path); t.after(() => store.close()); let posts = 0; const runs: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => { posts++; return "duplicate-session"; },
    inspectSessionCreation: async query => proof(query),
    run: async id => { runs.push(id); return done(); } }, async () => {}, config);
  await runProcess(gateway, incoming);
  assert.equal(posts, 0, "已确认的同一消息创建回执必须复用，不能仅查pending创建意图");
  assert.deepEqual(runs, ["confirmed-session"]);
});

test("an isolated creation is recoverable without overwriting an older reusable mapping", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close()); const incoming = message("first");
  store.saveSession(toConversationKey(incoming, true), "older-shared-session", "agent");
  let posts = 0; const runs: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => { posts++; throw new Error("response lost"); },
    inspectSessionCreation: async query => ({ status: "confirmed", sessionId: "isolated-session", operationId: query.operationId,
      requestFingerprint: query.requestFingerprint, agentId: query.agentId, environmentId: requestEnvironmentId(query.request)!,
      sessionStatus: "idle", checkedAt: Date.now() }),
    run: async id => { runs.push(id); return done(); }
  }, async () => {}, options);
  await assert.rejects(runProcess(gateway, incoming), /response lost/);
  await runProcess(gateway, incoming);
  assert.equal(posts, 1); assert.deepEqual(runs, ["isolated-session"]);
  assert.equal(store.getSession(toConversationKey(incoming, true)), "older-shared-session");
});

for (const isolated of [false, true]) test(`${isolated ? "isolated" : "shared"} creation recovery rejects a mapping changed during inspection`, async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close()); const incoming = message("first");
  const key = toConversationKey(incoming, true); let posts = 0, runs = 0;
  if (isolated) store.saveSession(key, "older-shared-session", "agent");
  const gateway = new Gateway(store, { createSession: async () => { posts++; throw new Error("response lost"); },
    inspectSessionCreation: async query => { store.saveSession(key, "replacement-session", "agent"); return proof(query); },
    run: async () => { runs++; return done(); }
  }, async () => {}, { ...options, perMessageSessions: isolated });
  await assert.rejects(runProcess(gateway, incoming), /response lost/);
  await assert.rejects(runProcess(gateway, incoming), /创建|核查|绑定/);
  assert.equal(posts, 1); assert.equal(runs, 0);
  assert.equal(store.getSession(key), "replacement-session");
  assert.equal(store.sessionCreations.pending(store.sessionCreationScope(key, !isolated, incoming.messageId))!.state, "pending");
});

test("confirmed isolated creation rejects a different Session returned by inspection", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close()); const incoming = message("first");
  let posts = 0, runs = 0;
  const sources = store.pendingInlineSources.bind(store);
  store.pendingInlineSources = () => { throw new Error("before ready failure"); };
  const gateway = new Gateway(store, { createSession: async () => { posts++; return "confirmed-session"; },
    inspectSessionCreation: async query => proof(query, "different-session"), run: async () => { runs++; return done(); }
  }, async () => {}, options);
  await assert.rejects(runProcess(gateway, incoming), /before ready failure/);
  store.pendingInlineSources = sources;
  await assert.rejects(runProcess(gateway, incoming), /原Session回执不符/);
  assert.equal(posts, 1); assert.equal(runs, 0);
  const record = store.sessionCreations.latest(store.sessionCreationScope(toConversationKey(incoming, true), false, incoming.messageId))!;
  assert.equal(record.state, "confirmed"); assert.equal(record.sessionId, "confirmed-session");
});

test("public accept retries a failed message with another event id without repeating an unknown creation", async t => {
  const dir = mkdtempSync(join(tmpdir(), "ark-create-accept-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db"), store = new GatewayStore(path), db = new DatabaseSync(path);
  t.after(() => { db.close(); store.close(); });
  const incoming = message("first"); let posts = 0, queries = 0, runs = 0, hooks = 0, resolved = false;
  const gateway = new Gateway(store, { createSession: async () => { posts++; throw new Error("response lost"); },
    inspectSessionCreation: async query => { queries++; return resolved ? proof(query) : { status: "unknown", reason: "not_found" }; },
    run: async () => { runs++; return done(); }
  }, async () => {}, { ...options, beforeCreateSession: async () => { hooks++; } });
  const status = () => (db.prepare("SELECT status FROM processed_events").get() as { status: string } | undefined)?.status;
  const expireRetryDelay = () => db.prepare("UPDATE processed_events SET updated_at=?").run(new Date(Date.now() - 3000).toISOString());
  assert.equal(gateway.accept(incoming), true); await until(() => status() === "failed"); await flush();
  assert.equal(gateway.accept({ ...incoming, eventId: "another-event" }), false);
  expireRetryDelay();
  assert.equal(gateway.accept({ ...incoming, eventId: "another-event" }), true); await until(() => status() === "failed"); await flush();
  assert.deepEqual({ posts, queries, runs, hooks }, { posts: 1, queries: 1, runs: 0, hooks: 1 });
  resolved = true; expireRetryDelay();
  assert.equal(gateway.accept({ ...incoming, eventId: "third-event" }), true); await until(() => status() === "completed"); await flush();
  assert.deepEqual({ posts, queries, runs, hooks }, { posts: 1, queries: 2, runs: 1, hooks: 2 });
});

test("durable recovery before ready only confirms creation and leaves the original task paused", async t => {
  const dir = mkdtempSync(join(tmpdir(), "ark-create-durable-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db"), incoming = message("first"), config = {
    ...options, perMessageSessions: false, durableQueue: true, sessionConfigurationRevision: "creation-boundary-v1"
  };
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    import { Gateway } from ${JSON.stringify(new URL("../src/gateway.ts", import.meta.url).href)};
    const store=new GatewayStore(${JSON.stringify(path)}); store.acquireRuntimeLock();
    const gateway=new Gateway(store,{createSession:async()=>process.exit(77),run:async()=>{throw Error('不能派发');}},async()=>{},${JSON.stringify(config)});
    gateway.accept(${JSON.stringify(incoming)});
    setTimeout(()=>process.exit(99),3000);
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 77, child.stderr);
  const store = new GatewayStore(path); store.acquireRuntimeLock(); t.after(() => store.close());
  let queries = 0, posts = 0, runs = 0, hooks = 0, history = 0, builds = 0;
  const gateway = new Gateway(store, { createSession: async () => { posts++; return "duplicate-session"; },
    inspectSessionCreation: async query => { queries++; return proof(query); }, run: async () => { runs++; return done(); }
  }, async () => {}, { ...config, beforeCreateSession: async () => { hooks++; },
    loadRecentHistory: async () => { history++; return []; },
    buildSessionRequest: async (_message, request) => { builds++; return request; }
  });
  gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(incoming);
  const record = store.sessionCreations.latest(store.sessionCreationScope(toConversationKey(incoming, true), true, incoming.messageId))!;
  assert.equal(record.state, "confirmed"); assert.equal(record.sessionId, "confirmed-session");
  assert.equal(store.getSession(toConversationKey(incoming, true)), "confirmed-session");
  const task = store.inbox.findMessage(incoming)!;
  assert.equal(task.state, "uncertain"); assert.equal(task.interruptedAt, "preparing"); assert.equal(task.preparation, undefined);
  assert.equal(task.sessionId, undefined); assert.equal(task.dispatchId, undefined); assert.equal(task.requestFingerprint, undefined);
  assert.equal(gateway.accept(message("next")), true); await flush(); await flush();
  assert.equal(store.inbox.findMessage(message("next"))!.state, "queued");
  assert.deepEqual({ queries, posts, runs, hooks, history, builds }, { queries: 1, posts: 0, runs: 0, hooks: 0, history: 0, builds: 0 });
});
