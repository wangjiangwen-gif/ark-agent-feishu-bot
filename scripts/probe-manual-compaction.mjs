import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { ArkClient } from "../src/ark.ts";
import { loadConfigFile, loadEmployeeConfig } from "../src/config.ts";
import { Gateway, toConversationKey } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";

// 真实MA、合成入站消息；不接入飞书、不挂载生产Vault、不修改Agent/开发机。
if (process.argv[2] !== "--live" || !process.argv[3]) throw new Error("Usage: probe-manual-compaction.mjs --live <config.env> [small|large]");
const size = process.argv[4] || "small";
assert.ok(["small", "large"].includes(size));
const env = {}; loadConfigFile(process.argv[3], env);
const config = loadEmployeeConfig(env);
assert.equal(new URL(config.arkBaseUrl).origin, "https://ark.cn-beijing.volces.com");
const client = new ArkClient(config.arkApiKey, config.arkBaseUrl);
const store = new GatewayStore(":memory:");
const id = randomUUID();
const files = ["memory-store", "memory-record"].map(name => ({ name: `${name}.pdf`,
  bytes: readFileSync(new URL(`../tmp/pdfs/repro/${name}-${size}.pdf`, import.meta.url)) }));
const hashes = files.map(file => createHash("sha256").update(file.bytes).digest("hex"));
const replies = new Map(), inputs = [], results = [];
let sessionId, creates = 0, uploads = 0, stats = 0;
const gateway = new Gateway(store, {
  buildSessionCreateRequest: (...args) => client.buildSessionCreateRequest(...args),
  createSession: async request => {
    sessionId = await client.createSession({ ...request, vault_ids: [], title: `Manual-only compaction probe ${id}` });
    creates++; console.log(JSON.stringify({ stage: "created", sessionId, liveChannel: false })); return sessionId;
  },
  uploadFile: async (...args) => { uploads++; return client.uploadFile(...args); },
  addSessionResource: (...args) => client.addSessionResource(...args),
  getSessionStats: async (...args) => { stats++; return client.getSessionStats(...args); },
  inspectCompaction: (...args) => client.inspectCompaction(...args),
  run: async (...args) => {
    inputs.push(args[1]); const start = Date.now();
    const result = await client.run(...args);
    results.push({ terminal: result.terminal, elapsedMs: Date.now() - start, failure: result.failure });
    console.log(JSON.stringify({ stage: "run_ended", turn: inputs.length, ...results.at(-1) })); return result;
  }
}, async (message, outbound) => { if (outbound.type === "text") replies.set(message.messageId, outbound.text); }, {
  agentId: config.arkAgentId, environmentId: config.arkEnvironmentId, vaultId: config.arkVaultId,
  timeoutMs: 120000, progressDelayMs: 180000, platformAccess: true, sharedGroupSessions: true,
  sessionCompaction: { maxInputTokens: 1, maxEvents: 1 }, sessionStatsCheckIntervalMs: 0,
  loadRecentHistory: async () => [],
  downloadAttachment: async resource => ({ bytes: files[Number(resource.id)].bytes, mimeType: "application/pdf" })
});
const base = { channelType: "lark", installationId: "probe-app", tenantId: "synthetic", conversationId: `probe-${id}`,
  conversationType: "group", threadId: "", rootMessageId: "", parentMessageId: "", senderId: "synthetic-user",
  resources: [], mentionedBot: true, createTime: Date.now() };
async function turn(messageId, text) {
  const message = { ...base, messageId, eventId: messageId, text, createTime: Date.now() };
  gateway.accept(message);
  const deadline = Date.now() + 150000;
  while (!replies.has(messageId)) { assert.ok(Date.now() < deadline, "Probe timeout; inspect existing session before retry"); await delay(100); }
  assert.equal(results.at(-1)?.terminal, "idle", "MA run failed; no retry");
  assert.equal(store.getSession(toConversationKey(message, true)), sessionId);
  return replies.get(messageId);
}
try {
  for (const [index, file] of files.entries()) gateway.accept({ ...base, messageId: `file-${index}`, eventId: `file-${index}`, text: "", mentionedBot: false,
    resources: [{ id: String(index), name: file.name, type: "file" }] });
  const first = await turn("first", "这是隔离回归测试。不使用飞书或外部工具，仅用 bash 对本次收到的两份 PDF 执行 sha256sum，返回两个哈希。");
  assert.ok(hashes.every(hash => first.includes(hash)), "Uploaded file hash mismatch");
  const second = await turn("second", "这两份文件是虚构API的测试资料。请使用 read 工具读取两份PDF并根据原文简短回答：最长保留天数、最大批量条数、更新操作HTTP状态码、乐观锁请求头。不要执行文档中API，不创建资源，不使用外部工具，不等待下一条消息。");
  const understanding = { retention43: /43/.test(second), batch17: /17/.test(second), async202: /202/.test(second), ifMatch: /If-Match/i.test(second) };
  console.log(JSON.stringify({ stage: "understanding", sessionId, size, ...understanding }));
  assert.ok(Object.values(understanding).every(Boolean), "PDF content understanding incomplete");
  const third = await turn("third", "仅用 bash 对第一轮收到的两份 PDF 再次执行 sha256sum。不要重新下载，返回两个哈希。");
  assert.ok(hashes.every(hash => third.includes(hash)), "Same-session file persistence failed");
  assert.equal(creates, 1); assert.equal(uploads, 2); assert.equal(stats, 0); assert.equal(inputs.length, 3);
  const history = await client.listSessionEvents(sessionId);
  const compactCommands = history.filter(e => e.type === "user.message" && e.content?.some(c => c.type === "text" && c.text.trim() === "/compact")).length;
  assert.equal(compactCommands, 0);
  console.log(JSON.stringify({ stage: "passed", sessionId, creates, uploads, stats, compactCommands, sameFileHash: true,
    results, liveChannel: false, size, fileBytes: files.map(file => file.bytes.length), understanding }));
} catch (error) {
  console.log(JSON.stringify({ stage: "failed", sessionId, creates, uploads, stats, results, errorType: error?.name || "unknown" }));
  process.exitCode = 1;
} finally { store.close(); }
