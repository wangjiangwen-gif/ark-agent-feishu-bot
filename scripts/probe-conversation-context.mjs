import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ArkClient } from "../src/ark.ts";
import { loadConfigFile, loadEmployeeConfig } from "../src/config.ts";
import { Gateway } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";

// 显式 --live 才会消耗 MA 额度；飞书输入/输出为模拟，不宣称是真实飞书端到端。
if (process.argv[2] !== "--live" || !process.argv[3]) throw new Error("Usage: probe-conversation-context.mjs --live <config.env>");
loadConfigFile(process.argv[3]);
const config = loadEmployeeConfig();
const client = new ArkClient(config.arkApiKey, config.arkBaseUrl);
const store = new GatewayStore(":memory:");
const probeId = randomUUID();
const marker = `CONTEXT_${probeId.slice(0, 8)}`;
const results = [];
const replies = new Map();
let sessionId;
let creates = 0;
const gateway = new Gateway(store, {
  buildSessionCreateRequest: (...args) => client.buildSessionCreateRequest(...args),
  createSession: async request => {
    assert.equal(request.environment.config.env.FEISHU_USER_OPEN_ID, undefined);
    sessionId = await client.createSession({ ...request, vault_ids: [], title: `Context regression ${probeId}` });
    creates++;
    console.log(JSON.stringify({ kind: "session_created", sessionId, agentId: config.arkAgentId, environmentId: config.arkEnvironmentId, liveChannel: false }));
    return sessionId;
  },
  run: async (...args) => {
    const started = Date.now();
    let firstDeltaMs;
    const result = await client.run(...args.slice(0, 3), undefined, async () => { firstDeltaMs ??= Date.now() - started; });
    results.push({ terminal: result.terminal, messages: result.messages, elapsedMs: Date.now() - started, firstDeltaMs });
    return result;
  }
}, async (message, outbound) => {
  if (outbound.type === "text") replies.set(message.messageId, outbound.text);
}, {
  agentId: config.arkAgentId, environmentId: config.arkEnvironmentId, vaultId: config.arkVaultId,
  timeoutMs: 180000, progressDelayMs: 240000, platformAccess: true, sharedGroupSessions: true, sessionCompaction: false,
  loadRecentHistory: async () => [],
  readMessage: async () => ({ status: "available", message: {
    messageId: "quoted-question", senderId: "probe-bot", senderType: "app", source: "chat", createTime: 1,
    text: `这是纯文本回显测试，不使用任何工具、不访问外部系统。需要我仅回复校验短语 ${marker} 吗？`
  } })
});

async function turn(id, actor, text, quote = "") {
  gateway.accept({ channelType: "lark", installationId: "probe-app", tenantId: "probe-tenant", conversationId: `probe-chat-${probeId}`,
    conversationType: "group", messageId: id, eventId: id, senderId: actor, text, parentMessageId: quote,
    threadId: "", rootMessageId: "", resources: [], mentionedBot: true, createTime: Date.now() });
  const end = Date.now() + 200000;
  while (!replies.has(id)) {
    if (Date.now() > end) throw new Error(`Probe timed out; query existing session ${sessionId} before retry`);
    await delay(100);
  }
  assert.equal(results.at(-1)?.terminal, "idle");
  return replies.get(id);
}

try {
  const first = await turn("quote-test", "probe-user-a", "需要", "quoted-question");
  assert.ok(first.includes(marker), "模型应依据被引用问题返回对应短语");
  const second = await turn("actor-test", "probe-user-b", "这是纯文本回显测试，不调用工具。请仅返回本轮 current_actor 的 open_id。");
  assert.ok(second.includes("probe-user-b"), "共享 Session 应识别本轮用户 B");
  assert.ok(!second.includes("probe-user-a"), "不得把上一轮用户 A 当作当前发言者");
  assert.equal(creates, 1);
  console.log(JSON.stringify({ kind: "probe_passed", sessionId, creates, liveChannel: false, results }));
} finally {
  store.close();
}
