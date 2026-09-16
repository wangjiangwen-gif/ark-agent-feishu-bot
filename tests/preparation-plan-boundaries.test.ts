import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { Gateway, toConversationKey, type IncomingMessage, type GatewayOptions } from "../src/gateway.ts";
import type { ChannelHistoryMessage } from "../src/channel.ts";
import { GatewayStore } from "../src/store.ts";
import { requestEnvironmentId } from "../src/session-config.ts";

const options: GatewayOptions = { agentId: "agent", environmentId: "env", vaultId: "bot-vault", platformAccess: true,
  sharedGroupSessions: true, durableQueue: true, timeoutMs: 1000, progressDelayMs: 60000,
  sessionConfigurationRevision: "preparation-fixture-v1" };
const message = (extra: Partial<IncomingMessage> = {}): IncomingMessage => ({ channelType: "lark", installationId: "cli",
  tenantId: "tenant", senderId: "user", conversationId: "chat", conversationType: "group", threadId: "", rootMessageId: "",
  parentMessageId: "", messageId: "trigger", eventId: "event", text: "结合历史与引用回答", createTime: 100,
  resources: [], mentionedBot: true, ...extra });
const done = () => ({ terminal: "idle" as const, messages: ["done"] });
const readiness = async (sessionId: string) => ({ status: "idle" as const, sessionId, agentId: "agent" });
function proof(query: any) {
  return { status: "confirmed" as const, sessionId: "session", operationId: query.operationId, requestFingerprint: query.requestFingerprint,
    agentId: query.agentId, environmentId: requestEnvironmentId(query.request)!, sessionStatus: "idle", checkedAt: Date.now() };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await flush();
  assert.ok(check(), "原持久化任务应完成，不能把暂停当作通过");
}
function fixture(t: { after: (callback: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "ark-preparation-boundary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "gateway.db");
}

function exitBeforeReady(path: string, incoming: IncomingMessage, setup = "", phase: "sources" | "snapshot" | "intent" | "confirmed" | "creation_complete" | "context_complete" | "hook" = "sources") {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    import { Gateway, toConversationKey } from ${JSON.stringify(new URL("../src/gateway.ts", import.meta.url).href)};
    const store=new GatewayStore(${JSON.stringify(path)}); store.acquireRuntimeLock();
    const incoming=${JSON.stringify(incoming)};
    const counts={history:0,quote:0,download:0,upload:0,mount:0,vault:0,environment:0,hook:0,create:0};
    const quit=()=>{console.log(JSON.stringify(counts));process.exit(77);};
    if (['sources','creation_complete','context_complete'].includes(${JSON.stringify(phase)})) {
      const complete=store.inbox.completePreparationStep.bind(store.inbox);
      store.inbox.completePreparationStep=(...args)=>{const saved=complete(...args);
        if(args[2]===({sources:'inline-restore',creation_complete:'session-create',context_complete:'context'})[${JSON.stringify(phase)}])quit();return saved;};
    }
    if (${JSON.stringify(phase)}==='snapshot') store.pendingInlineSources=quit;
    if (${JSON.stringify(phase)}==='intent') {
      const begin=store.beginSessionCreation.bind(store);
      store.beginSessionCreation=(value)=>{begin(value);quit();};
    }
    if (${JSON.stringify(phase)}==='confirmed') {
      const confirm=store.confirmSessionCreation.bind(store);
      store.confirmSessionCreation=(...args)=>{confirm(...args);quit();};
    }
    let extra={}; ${setup}
    if (${JSON.stringify(phase)}==='hook') extra.buildSessionRequest=async()=>{counts.hook++;quit();};
    const gateway=new Gateway(store,{createSession:async()=>{counts.create++;return 'session';},
      uploadFile:async name=>{counts.upload++;return {id:'uploaded-'+name,name};},
      addSessionFile:async()=>{counts.mount++;},run:async()=>{throw Error('不能提前派发');}
    },async()=>{},{...${JSON.stringify(options)},...extra});
    gateway.accept(incoming);setTimeout(()=>process.exit(99),3000);
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 77, child.stderr);
  return JSON.parse(child.stdout.trim().split("\n").at(-1)!) as Record<string, number>;
}

function reopen(t: { after: (callback: () => void) => void }, path: string) {
  const store = new GatewayStore(path); store.acquireRuntimeLock(); t.after(() => store.close()); return store;
}
async function recover(gateway: Gateway, incoming: IncomingMessage) {
  gateway.recoverPendingMessages("lark", "cli");
  await gateway.reconcilePendingMessage(incoming); await flush();
}

test("durable pre-ready recovery preserves completed history and quote observations", async t => {
  const path = fixture(t), incoming = message({ parentMessageId: "quoted" });
  const counts = exitBeforeReady(path, incoming, `extra={
    loadRecentHistory:async()=>{counts.history++;return [{messageId:'history',senderId:'alice',senderType:'user',createTime:80,text:'原始群记录'}];},
    readMessage:async()=>{counts.quote++;return {status:'available',message:{messageId:'quoted',senderId:'bob',senderType:'user',createTime:90,text:'原始引用'}};}
  };`);
  assert.equal(counts.history, 1); assert.equal(counts.quote, 1);
  const store = reopen(t, path); let reads = 0, quotes = 0, creates = 0; const inputs: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => { creates++; return "wrong-session"; },
    inspectSessionReadiness: readiness, inspectSessionCreation: async query => proof(query),
    run: async (id, input) => { assert.equal(id, "session"); inputs.push(input); return done(); }
  }, async () => {}, { ...options,
    loadRecentHistory: async () => { reads++; return [{ messageId: "history", senderId: "alice", senderType: "user", createTime: 80,
      updateTime: 200, text: "触发消息之后改写的群记录" }]; },
    readMessage: async () => { quotes++; return { status: "available", message: { messageId: "quoted", senderId: "bob",
      senderType: "user", createTime: 90, updateTime: 200, text: "触发消息之后改写的引用" } }; }
  });
  await recover(gateway, incoming); await until(() => store.inbox.findMessage(incoming)?.state === "completed");
  assert.deepEqual({ reads, quotes, creates }, { reads: 0, quotes: 0, creates: 0 });
  assert.equal(inputs.length, 1); assert.match(inputs[0], /原始群记录/); assert.match(inputs[0], /原始引用/);
  assert.doesNotMatch(inputs[0], /触发消息之后改写/);
});

