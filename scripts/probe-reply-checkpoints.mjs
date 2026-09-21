// 仅测本地SQLite检查点开销；飞书/MA均不联网，不作为真实端到端延迟。
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { GatewayStore } from "../src/store.ts";
import { LarkChannelAdapter } from "../src/lark-channel.ts";

const dir = mkdtempSync(join(tmpdir(), "ark-reply-bench-"));
const store = new GatewayStore(join(dir, "gateway.db")); store.acquireRuntimeLock();
const body = "本地模拟回复内容。".repeat(200);
const message = { channelType: "lark", installationId: "cli", tenantId: "tenant", senderId: "user", conversationId: "chat",
  conversationType: "direct", threadId: "", rootMessageId: "", parentMessageId: "", eventId: "", messageId: "", createTime: 1, text: "question", resources: [], mentionedBot: false };
const binding = { scope: "scope", agentId: "agent", configFingerprint: "config" };
const result = { terminal: "idle", messages: [body] };
const samples = { withoutCheckpoint: [], withCheckpoint: [], synchronousCheckpoint: [] };
const writes = { withoutCheckpoint: [], withCheckpoint: [] };
try {
  for (let n = 0; n < 30; n++) for (const enabled of [false, true]) {
    const name = enabled ? "withCheckpoint" : "withoutCheckpoint";
    const input = { ...message, eventId: `${name}-${n}`, messageId: `${name}-${n}` };
    let calls = 0, checkpointMs = 0, task;
    if (enabled) {
      task = store.receiveMessage(input, binding); store.inbox.claim(task.id, binding);
      task = store.dispatchMessage(task.id, "session", "a".repeat(64));
    }
    const adapter = new LarkChannelAdapter({ appId: "cli", appSecret: "", streaming: {
      intervalMs: 1, minChunkChars: 12, maxSteps: 10, printFrequencyMs: 1, printStep: 1000, settlePaddingMs: 0
    }, channel: {
      createCard: async () => { calls++; return { cardId: "card" }; }, send: async () => { calls++; return { messageId: "reply" }; },
      rawClient: { im: {}, cardkit: { v1: { cardElement: { content: async () => { calls++; return { code: 0 }; } },
        card: { settings: async () => { calls++; return { code: 0 }; } } } } }
    } });
    const start = performance.now();
    await adapter.streamReply(input, async update => {
      if (task) {
        const before = performance.now(); store.inbox.planReply(task.id, result, body, task.dispatchId); checkpointMs += performance.now() - before;
      }
      await update(body);
    }, task ? async event => {
      const before = performance.now(); store.inbox.recordReplyDelivery(task.id, event, task.dispatchId); checkpointMs += performance.now() - before;
    } : undefined);
    samples[name].push(performance.now() - start); writes[name].push(calls);
    if (task) {
      samples.synchronousCheckpoint.push(checkpointMs);
      assert.equal(store.inbox.findMessage(input).replyConfirmed, true); store.finishMessage(task.id, "completed");
    }
  }
  assert.deepEqual(writes.withCheckpoint, writes.withoutCheckpoint);
  const stats = values => {
    const ordered = [...values].sort((a, b) => a - b);
    return { count: values.length, p50Ms: ordered[Math.ceil(values.length * .5) - 1], p95Ms: ordered[Math.ceil(values.length * .95) - 1] };
  };
  console.log(JSON.stringify({ mode: "local_sqlite_mock_cardkit", chars: body.length, network: false,
    samples: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, stats(values)])), mockWritesPerReply: writes.withCheckpoint[0],
    additionalExternalWrites: 0, note: "1ms模拟渲染间隔用于放大本地开销，不代表默认80ms渲染策略或真实用户端P95" }, null, 2));
} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
