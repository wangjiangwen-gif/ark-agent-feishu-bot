import test from "node:test";
import assert from "node:assert/strict";
import { Gateway, toConversationKey, type IncomingMessage, type GatewayOptions } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import { configFingerprint, requestEnvironmentId } from "../src/session-config.ts";
import { ArkHttpError } from "../src/ark.ts";

const options: GatewayOptions = { agentId: "agent", environmentId: "env", vaultId: "vault", platformAccess: true,
  sharedGroupSessions: true, timeoutMs: 1000, progressDelayMs: 60000 };
const message = (id: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({ channelType: "lark", installationId: "cli",
  tenantId: "tenant", senderId: "user", conversationId: "chat", conversationType: "group", threadId: "", rootMessageId: "",
  parentMessageId: "", messageId: id, eventId: id, text: id, createTime: 100, resources: [], mentionedBot: true, ...extra });
const done = () => ({ terminal: "idle" as const, messages: ["done"] });
const process = (gateway: Gateway, incoming: IncomingMessage) => (gateway as any).process(incoming, toConversationKey(incoming, true));
const scope = (store: GatewayStore, incoming: IncomingMessage) => store.conversationKey(toConversationKey(incoming, true));
function proof(query: any, sessionId = "original-session") {
  return { status: "confirmed" as const, sessionId, operationId: query.operationId, requestFingerprint: query.requestFingerprint,
    agentId: query.agentId, environmentId: requestEnvironmentId(query.request), sessionStatus: "idle", checkedAt: Date.now() };
}

test("creation response loss blocks a second POST and recovers the uniquely proven Session", async () => {
  const store = new GatewayStore(":memory:"); let posts = 0, builds = 0, queries = 0; const runs: string[] = [];
  let observedRequest: any;
  const gateway = new Gateway(store, { createSession: async request => { posts++; observedRequest = request; throw new Error("response lost"); },
    inspectSessionCreation: async query => { queries++; return proof(query); },
    run: async id => { runs.push(id); return done(); }
  }, async () => {}, { ...options, buildSessionRequest: async (_message, request) => { builds++; return request; } });
  try {
    await assert.rejects(process(gateway, message("first")), /response lost/);
    const pending = store.sessionCreations.pending(scope(store, message("first")))!;
    assert.ok(pending); assert.deepEqual(pending.request, observedRequest);
    assert.equal(observedRequest.tags.length, 2);
    await process(gateway, message("second"));
    assert.equal(posts, 1); assert.equal(builds, 1); assert.equal(queries, 1);
    assert.deepEqual(runs, ["original-session"]);
    assert.equal(store.sessionCreations.get(pending.operationId)!.state, "confirmed");
  } finally { store.close(); }
});

test("a local confirmation failure never reissues the original creation", async () => {
  const store = new GatewayStore(":memory:"); let posts = 0;
  const confirm = store.confirmSessionCreation.bind(store);
  store.confirmSessionCreation = () => { throw new Error("disk failure"); };
  const gateway = new Gateway(store, { createSession: async () => { posts++; return "original-session"; },
    inspectSessionCreation: async query => proof(query), run: async () => done()
  }, async () => {}, options);
  try {
    await assert.rejects(process(gateway, message("first")), /disk failure/);
    assert.equal(store.getSession(toConversationKey(message("first"), true)), undefined);
    store.confirmSessionCreation = confirm;
    await process(gateway, message("second"));
    assert.equal(posts, 1);
  } finally { store.close(); }
});

for (const kind of ["missing", "unknown", "wrong_operation", "wrong_hash", "wrong_agent", "wrong_environment", "stale", "running"])
test(`unresolved creation (${kind}) cannot trigger setup, attachments or model dispatch`, async () => {
  const store = new GatewayStore(":memory:"); let posts = 0, setups = 0, downloads = 0, runs = 0;
  const ark: any = { createSession: async () => { posts++; throw new Error("lost"); }, run: async () => { runs++; return done(); } };
  if (kind !== "missing") ark.inspectSessionCreation = async (query: any) => {
    const result: any = proof(query);
    if (kind === "unknown") return { status: "unknown", reason: "not_found" };
    if (kind === "wrong_operation") result.operationId = "other";
    if (kind === "wrong_hash") result.requestFingerprint = configFingerprint({});
    if (kind === "wrong_agent") result.agentId = "other";
    if (kind === "wrong_environment") result.environmentId = "other";
    if (kind === "stale") result.checkedAt -= 60000;
    if (kind === "running") result.sessionStatus = "running";
    return result;
  };
  const gateway = new Gateway(store, ark, async () => {}, { ...options, beforeCreateSession: async () => { setups++; },
    downloadAttachment: async () => { downloads++; return { bytes: new Uint8Array([1]), mimeType: "application/pdf" }; } });
  try {
    await assert.rejects(process(gateway, message("first")), /lost/);
    await assert.rejects(process(gateway, message("second", { resources: [{ type: "file", id: "file", name: "a.pdf" }] })), /创建|核查|空闲/);
    assert.equal(posts, 1); assert.equal(setups, 1); assert.equal(downloads, 0); assert.equal(runs, 0);
  } finally { store.close(); }
});

test("new and changed configuration cannot bypass an unresolved creation", async () => {
  const store = new GatewayStore(":memory:"); let posts = 0, queries = 0;
  const ark: any = { createSession: async () => { posts++; throw new Error("lost"); }, run: async () => done(),
    inspectSessionCreation: async (query: any) => { queries++; return proof(query); } };
  try {
    await assert.rejects(process(new Gateway(store, ark, async () => {}, options), message("first")), /lost/);
    await assert.rejects(process(new Gateway(store, ark, async () => {}, options), message("reset", { text: "/new" })), /创建/);
    await assert.rejects(process(new Gateway(store, ark, async () => {}, { ...options, environmentId: "other-env" }), message("next")), /配置|绑定/);
    assert.equal(posts, 1); assert.equal(queries, 0);
  } finally { store.close(); }
});

test("normal confirmed creation permits an explicit new conversation", async () => {
  const store = new GatewayStore(":memory:"); let posts = 0;
  try {
    const gateway = new Gateway(store, { createSession: async () => `session-${++posts}`, run: async () => done() }, async () => {}, options);
    await process(gateway, message("first")); await process(gateway, message("reset", { text: "/new" }));
    await process(gateway, message("second")); assert.equal(posts, 2);
  } finally { store.close(); }
});

test("a definitive invalid parameter response permits a corrected configuration without querying or retrying automatically", async () => {
  const store = new GatewayStore(":memory:"); let posts = 0;
  try {
    const gateway = new Gateway(store, { createSession: async () => { posts++; throw new ArkHttpError("invalid", 400, "InvalidParameter"); },
      run: async () => { assert.fail("不能执行被拒绝的创建"); } }, async () => {}, options);
    await assert.rejects(process(gateway, message("first")), /invalid/);
    assert.equal(posts, 1);
    assert.equal(store.sessionCreations.pending(scope(store, message("first"))), undefined);
    assert.equal(store.sessionCreations.latest(scope(store, message("first")))!.state, "rejected");
    const corrected = new Gateway(store, { createSession: async () => { posts++; return "corrected-session"; },
      run: async () => done() }, async () => {}, { ...options, environmentId: "corrected-env" });
    await process(corrected, message("second")); assert.equal(posts, 2);
  } finally { store.close(); }
});

for (const isolated of [false, true]) test(`changing from ${isolated ? "isolated" : "shared"} mode cannot bypass the same pending creation`, async () => {
  const store = new GatewayStore(":memory:"); let posts = 0;
  const ark = { createSession: async () => { posts++; throw new Error("lost"); }, run: async () => done() };
  try {
    await assert.rejects(process(new Gateway(store, ark, async () => {}, { ...options, perMessageSessions: isolated }), message("first")), /lost/);
    await assert.rejects(process(new Gateway(store, ark, async () => {}, { ...options, perMessageSessions: !isolated }), message("first")), /会话模式/);
    assert.equal(posts, 1);
  } finally { store.close(); }
});

for (const error of [new ArkHttpError("invalid", 400, "OtherError"), new ArkHttpError("invalid", 500, "InvalidParameter"),
  new Error("400 InvalidParameter")]) test(`unverified rejection ${error.name}/${(error as any).status || "none"} stays pending`, async () => {
  const store = new GatewayStore(":memory:"); let posts = 0;
  try {
    const gateway = new Gateway(store, { createSession: async () => { posts++; throw error; }, run: async () => done() }, async () => {}, options);
    await assert.rejects(process(gateway, message("first")));
    assert.equal(store.sessionCreations.pending(scope(store, message("first")))!.state, "pending");
    await assert.rejects(process(gateway, message("second")), /核查/); assert.equal(posts, 1);
  } finally { store.close(); }
});