test("durable pre-ready recovery does not select a ninth historical attachment after eight mounts", async t => {
  const path = fixture(t), incoming = message();
  const history: ChannelHistoryMessage[] = Array.from({ length: 9 }, (_, index) => ({ messageId: `history-${index}`,
    senderId: "alice", senderType: "user", createTime: 10 + index, text: `附件 ${index}`,
    resources: [{ type: "file", id: `file-${index}`, name: `file-${index}.pdf` }] }));
  const counts = exitBeforeReady(path, incoming, `extra={loadRecentHistory:async()=>${JSON.stringify(history)},
    downloadAttachment:async()=>{counts.download++;return {bytes:new TextEncoder().encode('%PDF-fixture'),mimeType:'application/pdf'};}};`);
  assert.equal(counts.upload, 8); assert.equal(counts.mount, 8);
  const store = reopen(t, path); let uploads = 0, mounts = 0, reads = 0; const inputs: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建"); }, inspectSessionReadiness: readiness,
    inspectSessionCreation: async query => proof(query), uploadFile: async name => { uploads++; return { id: name, name }; },
    addSessionFile: async () => { mounts++; }, run: async (_id, input) => { inputs.push(input); return done(); }
  }, async () => {}, { ...options, loadRecentHistory: async () => { reads++; return structuredClone(history); },
    downloadAttachment: async () => ({ bytes: new TextEncoder().encode("%PDF-fixture"), mimeType: "application/pdf" }) });
  await recover(gateway, incoming); await until(() => store.inbox.findMessage(incoming)?.state === "completed");
  assert.deepEqual({ uploads, mounts, reads }, { uploads: 0, mounts: 0, reads: 0 });
  assert.equal(inputs.length, 1); assert.match(inputs[0], /最多处理 8 个历史附件/);
});

