import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import test from "node:test";
import { Gateway, toConversationKey, type IncomingMessage, type GatewayOptions } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";

const options: GatewayOptions = { agentId: "agent", environmentId: "env", vaultId: "vault", appId: "cli",
  platformAccess: true, sharedGroupSessions: true, timeoutMs: 1000, progressDelayMs: 10_000 };
const message = (id: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({ channelType: "lark", installationId: "cli",
  tenantId: "tenant", senderId: "user", conversationId: "chat", conversationType: "group", threadId: "", rootMessageId: "",
  parentMessageId: "", messageId: id, eventId: id, text: "读取原文", createTime: 100, resources: [], mentionedBot: true, ...extra });
function key(source: IncomingMessage, resourceId = "inline-file") {
  return createHash("sha256").update(JSON.stringify([source.channelType, source.installationId, source.tenantId,
    source.conversationId, source.messageId, resourceId])).digest("hex");
}
async function until(check: () => boolean) { for (let n = 0; n < 1000 && !check(); n++) await flush(); assert.ok(check()); }
const success = () => ({ terminal: "idle" as const, messages: ["完成"] });
function sourceCase(origin: "current" | "history" | "quote", text = "ORIGINAL_INLINE_SENTINEL") {
  const resource = { id: "inline-file", name: origin === "quote" ? "quote.md" : "text.txt", type: "file" as const };
  const source = message(origin === "current" ? "first" : "source", { resources: [resource], createTime: 50 });
  const incoming = message("first", { ...(origin === "current" ? { resources: [resource] } : {}),
    ...(origin === "quote" ? { parentMessageId: "source" } : {}) });
  const history = { messageId: source.messageId, senderId: source.senderId, senderType: "user" as const,
    text: "历史附件", createTime: 50, resources: [resource] };
  const extra: Partial<GatewayOptions> = {
    loadRecentHistory: async () => origin === "history" ? [history] : [],
    readMessage: async () => ({ status: "available", message: history }),
    downloadAttachment: async () => ({ bytes: new TextEncoder().encode(text), mimeType: "text/plain" })
  };
  return { incoming, source, extra, key: key(source), text };
}

for (const durable of [false, true]) for (const origin of ["current", "history", "quote"] as const) {
  test(`${durable ? "durable" : "default"} ${origin} inline text is not delivered when preparation fails`, async t => {
    const store = new GatewayStore(":memory:"); t.after(() => store.close()); if (durable) store.acquireRuntimeLock();
    const fixture = sourceCase(origin); let replies = 0, runs = 0;
    if (durable) store.inbox.prepare = () => { throw new Error("模拟准备检查点保存失败"); };
    else store.pendingInlineSources = () => { throw new Error("模拟派发前准备失败"); };
    const gateway = new Gateway(store, { createSession: async () => "session", run: async () => { runs++; return success(); } },
      async () => { replies++; }, { ...options, ...fixture.extra, durableQueue: durable });
    gateway.accept(fixture.incoming); await until(() => replies > 0); await flush();
    assert.equal(runs, 0);
    assert.equal(store.isAttachmentMounted("session", fixture.key), false);
  });
  test(`${durable ? "durable" : "default"} ${origin} inline text is marked only after the complete input returns`, async t => {
    const store = new GatewayStore(":memory:"); t.after(() => store.close()); if (durable) store.acquireRuntimeLock();
    const fixture = sourceCase(origin); let replies = 0, observedBeforeReturn: boolean | undefined;
    const gateway = new Gateway(store, { createSession: async () => "session", run: async (_id, input) => {
      observedBeforeReturn = store.isAttachmentMounted("session", fixture.key);
      assert.ok(input.includes(fixture.text)); return success();
    } }, async () => { replies++; }, { ...options, ...fixture.extra, durableQueue: durable });
    gateway.accept(fixture.incoming); await until(() => replies > 0); await flush();
    assert.equal(observedBeforeReturn, false);
    assert.equal(store.isAttachmentMounted("session", fixture.key), true);
  });
}

for (const origin of ["history", "quote"] as const) test(`${origin} inline text omitted by context clipping is never marked delivered`, async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  const fixture = sourceCase(origin, `START_${"x".repeat(12_000)}_END_SENTINEL`); let replies = 0;
  const gateway = new Gateway(store, { createSession: async () => "session", run: async (_id, input) => {
    assert.ok(!input.includes("_END_SENTINEL")); return success();
  } }, async () => { replies++; }, { ...options, ...fixture.extra });
  gateway.accept(fixture.incoming); await until(() => replies > 0); await flush();
  assert.equal(store.isAttachmentMounted("session", fixture.key), false);
});

test("a new message still receives historical inline source after an earlier pre-dispatch failure", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  const fixture = sourceCase("history"); const pending = store.pendingInlineSources.bind(store); let fail = true, replies = 0;
  store.pendingInlineSources = (...args) => { if (fail) { fail = false; throw new Error("模拟准备失败"); } return pending(...args); };
  const inputs: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => "session", run: async (_id, input) => { inputs.push(input); return success(); } },
    async () => { replies++; }, { ...options, ...fixture.extra });
  gateway.accept(fixture.incoming); await until(() => replies === 1);
  gateway.accept(message("second", { createTime: 200 })); await until(() => replies === 2);
  assert.equal(inputs.length, 1); assert.ok(inputs[0].includes(fixture.text));
  assert.ok(!inputs[0].includes("此前消息中提供"));
});

