import { performance } from "node:perf_hooks";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GatewayStore } from "../src/store.ts";

// 只使用隔离SQLite与合成元数据；不调用飞书或MA，不读取运行配置。
const rows = 30_000, samples = 30;
const directory = mkdtempSync(join(tmpdir(), "ark-attachment-diagnostics-bench-"));
const key = "a".repeat(64);
const message = { channelType: "lark", installationId: "app", tenantId: "tenant", conversationId: "chat", threadId: "", messageId: "write-probe" };
const scenarios = ["writePair", "latestPage", "missingMessage", "missingSession"];
const modes = [false, true].map(indexed => {
  const path = join(directory, indexed ? "indexed.db" : "baseline.db");
  const store = new GatewayStore(path), db = new DatabaseSync(path);
  if (!indexed) db.exec("DROP INDEX attachment_stage_installation; DROP INDEX attachment_stage_message; DROP INDEX attachment_stage_session");
  const insert = db.prepare("INSERT INTO attachment_stage_receipts (id,scope,attachment_key,stage,status,started_at,finished_at,details) VALUES (?,?,?,'mount','succeeded',1,2,?)");
  db.exec("BEGIN");
  for (let n = 0; n < rows; n++) insert.run("receipt-" + n,
    JSON.stringify(["lark", n % 3 ? "other-app" : "app", "tenant", "chat", "", "message-" + n]), key,
    JSON.stringify({ sessionId: "session-" + (n % 100), fileId: "file-" + n, bytes: 4718592, sha256: key }));
  db.exec("COMMIT");
  return { indexed, store, db, durations: Object.fromEntries(scenarios.map(name => [name, []])) };
});
for (let iteration = -5; iteration < samples; iteration++) for (const mode of iteration % 2 ? modes : [...modes].reverse()) {
  const trace = mode.store.attachmentTrace;
  for (const name of scenarios) {
    const start = performance.now();
    if (name === "writePair") { const id = trace.begin(message, key, "download"); trace.finish(id, "succeeded", { bytes: 3, sha256: key }); }
    else trace.listForInstallation("lark", "app", name === "missingMessage" ? { messageId: "missing" } : name === "missingSession" ? { sessionId: "missing" } : {});
    if (iteration >= 0) mode.durations[name].push(performance.now() - start);
  }
}
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50Ms: +sorted[Math.ceil(sorted.length * .5) - 1].toFixed(3), p95Ms: +sorted[Math.ceil(sorted.length * .95) - 1].toFixed(3) };
}
console.log(JSON.stringify({ rows, samples, kind: "local_sqlite_synthetic_metadata_not_external_e2e", modes: modes.map(mode => ({
  indexed: mode.indexed, scenarios: Object.fromEntries(scenarios.map(name => [name, summarize(mode.durations[name])]))
})) }, null, 2));
for (const mode of modes) { mode.db.close(); mode.store.close(); }