test("a pending developer hook remains paused without rerunning resource or Vault selection", async t => {
  const path = fixture(t), incoming = message({ conversationType: "direct", mentionedBot: false });
  const counts = exitBeforeReady(path, incoming, `extra={getUserVaultIds:async()=>{counts.vault++;return ['user-vault'];},
    sessionEnvironment:()=>{counts.environment++;return {FIXTURE_SELECTION:'original'};}};`, "hook");
  assert.equal(counts.hook, 1); assert.equal(counts.create, 0);
  const store = reopen(t, path); let hooks = 0, vaults = 0, environments = 0, creates = 0, runs = 0;
  const gateway = new Gateway(store, { createSession: async () => { creates++; return "session"; }, inspectSessionReadiness: readiness,
    run: async () => { runs++; return done(); }
  }, async () => {}, { ...options, getUserVaultIds: async () => { vaults++; return ["different-vault"]; },
    sessionEnvironment: () => { environments++; return { FIXTURE_SELECTION: "different" }; },
    buildSessionRequest: async (_message, request) => { hooks++; return request; } });
  await recover(gateway, incoming);
  assert.equal(store.inbox.findMessage(incoming)!.state, "uncertain");
  assert.deepEqual({ hooks, vaults, environments, creates, runs }, { hooks: 0, vaults: 0, environments: 0, creates: 0, runs: 0 });
});

test("a pending local snapshot remains paused without rereading mutable database state", async t => {
  const path = fixture(t), incoming = message(); exitBeforeReady(path, incoming, "", "snapshot");
  const store = reopen(t, path); let snapshots = 0, runs = 0;
  const original = store.pendingInlineSources.bind(store);
  store.pendingInlineSources = id => { snapshots++; return original(id); };
  const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建"); }, inspectSessionReadiness: readiness,
    inspectSessionCreation: async query => proof(query), run: async () => { runs++; return done(); }
  }, async () => {}, options);
  await recover(gateway, incoming);
  assert.equal(store.inbox.findMessage(incoming)!.state, "uncertain"); assert.deepEqual({ snapshots, runs }, { snapshots: 0, runs: 0 });
});

test("completed developer selections and a pending creation intent resume with the original request", async t => {
  const path = fixture(t), incoming = message({ conversationType: "direct", mentionedBot: false });
  const counts = exitBeforeReady(path, incoming, `extra={getUserVaultIds:async()=>{counts.vault++;return ['user-vault'];},
    sessionEnvironment:()=>{counts.environment++;return {FIXTURE_SELECTION:'original'};},
    buildSessionRequest:async(_message,request)=>{counts.hook++;return {...request,metadata:{resource:'original'}};}};`, "intent");
  assert.equal(counts.hook, 1); assert.equal(counts.create, 0);
  const store = reopen(t, path); let hooks = 0, vaults = 0, environments = 0, creates = 0, queries = 0, runs = 0;
  const gateway = new Gateway(store, { createSession: async () => { creates++; return "wrong-session"; }, inspectSessionReadiness: readiness,
    inspectSessionCreation: async query => { queries++; assert.deepEqual(query.request.vault_ids, ["bot-vault", "user-vault"]);
      assert.equal((query.request.metadata as any).resource, "original"); return proof(query); },
    run: async id => { assert.equal(id, "session"); runs++; return done(); }
  }, async () => {}, { ...options, getUserVaultIds: async () => { vaults++; return ["different-vault"]; },
    sessionEnvironment: () => { environments++; return { FIXTURE_SELECTION: "different" }; },
    buildSessionRequest: async (_message, request) => { hooks++; return { ...request, metadata: { resource: "changed" } }; } });
  await recover(gateway, incoming); await until(() => store.inbox.findMessage(incoming)?.state === "completed");
  assert.deepEqual({ hooks, vaults, environments, creates, runs }, { hooks: 0, vaults: 0, environments: 0, creates: 0, runs: 1 });
  assert.ok(queries >= 1);
});

