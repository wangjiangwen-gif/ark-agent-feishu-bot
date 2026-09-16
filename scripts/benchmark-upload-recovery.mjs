// 基线源码目录由调用方从已确认commit导出；真实SQLite，传输模拟，不是外部E2E性能。
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setImmediate as flush } from "node:timers/promises";
if (!process.argv[2]) throw new Error("需要提供只读基线源码目录");
const sampleCount = Number(process.argv[3] || 30), warmup = 5;
if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 1000) throw new Error("样本数量应为1至1000");
const directory = mkdtempSync(join(tmpdir(), "ark-upload-bench-"));
const bytes = new Uint8Array(4.5 * 1024 * 1024).fill(37);
const groups = [];
try {
  for (const [label, repo] of [["before", resolve(process.argv[2])], ["after", resolve(".")]]) {
    const { Gateway } = await import(pathToFileURL(join(repo, "src/gateway.ts")).href);
    const { GatewayStore } = await import(pathToFileURL(join(repo, "src/store.ts")).href);
    const store = new GatewayStore(join(directory, `${label}.db`));
    const calls = { download: 0, upload: 0, mount: 0, inspect: 0, run: 0 };
    let done;
    const gateway = new Gateway(store, {
      createSession: async () => { throw new Error("应复用Session"); },
      uploadFile: async name => { calls.upload++; await flush(); return { id: `file-${calls.upload}`, name }; },
      addSessionResource: async () => { calls.mount++; await flush(); },
      inspectFileUpload: async () => { calls.inspect++; throw new Error("正常路径不应查询"); },
      inspectFileMount: async () => { calls.inspect++; throw new Error("正常路径不应查询"); },
      run: async () => { calls.run++; await flush(); return { terminal: "idle", messages: ["完成"] }; }
    }, async () => done(), {
      agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, authorizedUserId: "user", sessionCompaction: false,
      downloadAttachment: async () => { calls.download++; await flush(); return { bytes, mimeType: "application/pdf" }; }
    });
    groups.push({ label, store, gateway, calls, samples: { plain: [], files: [] }, setDone(callback) { done = callback; } });
  }
  for (const withFiles of [false, true]) for (let round = 0; round < sampleCount + warmup; round++) for (const group of round % 2 ? groups.toReversed() : groups) {
    const id = `${group.label}-${withFiles}-${round}`;
    group.store.saveSession({ channelType: "lark", installationId: "app", tenantId: "tenant", conversationId: id, threadId: "", senderId: "user" }, `session-${id}`, "agent");
    let timer;
    const finished = new Promise((resolve, reject) => { group.setDone(resolve); timer = setTimeout(() => reject(new Error("基准未完成")), 5000); });
    const start = performance.now();
    group.gateway.accept({ channelType: "lark", installationId: "app", tenantId: "tenant", conversationId: id, threadId: "", senderId: "user",
      conversationType: "direct", eventId: id, messageId: id, rootMessageId: "", parentMessageId: "", createTime: Date.now(), mentionedBot: false,
      text: "分析文件", resources: withFiles ? [{ id: "a", name: "a.pdf", type: "file" }, { id: "b", name: "b.pdf", type: "file" }] : [] });
    try { await finished; } finally { clearTimeout(timer); }
    if (round >= warmup) group.samples[withFiles ? "files" : "plain"].push(performance.now() - start);
    await flush();
  }
  const expected = (sampleCount + warmup) * 2;
  for (const group of groups) if (group.calls.download !== expected || group.calls.upload !== expected || group.calls.mount !== expected || group.calls.run !== expected || group.calls.inspect !== 0) throw new Error("正常路径调用数变化");
  console.log(JSON.stringify({ externalServices: "mock", warmup, samples: sampleCount, alternatingOrder: true,
    scenarios: { plain: "普通文本", files: "已有Session追加两份4.5MiB数据，不是PDF解析验收" },
    groups: groups.map(group => ({ label: group.label, calls: group.calls, samples: Object.fromEntries(Object.entries(group.samples).map(([key, values]) => {
      values.sort((a, b) => a - b); return [key, { p50Ms: values[Math.floor((values.length - 1) * .5)], p95Ms: values[Math.floor((values.length - 1) * .95)] }];
    })) })) }));
} finally { for (const group of groups) group.store.close(); rmSync(directory, { recursive: true, force: true }); }
