// 对照相同事件：真实SQLite、合成Document内容，不访问MA/飞书，不证明PDF理解效果。
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
if (!process.argv[2]) throw new Error("需要提供只读基线源码目录");
const samples = Number(process.argv[3] || 200), warmup = 10;
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 1000) throw new Error("样本数应为1至1000");
const directory = mkdtempSync(join(tmpdir(), "ark-file-observation-bench-"));
const stamp = "2026-09-16T00:00:00Z";
const payload = "X".repeat(6 * 1024 * 1024);
const files = ["a", "b"].flatMap(id => [
  { id, type: "agent.tool_use", name: "read", input: { file_path: `/mnt/session/uploads/${id}.pdf` }, processed_at: stamp },
  { id: id + "-result", type: "agent.tool_result", tool_use_id: id, is_error: false, processed_at: stamp,
    content: [{ type: "document", source: { type: "base64", data: payload } }] }
]);
const ending = [{ id: "reply", type: "agent.message", processed_at: stamp, content: [{ type: "text", text: "合成分析结果" }] },
  { id: "idle", type: "session.status_idle", processed_at: stamp }];
const groups = [];
try {
  for (const [label, repo] of [["before", resolve(process.argv[2])], ["after", resolve(".")]]) {
    const { resultFromEvents } = await import(pathToFileURL(join(repo, "src/ark.ts")).href);
    const { GatewayStore } = await import(pathToFileURL(join(repo, "src/store.ts")).href);
    groups.push({ label, resultFromEvents, store: new GatewayStore(join(directory, label + ".db")), times: { plain: [], files: [] } });
  }
  for (const scenario of ["plain", "files"]) for (let n = 0; n < samples + warmup; n++) {
    for (const group of n % 2 ? groups.toReversed() : groups) {
      const start = performance.now();
      const result = group.resultFromEvents(scenario === "files" ? [...files, ...ending] : ending, 0);
      if (result.terminal !== "idle" || result.messages[0] !== "合成分析结果") throw new Error("运行结果发生非预期变化");
      const log = group.store.addAuditLog({ tenantKey: "tenant", openId: "user", chatId: "chat", messageId: `${scenario}-${n}`,
        action: "message", status: "succeeded", fileObservation: result.fileObservation });
      if (scenario === "files" && group.label === "after" && log.fileObservation?.reads.length !== 2) throw new Error("应记录两次读取");
      if (n >= warmup) group.times[scenario].push(performance.now() - start);
    }
  }
  console.log(JSON.stringify({ externalServices: "mock", samples, warmup, alternatingOrder: true,
    scope: "已解析事件归并加真实SQLite审计写入；不含HTTP/SSE解析，不复制/解码Document正文", documentBytes: payload.length * 2,
    groups: groups.map(group => ({ label: group.label, times: Object.fromEntries(Object.entries(group.times).map(([scenario, times]) => {
      times.sort((a, b) => a - b); return [scenario, { p50Ms: times[Math.floor((times.length - 1) * .5)], p95Ms: times[Math.floor((times.length - 1) * .95)] }];
    })) })) }));
} finally {
  for (const group of groups) group.store.close();
  rmSync(directory, { recursive: true, force: true });
}
