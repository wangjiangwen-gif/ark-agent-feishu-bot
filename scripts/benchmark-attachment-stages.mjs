// 本机Gateway/SQLite对照基准；外部传输为模拟，不用于宣称飞书或MA端到端性能。
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setImmediate as flush } from "node:timers/promises";

const repo = resolve(process.argv[2] || ".");
const { Gateway } = await import(pathToFileURL(join(repo, "src/gateway.ts")).href);
const { GatewayStore } = await import(pathToFileURL(join(repo, "src/store.ts")).href);
const dir = mkdtempSync(join(tmpdir(), "ark-attachment-benchmark-"));
const store = new GatewayStore(join(dir, "gateway.db"));
const bytes = new Uint8Array(4.5 * 1024 * 1024).fill(37);
let resolveReply;
const calls = { download: 0, upload: 0, create: 0, run: 0 };
const gateway = new Gateway(store, {
  createSession: async () => { calls.create++; await flush(); return `session-${calls.create}`; },
  uploadFile: async name => { calls.upload++; await flush(); return { id: `file-${calls.upload}`, name }; },
  run: async () => { calls.run++; await flush(); return { terminal: "idle", messages: ["完成"] }; }
}, async () => resolveReply(), {
  agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, authorizedUserId: "user", sessionCompaction: false,
  downloadAttachment: async () => { calls.download++; await flush(); return { bytes, mimeType: "application/pdf" }; }
});
const results = {};
try {
  for (const withFiles of [false, true]) {
    const samples = [];
    for (let index = 0; index < 35; index++) {
      const id = `${withFiles}-${index}`;
      let timer;
      const done = new Promise((resolve, reject) => {
        resolveReply = resolve;
        timer = setTimeout(() => reject(new Error("基准请求未完成")), 5000);
      });
      const started = performance.now();
      gateway.accept({ channelType: "lark", installationId: "app", tenantId: "tenant", senderId: "user", conversationType: "direct",
        conversationId: `chat-${id}`, messageId: id, eventId: id, threadId: "", rootMessageId: "", parentMessageId: "", createTime: Date.now(),
        mentionedBot: false, text: "测试", resources: withFiles ? [{ id: "a", name: "a.pdf", type: "file" }, { id: "b", name: "b.pdf", type: "file" }] : [] });
      try { await done; } finally { clearTimeout(timer); }
      if (index >= 5) samples.push(performance.now() - started);
      await flush();
    }
    samples.sort((a, b) => a - b);
    results[withFiles ? "two_4_5MiB_buffers" : "plain_text"] = { count: samples.length, p50Ms: samples[14], p95Ms: samples[28] };
  }
  if (calls.run !== 70 || calls.create !== 70 || calls.upload !== 70 || calls.download !== 70) throw new Error("基准调用数不符");
  console.log(JSON.stringify({ results, calls, externalServices: "mock", note: "数据只用于传输及Hash开销，不是PDF解析验收" }));
} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