test("restoration keeps budget-omitted inline sources pending for the next turn", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  store.saveSession(toConversationKey(message("first"), true), "session", "agent");
  for (const name of ["a", "b"]) {
    store.saveAttachment(name, { name: `${name}.txt`, bytes: 180_000, inlineText: `${name.toUpperCase()}_${"x".repeat(179_998)}`, mountPath: `/mnt/data/${name}` });
    store.markAttachmentMounted("session", name);
  }
  store.requestInlineRestore("session"); let replies = 0; const inputs: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => { assert.fail("不可创建Session"); },
    run: async (_id, input) => { inputs.push(input); return success(); } }, async () => { replies++; }, options);
  gateway.accept(message("first")); await until(() => replies === 1);
  assert.equal(store.pendingInlineSources("session").length, 1);
  gateway.accept(message("second", { createTime: 200 })); await until(() => replies === 2);
  assert.equal(store.pendingInlineSources("session").length, 0);
  assert.ok(inputs.some(input => input.includes("A_xxx")) && inputs.some(input => input.includes("B_xxx")));
});

test("a failed MA turn does not clear inline restoration or confirm inline delivery", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close()); const fixture = sourceCase("current");
  store.saveAttachment("restore", { name: "old.txt", bytes: 3, inlineText: "OLD", mountPath: "/mnt/data/old" });
  store.markAttachmentMounted("session", "restore"); store.requestInlineRestore("session"); let replies = 0;
  const gateway = new Gateway(store, { createSession: async () => "session", run: async () => ({ terminal: "failed", messages: [] }) },
    async () => { replies++; }, { ...options, ...fixture.extra });
  gateway.accept(fixture.incoming); await until(() => replies > 0); await flush();
  assert.equal(store.isAttachmentMounted("session", fixture.key), false);
  assert.equal(store.pendingInlineSources("session").length, 1);
});

test("inline delivery keys survive an actual ready-process exit and are confirmed only after recovery", async t => {
  const dir = mkdtempSync(join(tmpdir(), "ark-inline-ready-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db"), fixture = sourceCase("current"), restoreKey = "f".repeat(64);
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    import { Gateway } from ${JSON.stringify(new URL("../src/gateway.ts", import.meta.url).href)};
    const store=new GatewayStore(${JSON.stringify(path)}); store.acquireRuntimeLock();
    store.saveAttachment(${JSON.stringify(restoreKey)}, {name:'previous.md',bytes:3,inlineText:'OLD',mountPath:'/mnt/data/old'});
    store.markAttachmentMounted('session',${JSON.stringify(restoreKey)}); store.requestInlineRestore('session');
    store.dispatchMessage=()=>process.exit(77);
    new Gateway(store,{createSession:async()=> 'session',run:async()=>{throw Error('不能提前派发');}},async()=>{},
      {...${JSON.stringify(options)},durableQueue:true,downloadAttachment:async()=>({bytes:new TextEncoder().encode('ORIGINAL_INLINE_SENTINEL'),mimeType:'text/plain'})}
    ).accept(${JSON.stringify(fixture.incoming)});
    setTimeout(()=>process.exit(99),3000);
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 77, child.stderr);
  const store = new GatewayStore(path); t.after(() => store.close()); store.acquireRuntimeLock();
  const saved = store.inbox.findMessage(fixture.incoming)!;
  assert.deepEqual(new Set(saved.preparation!.inlineDeliveryKeys), new Set([fixture.key, restoreKey]));
  assert.equal(store.isAttachmentMounted("session", fixture.key), false);
  assert.equal(store.pendingInlineSources("session").length, 1);
  const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建"); },
    inspectSessionReadiness: async sessionId => ({ status: "idle", sessionId, agentId: "agent" }),
    run: async (_id, input) => {
      assert.equal(input, saved.preparation!.input); assert.equal(store.isAttachmentMounted("session", fixture.key), false); return success();
    } }, async () => {}, { ...options, durableQueue: true, downloadAttachment: async () => { assert.fail("不能重新下载"); } });
  gateway.recoverPendingMessages("lark", "cli"); await gateway.reconcilePendingMessage(fixture.incoming);
  await until(() => store.inbox.findMessage(fixture.incoming)?.state === "completed");
  assert.equal(store.isAttachmentMounted("session", fixture.key), true);
  assert.equal(store.pendingInlineSources("session").length, 0);
});

test("legacy inline mount markers never suppress the full cached source in a new quote", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close()); const fixture = sourceCase("quote");
  store.saveSession(toConversationKey(fixture.incoming, true), "session", "agent");
  store.saveAttachment(fixture.key, { name: "quote.md", bytes: fixture.text.length, inlineText: fixture.text, mountPath: "/mnt/data/quote.md" });
  store.markAttachmentMounted("session", fixture.key); let replies = 0; const inputs: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => { assert.fail("不能重建"); },
    run: async (_id, input) => { inputs.push(input); return success(); } }, async () => { replies++; },
  { ...options, ...fixture.extra, downloadAttachment: async () => { assert.fail("应复用缓存"); } });
  gateway.accept(fixture.incoming); await until(() => replies === 1);
  assert.ok(inputs[0].includes(fixture.text)); assert.ok(!inputs[0].includes("此前消息中提供"));
});

test("only explicitly delivered restore keys are cleared across database reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-inline-restore-")); const path = join(dir, "gateway.db");
  let store = new GatewayStore(path);
  try {
    for (const name of ["a", "b"]) {
      store.saveAttachment(name, { name, bytes: 1, inlineText: name, mountPath: `/mnt/data/${name}` }); store.markAttachmentMounted("session", name);
    }
    store.requestInlineRestore("session"); assert.equal(store.pendingInlineSources("session").length, 2);
    store.completeInlineRestore("session", ["a"]); store.close(); store = new GatewayStore(path);
    assert.deepEqual(store.pendingInlineSources("session").map(source => source.key), ["b"]);
    store.completeInlineRestore("session"); assert.equal(store.pendingInlineSources("session").length, 1);
    store.requestInlineRestore("session"); assert.equal(store.pendingInlineSources("session").length, 2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
