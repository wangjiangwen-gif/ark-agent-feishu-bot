import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Gateway, toConversationKey, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import { baselineCompaction, startCompaction } from "../src/session-compaction.ts";
import type { CompactionObservation, SessionStats } from "../src/ark.ts";

const stats: SessionStats = { eventCount: 200, latestEventId: "e200", latestBusinessEventId: "u5", latestTokenSampleId: "m5", latestInputTokens: 30000, status: "idle" };
function message(id: string, text = "继续"): IncomingMessage {
  return { channelType: "lark", installationId: "app", tenantId: "tenant", conversationId: "chat", conversationType: "direct",
    senderId: "user", messageId: id, eventId: id, text, resources: [], mentionedBot: false, threadId: "", rootMessageId: "", parentMessageId: "", createTime: 100 };
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > end) throw new Error("测试未完成"); await delay(5); }
}
function harness(store: GatewayStore, options: { stats?: () => SessionStats; observation?: () => CompactionObservation; fail?: boolean } = {}) {
  const inputs: string[] = [], replies: string[] = [];
  let creates = 0, inspections = 0;
  const gateway = new Gateway(store, {
    createSession: async () => { creates++; return "new"; },
    getSessionStats: async () => options.stats?.() || stats,
    inspectCompaction: async () => { inspections++; return options.observation?.() || { result: "unknown", terminal: "idle", reason: "missing_completion_evidence" }; },
    run: async (_id, text) => {
      inputs.push(text);
      return { terminal: options.fail && text === "/compact" ? "failed" : "idle", messages: ["完成"] };
    }
  }, async (_message, out) => { if (out.type === "text") replies.push(out.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", authorizedUserId: "user", timeoutMs: 5000, sessionStatsCheckIntervalMs: 0
  });
  return { gateway, inputs, replies, creates: () => creates, inspections: () => inspections };
}

test("legacy high-token Session is reused without an automatic statistics baseline", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  store.saveSession(toConversationKey(message("one")), "session", "agent");
  const h = harness(store); h.gateway.accept(message("one")); await until(() => h.replies.length === 1);
  assert.equal(h.inputs.length, 1); assert.notEqual(h.inputs[0], "/compact");
  assert.equal(store.getCompactionCheckpoint("session"), undefined);
});

test("manual idle without completion proof is unknown, never success or automatic replay", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  store.saveSession(toConversationKey(message("one")), "session", "agent");
  const h = harness(store); h.gateway.accept(message("one", "/compact")); await until(() => h.replies.length === 1);
  assert.match(h.replies[0], /结果尚未确认/);
  assert.equal(store.getCompactionCheckpoint("session")?.attempt?.result, "unknown");
  h.gateway.accept(message("two")); await until(() => h.replies.length === 2);
  assert.equal(h.inputs.filter(input => input === "/compact").length, 1);
  assert.equal(h.inspections(), 1);
  assert.equal(h.creates(), 0);
  h.gateway.accept(message("three", "/compact")); await until(() => h.replies.length === 3);
  assert.equal(h.inputs.filter(input => input === "/compact").length, 2, "已确认idle后，新的手动请求可以重新压缩；不能自动重复");
});

test("unresolved submission blocks business dispatch and compact retransmission", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  store.saveSession(toConversationKey(message("one")), "session", "agent");
  store.saveCompactionCheckpoint("session", startCompaction(baselineCompaction(stats), stats, "old", "automatic", 1));
  const h = harness(store, { observation: () => ({ result: "unknown", reason: "command_not_found" }) });
  h.gateway.accept(message("one")); await until(() => h.replies.length === 1);
  assert.equal(h.inspections(), 1); assert.equal(h.inputs.length, 0); assert.equal(h.creates(), 0);
  assert.match(h.replies[0], /尚未核实/);
});

test("confirmed compaction failure persists across restart without replaying old high-token sample", async t => {
  const directory = mkdtempSync(join(tmpdir(), "arkagent-compact-e2e-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "gateway.db");
  const first = new GatewayStore(path);
  first.saveSession(toConversationKey(message("one")), "session", "agent");
  first.saveCompactionCheckpoint("session", baselineCompaction({ eventCount: 0 }));
  const a = harness(first, { fail: true }); a.gateway.accept(message("one", "/compact")); await until(() => a.replies.length === 1);
  assert.equal(a.inputs[0], "/compact"); assert.equal(a.inputs.length, 1);
  assert.equal(first.getCompactionCheckpoint("session")?.attempt?.result, "failed"); first.close();
  const second = new GatewayStore(path); t.after(() => second.close());
  const checkpoint = second.getCompactionCheckpoint("session")!;
  second.saveCompactionCheckpoint("session", { ...checkpoint, cooldownUntil: 0 });
  const b = harness(second); b.gateway.accept(message("two")); await until(() => b.replies.length === 1);
  assert.equal(b.inputs.length, 1); assert.notEqual(b.inputs[0], "/compact"); assert.equal(b.creates(), 0);
});

test("restarting with an in-flight compact reconciles its failed result before business work", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  store.saveSession(toConversationKey(message("one")), "session", "agent");
  store.saveCompactionCheckpoint("session", startCompaction(baselineCompaction(stats), stats, "old", "automatic", 1));
  const h = harness(store, { observation: () => ({ result: "failed", terminal: "failed", reason: "session_error" }) });
  h.gateway.accept(message("one")); await until(() => h.replies.length === 1);
  assert.equal(h.inspections(), 1); assert.equal(h.inputs.length, 1); assert.notEqual(h.inputs[0], "/compact");
  assert.equal(store.getCompactionCheckpoint("session")?.attempt?.result, "failed");
});

test("no incoming business request means no automatic compaction work", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  store.saveSession(toConversationKey(message("one")), "session", "agent");
  store.saveCompactionCheckpoint("session", baselineCompaction({ eventCount: 0 }));
  const h = harness(store);
  await delay(30);
  assert.deepEqual(h.inputs, []); assert.equal(h.inspections(), 0);
});

test("manual compaction is serialized with subsequent business requests and preserves file mounts", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  store.saveSession(toConversationKey(message("one")), "session", "agent");
  store.markAttachmentMounted("session", "file");
  const inputs: string[] = [], replies: string[] = [];
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const gateway = new Gateway(store, {
    createSession: async () => { throw new Error("不应新建Session"); },
    getSessionStats: async () => stats,
    inspectCompaction: async () => ({ result: "succeeded", terminal: "idle", reason: "thread_context_compacted", evidenceEventId: "proof" }),
    run: async (_id, input) => { inputs.push(input); if (input === "/compact") await wait; return { terminal: "idle", messages: ["完成"] }; }
  }, async (_message, out) => { if (out.type === "text") replies.push(out.text); }, {
    agentId: "agent", environmentId: "env", vaultId: "vault", authorizedUserId: "user", timeoutMs: 5000
  });
  gateway.accept(message("one", "/compact")); await until(() => inputs.length === 1);
  gateway.accept(message("two")); await delay(20);
  assert.equal(inputs.length, 1); release(); await until(() => replies.length === 2);
  assert.equal(inputs.length, 2);
  assert.equal(store.isAttachmentMounted("session", "file"), true);
  assert.equal(store.getSession(toConversationKey(message("two"))), "session");
  assert.equal(store.getCompactionCheckpoint("session")?.attempt?.evidenceEventId, "proof");
});