for (const change of ["configuration", "session", "during_inspection"] as const)
test(`pre-ready recovery refuses ${change} changes without starting business`, async t => {
  const path = fixture(t), incoming = message(); exitBeforeReady(path, incoming);
  const store = reopen(t, path); let runs = 0, creates = 0;
  const key = toConversationKey(incoming, true);
  if (change === "session") store.saveSession(key, "replacement", "agent");
  const gateway = new Gateway(store, { createSession: async () => { creates++; return "wrong-session"; },
    inspectSessionReadiness: async id => { if (change === "during_inspection") store.saveSession(key, "replacement", "agent"); return readiness(id); },
    inspectSessionCreation: async query => { if (change === "during_inspection") store.saveSession(key, "replacement", "agent"); return proof(query); },
    run: async () => { runs++; return done(); }
  }, async () => {}, { ...options, ...(change === "configuration" ? { environmentId: "changed-env" } : {}) });
  await recover(gateway, incoming);
  assert.deepEqual({ runs, creates }, { runs: 0, creates: 0 });
  assert.equal(store.inbox.findMessage(incoming)!.state, "uncertain");
  if (change !== "configuration") assert.equal(store.getSession(key), "replacement");
});

test("completed attachment preparation retains its inline budget after process restart", async t => {
  const path = fixture(t), incoming = message({ resources: [{ type: "file", id: "current", name: "current.txt" }] });
  exitBeforeReady(path, incoming, `store.saveSession(toConversationKey(incoming,true),'session','agent');
    store.saveAttachment('restore-source',{name:'old.txt',bytes:120000,inlineText:'RESTORE_ONLY_'+ 'r'.repeat(119987),mountPath:'/mnt/data/old.txt'});
    store.markAttachmentMounted('session','restore-source');store.requestInlineRestore('session');
    extra={downloadAttachment:async()=>{counts.download++;return {bytes:new TextEncoder().encode('CURRENT_ONLY_'+'c'.repeat(179987)),mimeType:'text/plain'};}};`);
  const store = reopen(t, path); let downloads = 0; const inputs: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建"); }, inspectSessionReadiness: readiness,
    inspectSessionCreation: async query => proof(query), run: async (_id, input) => { inputs.push(input); return done(); }
  }, async () => {}, { ...options, downloadAttachment: async () => { downloads++; throw new Error("不能重下载"); } });
  await recover(gateway, incoming); await until(() => store.inbox.findMessage(incoming)?.state === "completed");
  assert.equal(downloads, 0); assert.equal(inputs.length, 1); assert.match(inputs[0], /CURRENT_ONLY_/);
  assert.doesNotMatch(inputs[0], /RESTORE_ONLY_/);
  assert.ok(store.pendingInlineSources("session").some(source => source.key === "restore-source"));
});

for (const target of ["new", "existing"] as const)
test(`current PDF preparation keeps its original mounted state for ${target} Session recovery`, async t => {
  const path = fixture(t), incoming = message({ resources: [{ type: "file", id: "current", name: "current.pdf" }] });
  const counts = exitBeforeReady(path, incoming, `
    ${target === "existing" ? "store.saveSession(toConversationKey(incoming,true),'session','agent');" : ""}
    extra={downloadAttachment:async()=>{counts.download++;return {bytes:new TextEncoder().encode('%PDF-fixture'),mimeType:'application/pdf'};}};`);
  assert.equal(counts.create, target === "new" ? 1 : 0); assert.equal(counts.upload, 1);
  assert.equal(counts.mount, target === "existing" ? 1 : 0);
  const store = reopen(t, path); let creates = 0, uploads = 0, mounts = 0, downloads = 0; const inputs: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => { creates++; return "wrong-session"; },
    inspectSessionReadiness: readiness, inspectSessionCreation: async query => proof(query),
    uploadFile: async name => { uploads++; return { id: name, name }; }, addSessionFile: async () => { mounts++; },
    run: async (id, input) => { assert.equal(id, "session"); inputs.push(input); return done(); }
  }, async () => {}, { ...options, downloadAttachment: async () => { downloads++; throw Error("不能重新下载"); } });
  await recover(gateway, incoming); await until(() => store.inbox.findMessage(incoming)?.state === "completed");
  assert.deepEqual({ creates, uploads, mounts, downloads }, { creates: 0, uploads: 0, mounts: 0, downloads: 0 });
  assert.equal(inputs.length, 1); assert.match(inputs[0], /\/mnt\/session\/uploads\/mnt\/data\/[^\n]*current\.pdf/);
  assert.doesNotMatch(inputs[0], /未能挂载|未能读取/);
});

