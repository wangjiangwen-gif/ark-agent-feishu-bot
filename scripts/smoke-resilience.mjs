import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ArkClient } from "../src/ark.ts";
import { loadConfigFile, loadEmployeeConfig } from "../src/config.ts";
import { Gateway, toConversationKey } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";

// 显式指定 --live 和配置文件；仅生成合成 PDF，不读取或发送用户文件、飞书消息。
if (process.argv[2] !== "--live" || !process.argv[3]) throw new Error("Usage: node --experimental-strip-types scripts/smoke-resilience.mjs --live <employee-config.env>");
loadConfigFile(process.argv[3]);
const config = loadEmployeeConfig();
const runId = randomUUID();
const bytesA = pdf(`TEST_A_${runId}`);
const bytesB = pdf(`TEST_B_${runId}`);
const hashes = [bytesA, bytesB].map(bytes => createHash("sha256").update(bytes).digest("hex"));
const client = new ArkClient(config.arkApiKey, config.arkBaseUrl);
const store = new GatewayStore(":memory:");
let answer;
const message = {
  channelType: "lark", installationId: `test-${runId}`, tenantId: "synthetic", conversationId: "synthetic-chat", conversationType: "group",
  eventId: "test-event", messageId: "test-message", threadId: "", rootMessageId: "", parentMessageId: "", senderId: "synthetic-user", mentionedBot: true,
  createTime: Date.now(), text: "这是合成文件测试。仅使用 bash 对本次挂载的两份 PDF 分别执行 sha256sum，原样返回两个哈希值。不要使用飞书工具。",
  resources: [{ type: "file", id: "a", name: "same-name.pdf" }, { type: "file", id: "b", name: "same-name.pdf" }]
};
const gateway = new Gateway(store, client, async (_message, outgoing) => {
  if (outgoing.type === "text" && !outgoing.text.startsWith("已收到")) answer = outgoing.text;
}, {
  agentId: config.arkAgentId, environmentId: config.arkEnvironmentId, vaultId: config.arkVaultId,
  timeoutMs: 180_000, platformAccess: true, sharedGroupSessions: true, sessionCompaction: false,
  progressDelayMs: 180_000,
  downloadAttachment: async resource => ({ bytes: resource.id === "a" ? bytesA : bytesB, mimeType: "application/pdf" }),
  buildSessionRequest: async (_message, draft) => ({ ...draft, title: `ArkAgent resilience smoke ${runId}`, tags: [{ key: "arkagent_probe", value: "resilience" }] })
});
try {
  const startedAt = Date.now();
  gateway.accept(message);
  while (answer === undefined) {
    if (Date.now() - startedAt > 210_000) throw new Error("Gateway smoke timed out");
    await delay(100);
  }
  const sessionId = store.getSession(toConversationKey(message, true));
  console.log(JSON.stringify({ check: "unique-file-paths", sessionId, durationMs: Date.now() - startedAt, hashesMatched: hashes.every(hash => answer.includes(hash)) }));
  assert.ok(hashes.every(hash => answer.includes(hash)), "同名文件未能分别读取");
  const reconnect = new ArkClient(config.arkApiKey, config.arkBaseUrl);
  for (const streaming of [false, true, false]) {
    const expected = `FRESH_${randomUUID()}`;
    const started = Date.now();
    const snapshots = [];
    const result = await reconnect.run(sessionId, `仅回复：${expected}`, 180_000, undefined, streaming ? async value => { snapshots.push(value); } : undefined);
    assert.equal(result.terminal, "idle");
    assert.ok(result.messages.at(-1)?.includes(expected), "拿到了旧回复");
    assert.ok(snapshots.every(value => !value.includes("FRESH_") || expected.includes(value.trim()) || value.includes(expected)), "流式混入旧标记");
    console.log(JSON.stringify({ check: "fresh-turn", streaming, durationMs: Date.now() - started, matched: true }));
  }
  const marker = `STATE_${randomUUID()}`;
  const write = await reconnect.run(sessionId, `请仅使用 bash 将 ${marker} 写入 /mnt/session/resilience-state.txt，再读取并返回内容。`, 180_000);
  assert.ok(write.messages.at(-1)?.includes(marker));
  const compactStarted = Date.now();
  const beforeCompact = await reconnect.getSessionStats(sessionId);
  const compact = await reconnect.run(sessionId, "/compact", 180_000);
  assert.equal(compact.terminal, "idle");
  const proof = await reconnect.inspectCompaction(sessionId, beforeCompact.latestEventId);
  console.log(JSON.stringify({ check: "compact", durationMs: Date.now() - compactStarted, result: proof.result, reason: proof.reason, evidenceEventId: proof.evidenceEventId }));
  assert.equal(proof.result, "succeeded", "必须有本轮原生压缩完成事件，不能只凭idle通过");
  const read = await reconnect.run(sessionId, "请仅使用 bash 读取 /mnt/session/resilience-state.txt，并对 /mnt/session/uploads/mnt/data 中的所有 PDF 计算 sha256sum，返回原文和哈希。", 180_000);
  const final = read.messages.at(-1) || "";
  assert.ok(final.includes(marker), "原地压缩后生成文件丢失");
  assert.ok(hashes.every(hash => final.includes(hash)), "原地压缩后挂载文件丢失");
  console.log(JSON.stringify({ check: "persist-after-compact", sessionId, matched: true }));
} finally { store.close(); }

function pdf(text) {
  const content = `BT /F1 12 Tf 36 100 Td (${text}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let contentPdf = "%PDF-1.4\n";
  const offsets = [];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(contentPdf)); contentPdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(contentPdf);
  contentPdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(contentPdf);
}
