import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Gateway, toConversationKey, type IncomingMessage, type GatewayOptions } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import { baselineCompaction } from "../src/session-compaction.ts";

function message(id: string, group = false, threadId = "", text = "继续") : IncomingMessage {
  return { channelType: "lark", installationId: "app", tenantId: "tenant", conversationId: "chat",
    conversationType: group ? "group" : "direct", senderId: "user", messageId: id, eventId: id,
    text, resources: [], mentionedBot: group, threadId, rootMessageId: "", parentMessageId: "", createTime: 100 };
}
async function until(done: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!done()) { if (Date.now() > deadline) throw new Error("测试超时"); await delay(5); }
}

for (const mode of ["direct", "group", "thread"] as const) test(`${mode}: new session and its next turns never auto-compact`, async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  const reset = message("reset", mode !== "direct", mode === "thread" ? "thread" : "", "/new");
  const key = toConversationKey(reset, true);
  store.saveSession(key, "old", "agent");
  const inputs: string[] = [], replies: string[] = []; let creates = 0;
  const gateway = new Gateway(store, {
    createSession: async () => { creates++; return "new"; },
    getSessionStats: async () => { throw new Error("普通对话不应查询压缩阈值"); },
    run: async (sid, input) => { assert.equal(sid, "new"); inputs.push(input); return { terminal: "idle", messages: ["ok"] }; }
  }, async (_m, out) => { if (out.type === "text") replies.push(out.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 1000, platformAccess: true, sharedGroupSessions: true,
    sessionCompaction: { maxInputTokens: 1, maxEvents: 1 }
  });
  gateway.accept(reset); await until(() => replies.length === 1);
  for (let i = 0; i < 2; i++) {
    gateway.accept({ ...reset, messageId: `turn-${i}`, eventId: `turn-${i}`, text: "继续" });
    await until(() => replies.length === i + 2);
  }
  assert.equal(creates, 1); assert.equal(inputs.length, 2); assert.equal(inputs.includes("/compact"), false);
  assert.equal(store.getSession(key), "new");
});

for (const mode of ["assistant", "direct", "group", "thread"] as const) {
  for (const configured of [false, true]) test(`${mode}: ordinary high-context turns never request compact (legacy settings=${configured})`, async t => {
    const store = new GatewayStore(":memory:"); t.after(() => store.close());
    const first = message("one", mode === "group" || mode === "thread", mode === "thread" ? "thread" : "");
    const key = toConversationKey(first, true);
    store.saveSession(key, "session", "agent");
    store.saveCompactionCheckpoint("session", baselineCompaction({ eventCount: 0 }));
    let stats = 0, creates = 0; const inputs: string[] = [], replies: string[] = [];
    const legacy: Partial<GatewayOptions> = configured ? {
      sessionCompaction: { maxInputTokens: 1, maxEvents: 1 }, sessionRotation: { maxInputTokens: 1 }, sessionStatsCheckIntervalMs: 0
    } : {};
    const gateway = new Gateway(store, {
      createSession: async () => { creates++; return "unexpected"; },
      getSessionStats: async () => { stats++; return { eventCount: 10000, latestEventId: "idle", latestInputTokens: 200000,
        latestTokenSampleId: "model", latestBusinessEventId: "business", status: "idle" }; },
      inspectCompaction: async () => ({ result: "succeeded", terminal: "idle", reason: "thread_context_compacted", evidenceEventId: "proof" }),
      run: async (_session, input) => { inputs.push(input); return { terminal: "idle", messages: ["完成"] }; }
    }, async (_msg, out) => { if (out.type === "text") replies.push(out.text); }, {
      agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, authorizedUserId: "user",
      platformAccess: mode !== "assistant", sharedGroupSessions: true, ...legacy
    });
    gateway.accept(first); await until(() => replies.length === 1);
    gateway.accept({ ...first, messageId: "two", eventId: "two" }); await until(() => replies.length === 2);
    assert.equal(stats, 0, "普通消息不得为阈值判定额外读取MA历史");
    assert.equal(inputs.length, 2); assert.equal(inputs.includes("/compact"), false);
    assert.equal(creates, 0); assert.equal(store.getSession(key), "session");
    assert.equal(store.listAuditLogs().some(row => row.action === "session_compact"), false);
  });
}

for (const command of ["/compact", " /Compact ", "/COMPACT"]) test(`explicit ${command.trim()} is normalized and sent once`, async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  const request = message("command", true, "thread", command);
  store.saveSession(toConversationKey(request, true), "session", "agent");
  const inputs: string[] = [], replies: string[] = [];
  const gateway = new Gateway(store, {
    createSession: async () => { throw new Error("不应创建会话"); },
    getSessionStats: async () => ({ eventCount: 3, latestEventId: "idle", status: "idle" }),
    inspectCompaction: async () => ({ result: "succeeded", terminal: "idle", reason: "thread_context_compacted", evidenceEventId: "proof" }),
    run: async (session, input) => { assert.equal(session, "session"); inputs.push(input); return { terminal: "idle", messages: [] }; }
  }, async (_msg, out) => { if (out.type === "text") replies.push(out.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, platformAccess: true, sharedGroupSessions: true
  });
  gateway.accept({ ...request, mentionedBot: false }); await delay(15);
  assert.deepEqual(inputs, []);
  gateway.accept({ ...request, eventId: "mentioned", messageId: "mentioned" }); await until(() => replies.length === 1);
  gateway.accept({ ...request, eventId: "mentioned", messageId: "mentioned" }); await delay(15);
  assert.deepEqual(inputs, ["/compact"]);
  assert.match(replies[0], /已完成上下文压缩/);
  assert.equal(store.getCompactionCheckpoint("session")?.attempt?.source, "manual");
});