test("creation confirmed before its plan checkpoint restores the same Session and PDF without new writes", async t => {
  const path = fixture(t), incoming = message({ resources: [{ type: "file", id: "current", name: "current.pdf" }] });
  const counts = exitBeforeReady(path, incoming, `extra={downloadAttachment:async()=>{counts.download++;
    return {bytes:new TextEncoder().encode('%PDF-fixture'),mimeType:'application/pdf'};}};`, "confirmed");
  assert.equal(counts.create, 1); assert.equal(counts.upload, 1);
  const store = reopen(t, path); let creates = 0, uploads = 0, mounts = 0, runs = 0;
  const gateway = new Gateway(store, { createSession: async () => { creates++; return "wrong-session"; },
    inspectSessionReadiness: readiness, inspectSessionCreation: async query => proof(query),
    uploadFile: async name => { uploads++; return { id: name, name }; }, addSessionFile: async () => { mounts++; },
    run: async (id, input) => { assert.equal(id, "session"); assert.match(input, /current\.pdf/); runs++; return done(); }
  }, async () => {}, { ...options, downloadAttachment: async () => { assert.fail("不能重新下载"); } });
  await recover(gateway, incoming); await until(() => store.inbox.findMessage(incoming)?.state === "completed");
  assert.deepEqual({ creates, uploads, mounts, runs }, { creates: 0, uploads: 0, mounts: 0, runs: 1 });
});

test("a completed creation with its local mapping removed cannot prepare more files on the old Session", async t => {
  const path = fixture(t), incoming = message();
  exitBeforeReady(path, incoming, `extra={loadRecentHistory:async()=>[{messageId:'history',senderId:'alice',senderType:'user',
    createTime:80,text:'文件',resources:[{type:'file',id:'historical-pdf',name:'history.pdf'}]}]};`, "creation_complete");
  const store = reopen(t, path); store.resetSession(toConversationKey(incoming, true));
  let reads = 0, downloads = 0, uploads = 0, mounts = 0, runs = 0;
  const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建"); }, inspectSessionReadiness: readiness,
    inspectSessionCreation: async query => proof(query), uploadFile: async name => { uploads++; return { id: "unexpected-upload", name }; },
    addSessionFile: async () => { mounts++; }, run: async () => { runs++; return done(); }
  }, async () => {}, { ...options, loadRecentHistory: async () => { reads++; return []; },
    downloadAttachment: async () => { downloads++; return { bytes: new TextEncoder().encode("%PDF-fixture"), mimeType: "application/pdf" }; } });
  await recover(gateway, incoming); await until(() => store.inbox.findMessage(incoming)?.state === "uncertain");
  assert.deepEqual({ reads, downloads, uploads, mounts, runs }, { reads: 0, downloads: 0, uploads: 0, mounts: 0, runs: 0 },
    "原Session映射消失后不能仅跳过模型派发；附件准备写入也必须停止");
});

for (const pauseAt of ["inspection", "after_claim"] as const)
test(`authorization pause during ${pauseAt} stops pre-ready recovery before model dispatch`, async t => {
  const path = fixture(t), incoming = message({ conversationType: "direct", mentionedBot: false }); exitBeforeReady(path, incoming);
  const store = reopen(t, path); let runs = 0, paused = false, gateway: Gateway;
  const pause = () => { paused = true; gateway.setAuthorizationWaiting([incoming], "new-flow", true); };
  if (pauseAt === "after_claim") {
    const begin = store.inbox.beginPreparationStep.bind(store.inbox);
    store.inbox.beginPreparationStep = (...args) => {
      const saved = begin(...args);
      if (args[2].id === "inline-restore") pause();
      return saved;
    };
  }
  gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建"); },
    inspectSessionReadiness: async id => { if (pauseAt === "inspection") pause(); return readiness(id); },
    inspectSessionCreation: async query => { if (pauseAt === "inspection") pause(); return proof(query); },
    run: async () => { runs++; return done(); }
  }, async () => {}, options);
  await recover(gateway, incoming);
  assert.equal(paused, true, "用例应实际进入暂停注入点"); assert.equal(runs, 0);
  assert.equal(store.inbox.findMessage(incoming)!.state, "uncertain");
});

