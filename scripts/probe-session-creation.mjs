import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ArkClient } from "../src/ark.ts";
import { GatewayStore } from "../src/store.ts";
import { toConversationKey } from "../src/gateway.ts";
import { loadConfigFile, loadEmployeeConfig } from "../src/config.ts";
import { configFingerprint } from "../src/session-config.ts";

// 只新建一个无Vault、无附件的隔离Session；在确认前真实退出，父进程只GET核查，不发消息。
const child = process.argv[2] === "--child", resume = process.argv[2] === "--resume";
const overrides = process.argv.includes("--overrides");
const configPath = process.argv[3] && resolve(process.argv[3]);
if (!configPath || (!child && !resume && process.argv[2] !== "--live")) throw new Error("usage: --live config | --resume config evidence-dir");
const dir = child || resume ? resolve(process.argv[4]) : mkdtempSync(join(tmpdir(), "ark-creation-live-"));
const env = {}; loadConfigFile(configPath, env); const config = loadEmployeeConfig(env);
const base = new URL(config.arkBaseUrl);
if (base.origin !== "https://ark.cn-beijing.volces.com" || base.pathname !== "/api/v3") throw new Error("unexpected endpoint");
const counts = { creates: 0, gets: 0, modelMessages: 0 }, shapes = [];
const client = new ArkClient(config.arkApiKey, config.arkBaseUrl, async (input, init = {}) => {
  const url = new URL(String(input)), method = init.method || "GET";
  if (url.origin !== base.origin) throw new Error("unexpected origin");
  if (method === "POST" && url.pathname === "/api/v3/sessions" && child && counts.creates === 0) {
    const request = JSON.parse(init.body);
    if (request.agent !== config.arkAgentId || (request.environment_id || request.environment?.id) !== config.arkEnvironmentId
      || request.vault_ids.length !== 0 || request.resources.length !== 0) throw new Error("unexpected creation");
    counts.creates++;
  } else if (method === "GET" && !child && /^\/api\/v3\/sessions(?:\/sesn-[a-zA-Z0-9-]+)?$/.test(url.pathname)) counts.gets++;
  else if (method === "GET" && child && overrides && url.pathname === `/api/v3/environments/${encodeURIComponent(config.arkEnvironmentId)}`) counts.gets++;
  else throw new Error("forbidden operation");
  const response = await fetch(input, { ...init, redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(15000), ...(init.signal ? [init.signal] : [])]) });
  if (method === "GET") {
    const data = await response.clone().json();
    shapes.push({ path: url.pathname.includes("/sesn-") ? "detail" : "list", http: response.status,
      keys: Object.keys(data), count: Array.isArray(data.data) ? data.data.length : undefined,
      nextPageType: typeof data.next_page, hasMore: data.has_more });
  }
  return response;
});
let store;
const reportFile = join(dir, child ? "child.json" : resume ? `resume-${randomUUID()}.json` : "parent.json");
const startedAt = Date.now();
function save(value) {
  const report = { ...value, overrides, counts, shapes, elapsedMs: Date.now() - startedAt, liveChannel: false, modelDispatched: false };
  writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ evidenceDir: dir, ...report })}\n`);
}
try {
  if (child) {
    store = new GatewayStore(join(dir, "gateway.db"));
    const id = randomUUID(), message = { channelType: "lark", installationId: `creation-probe-${id}`, tenantId: "synthetic",
      conversationId: "synthetic-chat", conversationType: "group", senderId: "synthetic-user", threadId: "", rootMessageId: "",
      parentMessageId: "", messageId: id, eventId: id, text: "仅核验创建资源，不派发业务", createTime: Date.now(), resources: [], mentionedBot: true };
    const baseRequest = overrides ? await client.buildSessionCreateRequest({ agentId: config.arkAgentId,
      environmentId: config.arkEnvironmentId, vaultIds: [], envOverrides: { ARKAGENT_CREATION_PROBE: id } })
      : { agent: config.arkAgentId, environment_id: config.arkEnvironmentId };
    const request = { ...baseRequest, resources: [], vault_ids: [],
      title: `Creation recovery probe ${id}`, tags: [{ key: "purpose", value: "isolated-creation-recovery" }] };
    const intent = store.beginSessionCreation({ message, key: toConversationKey(message, true), agentId: config.arkAgentId,
      configFingerprint: configFingerprint({ probe: "creation-v1" }), request, reusable: true, mounts: [] });
    const sessionId = await client.createSession(intent.request);
    save({ stage: "created_before_local_confirmation", operationId: intent.operationId, sessionId,
      agentId: config.arkAgentId, environmentId: config.arkEnvironmentId, state: store.sessionCreations.get(intent.operationId).state });
    process.exit(77);
  }
  if (!resume) {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), "--child", configPath, dir, ...(overrides ? ["--overrides"] : [])],
      { encoding: "utf8", timeout: 20000, maxBuffer: 65536 });
    if (result.status !== 77) throw new Error("child did not exit at the intended checkpoint");
  }
  const evidence = JSON.parse(readFileSync(join(dir, "child.json"), "utf8"));
  store = new GatewayStore(join(dir, "gateway.db"));
  const intent = store.sessionCreations.get(evidence.operationId);
  if (!intent || intent.state !== "pending") throw new Error("missing pending creation; no operation was retried");
  const inspection = await client.inspectSessionCreation(intent);
  if (inspection.status !== "confirmed") {
    save({ stage: "not_confirmed", operationId: intent.operationId, sessionId: evidence.sessionId, inspection });
    process.exitCode = 2;
  } else {
    if (inspection.sessionId !== evidence.sessionId || inspection.sessionStatus !== "idle") throw new Error("incorrect or non-idle Session proof");
    store.confirmSessionCreation(intent, inspection.sessionId);
    save({ stage: "confirmed_without_recreation", operationId: intent.operationId, sessionId: inspection.sessionId, inspection,
      state: store.sessionCreations.get(intent.operationId).state, bindingMatches: store.getSession(intent.key) === inspection.sessionId,
      childCreates: evidence.counts.creates, parentCreates: counts.creates });
  }
} catch (error) {
  save({ stage: "probe_failed", errorName: error?.name || "Error" }); process.exitCode = 1;
} finally { store?.close(); }
