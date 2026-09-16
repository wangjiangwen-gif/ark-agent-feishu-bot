// 只测本机Gateway/SQLite成本。对照组使用改动前的直接挂载流程，外部服务均为模拟。
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as flush } from "node:timers/promises";
import { Gateway } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
const directory = mkdtempSync(join(tmpdir(), "ark-mount-bench-"));
const bytes = new Uint8Array(4.5 * 1024 * 1024).fill(37);
const groups = [false, true].map(recovery => {
  const store = new GatewayStore(join(directory, `${recovery}.db`));
  if (!recovery) store.db.exec("DROP INDEX attachment_mount_lookup");
  const calls = { download: 0, upload: 0, mount: 0, inspect: 0, run: 0 };
  let done;
  const gateway = new Gateway(store, {
    createSession: async () => { throw new Error("应复用Session"); },
    uploadFile: async name => { calls.upload++; await flush(); return { id: `file-${calls.upload}`, name }; },
    addSessionResource: async () => { calls.mount++; await flush(); },
    inspectFileMount: async () => { calls.inspect++; throw new Error("正常路径不应查询"); },
    run: async () => { calls.run++; await flush(); return { terminal: "idle", messages: ["完成"] }; }
  }, async () => done(), {
    agentId: "agent", environmentId: "env", vaultId: "vault", timeoutMs: 5000, authorizedUserId: "user", sessionCompaction: false,
    downloadAttachment: async () => { calls.download++; await flush(); return { bytes, mimeType: "application/pdf" }; }
  });
  if (!recovery) gateway.mountAttachment = (message, key, sessionId, resource, details) => gateway.traceAttachment(message, key, "mount",
    () => gateway.addSessionResource(sessionId, resource), { ...details, sessionId });
  return { recovery, store, gateway, calls, samples: [], setDone(callback) { done = callback; } };
});
try {
  for (let round = 0; round < 35; round++) for (const group of round % 2 ? groups.toReversed() : groups) {
    const id = `${group.recovery}-${round}`;
    group.store.saveSession({ channelType: "lark", installationId: "app", tenantId: "tenant", conversationId: id, threadId: "", senderId: "user" }, `session-${id}`, "agent");
    let timer;
    const finished = new Promise((resolve, reject) => { group.setDone(resolve); timer = setTimeout(() => reject(new Error("基准未完成")), 5000); });
    const start = performance.now();
    group.gateway.accept({ channelType: "lark", installationId: "app", tenantId: "tenant", conversationId: id, threadId: "", senderId: "user",
      conversationType: "direct", eventId: id, messageId: id, rootMessageId: "", parentMessageId: "", createTime: Date.now(), mentionedBot: false,
      text: "分析文件", resources: [{ id: "a", name: "a.pdf", type: "file" }, { id: "b", name: "b.pdf", type: "file" }] });
    try { await finished; } finally { clearTimeout(timer); }
    if (round >= 5) group.samples.push(performance.now() - start);
    await flush();
  }
  for (const group of groups) if (group.calls.download !== 70 || group.calls.upload !== 70 || group.calls.mount !== 70 || group.calls.run !== 35 || group.calls.inspect !== 0) throw new Error("正常路径调用数变化");
  console.log(JSON.stringify({ externalServices: "mock", warmup: 5, samples: 30, alternatingOrder: true,
    scenario: "已有Session每轮追加两份4.5MiB数据；不是PDF解析或真实用户延迟验收",
    groups: groups.map(group => { group.samples.sort((a, b) => a - b); return { recovery: group.recovery,
      p50Ms: group.samples[14], p95Ms: group.samples[28], calls: group.calls }; }) }));
} finally { for (const group of groups) group.store.close(); rmSync(directory, { recursive: true, force: true }); }