test("adding a credential callback after restart does not change a frozen preparation plan", async t => {
  const path = fixture(t), incoming = message({ conversationType: "direct", mentionedBot: false }); exitBeforeReady(path, incoming);
  const store = reopen(t, path); let hooks = 0, runs = 0;
  const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建"); }, inspectSessionReadiness: readiness,
    inspectSessionCreation: async query => proof(query), run: async () => { runs++; return done(); }
  }, async () => {}, { ...options, beforeDirectTurn: async () => { hooks++; } });
  await recover(gateway, incoming);
  assert.deepEqual({ hooks, runs }, { hooks: 0, runs: 0 }); assert.equal(store.inbox.findMessage(incoming)!.state, "uncertain");
});

test("partial direct dual-identity preparation stays paused without an authorization generation proof", async t => {
  const path = fixture(t), incoming = message({ conversationType: "direct", mentionedBot: false });
  exitBeforeReady(path, incoming, "extra={dualIdentity:true};");
  const store = reopen(t, path); let runs = 0, reads = 0;
  const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建"); },
    inspectSessionReadiness: async id => { reads++; return readiness(id); },
    run: async () => { runs++; return done(); }
  }, async () => {}, { ...options, dualIdentity: true });
  await recover(gateway, incoming);
  assert.equal(store.inbox.findMessage(incoming)!.state, "uncertain"); assert.deepEqual({ runs, reads }, { runs: 0, reads: 0 });
});

for (const hook of ["beforeCreateSession", "beforeDirectTurn", "getUserVaultIds", "sessionEnvironment", "buildSessionRequest"] as const)
test(`unstarted ${hook} without a configuration revision remains paused after context is frozen`, async t => {
  const path = fixture(t), incoming = message({ conversationType: "direct", mentionedBot: false });
  const callbacks = {
    beforeCreateSession: "async()=>{counts.hook++;}",
    beforeDirectTurn: "async()=>{counts.hook++;}",
    getUserVaultIds: "async()=>{counts.hook++;return ['user-vault'];}",
    sessionEnvironment: "()=>{counts.hook++;return {FIXTURE:'original'};}",
    buildSessionRequest: "async(_message,request)=>{counts.hook++;return request;}"
  };
  const counts = exitBeforeReady(path, incoming, `extra={sessionConfigurationRevision:undefined,${hook}:${callbacks[hook]}};`, "context_complete");
  assert.equal(counts.hook, 0); assert.equal(counts.create, 0);
  const store = reopen(t, path); let calls = 0, creates = 0, runs = 0;
  const config: GatewayOptions = { ...options, sessionConfigurationRevision: undefined };
  if (hook === "beforeCreateSession") config.beforeCreateSession = async () => { calls++; };
  if (hook === "beforeDirectTurn") config.beforeDirectTurn = async () => { calls++; };
  if (hook === "getUserVaultIds") config.getUserVaultIds = async () => { calls++; return ["user-vault"]; };
  if (hook === "sessionEnvironment") config.sessionEnvironment = () => { calls++; return { FIXTURE: "changed" }; };
  if (hook === "buildSessionRequest") config.buildSessionRequest = async (_message, request) => { calls++; return request; };
  const gateway = new Gateway(store, { createSession: async () => { creates++; return "session"; }, inspectSessionReadiness: readiness,
    run: async () => { runs++; return done(); }
  }, async () => {}, config);
  await recover(gateway, incoming); await until(() => store.inbox.findMessage(incoming)?.state === "uncertain");
  assert.deepEqual({ calls, creates, runs }, { calls: 0, creates: 0, runs: 0 });
});
