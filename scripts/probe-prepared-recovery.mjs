import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ArkClient } from "../src/ark.ts";
import { loadConfigFile, loadEmployeeConfig } from "../src/config.ts";
import { Gateway, toConversationKey } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";

// 只对新建的隔离Session执行一次随机回显；不连接飞书，不修改Agent或生产凭证。
const CHILD_TIMEOUT_MS = 70_000;
const RUN_TIMEOUT_MS = 120_000;
const RECOVERY_TIMEOUT_MS = 145_000;
const startedAt = Date.now();
const childMode = process.argv[2] === "--child";
const resumeMode = process.argv[2] === "--resume";
const mode = childMode ? "child" : resumeMode ? "resume" : "parent";
// 每次显式恢复独立留证，绝不覆盖首次父进程或之前的恢复证据。
const evidenceName = resumeMode ? `resume-${randomUUID()}-evidence.json` : `${mode}-evidence.json`;
let evidenceDir, store, sessionId, childProcess, hardTimer;
const counts = { creates: 0, runs: 0, readinessChecks: 0, uploads: 0, configBuilds: 0, configHooks: 0,
  historyReads: 0, credentialMaintenance: 0, replies: 0, blockedOperations: 0, httpCreates: 0,
  httpMessages: 0, suppressedLogs: 0 };
const checks = {};
const abort = new AbortController();
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const hash = value => createHash("sha256").update(value).digest("hex");
function check(value, code) {
  if (!value) { const error = new Error(code); error.probeCode = code; throw error; }
}
function safeSessionId(value) { return typeof value === "string" && /^sesn-[a-zA-Z0-9-]{1,100}$/.test(value) ? value : undefined; }
function snapshot(stage, extra = {}) {
  return { stage, mode, sessionId: safeSessionId(sessionId), elapsedMs: Date.now() - startedAt,
    counts: { ...counts }, checks: { ...checks }, liveChannel: false, ...extra };
}
function save(stage, extra = {}) {
  const value = snapshot(stage, extra);
  if (evidenceDir) writeFileSync(join(evidenceDir, evidenceName), JSON.stringify(value, null, 2), { mode: 0o600 });
  return value;
}
function forbidden(name) {
  return async () => { counts.blockedOperations++; check(false, `forbidden_${name}`); };
}
function incoming(meta) {
  return { channelType: "lark", installationId: `probe-${meta.id}`, tenantId: "synthetic",
    conversationId: `probe-${meta.id}`, conversationType: "group", threadId: "", rootMessageId: "",
    parentMessageId: "", senderId: "synthetic-user", messageId: `message-${meta.id}`, eventId: `event-${meta.id}`,
    resources: [], mentionedBot: true, createTime: meta.createdAt,
    text: `这是隔离回归测试。不要调用任何工具，不要访问文件或外部服务，只回复以下随机字符串，不要解释或添加其他内容：${meta.nonce}` };
}
function gatewayOptions(config, recovery) {
  return { agentId: config.arkAgentId, environmentId: config.arkEnvironmentId,
    // 占位值仅满足Gateway配置；真正发送MA前强制清空vault_ids，生产Vault从不进入请求。
    vaultId: "probe-no-vault", appId: config.feishuAppId, timeoutMs: RUN_TIMEOUT_MS,
    progressDelayMs: RECOVERY_TIMEOUT_MS + 10_000, platformAccess: true,
    sharedGroupSessions: true, durableQueue: true, sessionConfigurationRevision: "prepared-recovery-probe-v1",
    beforeCreateSession: async () => { counts.credentialMaintenance++; },
    buildSessionRequest: recovery ? forbidden("config_hook") : async (_message, request) => { counts.configHooks++; return request; },
    loadRecentHistory: recovery ? forbidden("history") : async () => { counts.historyReads++; return []; },
    readMessage: forbidden("read_message"), downloadAttachment: forbidden("download"),
    getUserVaultIds: forbidden("user_vault") };
}
function createClient(config) {
  const base = new URL(config.arkBaseUrl);
  check(base.origin === "https://ark.cn-beijing.volces.com" && base.pathname === "/api/v3", "unexpected_ark_endpoint");
  const guardedFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method || "GET").toUpperCase();
    check(url.origin === base.origin, "unexpected_http_origin");
    const path = url.pathname;
    if (method === "POST" && path === "/api/v3/sessions") {
      counts.httpCreates++;
      check(childMode && counts.httpCreates === 1, "session_create_replayed");
      const body = JSON.parse(String(init.body));
      check(body.agent === config.arkAgentId && (body.environment?.id || body.environment_id) === config.arkEnvironmentId, "session_binding_changed");
      check(Array.isArray(body.vault_ids) && body.vault_ids.length === 0, "vault_not_empty");
    } else if (method === "POST" && sessionId && path === `/api/v3/sessions/${encodeURIComponent(sessionId)}/events`) {
      counts.httpMessages++;
      check(!childMode && counts.httpMessages === 1, "message_post_replayed");
      const body = JSON.parse(String(init.body));
      check(body.events?.length === 1 && body.events[0].type === "user.message", "unexpected_event_write");
      check(body.events[0].content?.length === 1 && body.events[0].content[0].type === "text"
        && hash(body.events[0].content[0].text) === checks.preparedFingerprint, "http_input_changed");
    } else {
      const environmentRead = childMode && path === `/api/v3/environments/${encodeURIComponent(config.arkEnvironmentId)}`;
      const sessionRead = sessionId && (path === `/api/v3/sessions/${encodeURIComponent(sessionId)}`
        || ["events", "events/stream"].some(suffix => path === `/api/v3/sessions/${encodeURIComponent(sessionId)}/${suffix}`));
      check(method === "GET" && (environmentRead || sessionRead), "unexpected_http_operation");
    }
    const deadline = AbortSignal.timeout(path.endsWith("/stream") ? RUN_TIMEOUT_MS + 5_000 : 30_000);
    const signal = AbortSignal.any([abort.signal, deadline, ...(init.signal ? [init.signal] : [])]);
    return fetch(input, { ...init, signal, redirect: "error" });
  };
  return new ArkClient(config.arkApiKey, config.arkBaseUrl, guardedFetch);
}
async function prepareInChild(config, meta) {
  const client = createClient(config);
  store = new GatewayStore(join(evidenceDir, "gateway.db")); store.acquireRuntimeLock();
  store.dispatchMessage = () => {
    const task = store.inbox.findMessage(incoming(meta));
    check(task?.state === "preparing" && task.preparation?.sessionId === sessionId, "missing_preparation");
    check(!task.sessionId && !task.requestFingerprint && !task.dispatchId, "already_dispatched");
    check(counts.runs === 0 && counts.httpMessages === 0, "child_sent_message");
    checks.preparedFingerprint = hash(task.preparation.input);
    checks.preparedShaMatches = checks.preparedFingerprint === task.preparation.fingerprint;
    check(checks.preparedShaMatches, "invalid_prepared_sha");
    output(save("prepared_before_dispatch"));
    // 不调用原dispatch，也不close数据库，模拟准备持久化后的真实进程退出。
    process.exit(77);
  };
  const gateway = new Gateway(store, {
    buildSessionCreateRequest: async defaults => { counts.configBuilds++; return client.buildSessionCreateRequest({ ...defaults, vaultIds: [] }); },
    createSession: async request => {
      counts.creates++; check(counts.creates === 1, "create_replayed");
      request.vault_ids = [];
      sessionId = await client.createSession({ ...request, title: `Prepared recovery probe ${meta.id}` });
      check(safeSessionId(sessionId), "invalid_session_id");
      output(save("created")); return sessionId;
    },
    uploadFile: forbidden("upload"), addSessionResource: forbidden("resource_write"),
    run: forbidden("child_run")
  }, async () => { counts.replies++; }, gatewayOptions(config, false));
  gateway.accept(incoming(meta));
  await delay(CHILD_TIMEOUT_MS);
  check(false, "child_preparation_timeout");
}
async function launchChild(configPath) {
  return new Promise((yes, no) => {
    childProcess = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), "--child", configPath, evidenceDir],
      { stdio: ["ignore", "pipe", "pipe"] });
    let outputBytes = 0;
    // 不转发子进程任意输出；只读取本探针写入的白名单聚合证据。
    for (const stream of [childProcess.stdout, childProcess.stderr]) stream.on("data", chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) childProcess.kill("SIGKILL");
    });
    const timer = setTimeout(() => childProcess.kill("SIGKILL"), CHILD_TIMEOUT_MS + 5_000);
    childProcess.once("error", error => { clearTimeout(timer); no(error); });
    childProcess.once("close", code => { clearTimeout(timer); yes(code); });
  });
}
async function recoverInParent(config, meta, childEvidence) {
  const client = createClient(config);
  const message = incoming(meta);
  store = new GatewayStore(join(evidenceDir, "gateway.db")); store.acquireRuntimeLock();
  const saved = store.inbox.findMessage(message);
  const preparedState = saved?.state === "preparing" && [undefined, "preparing"].includes(saved.interruptedAt);
  const recoverableState = resumeMode && saved?.state === "uncertain" && saved.interruptedAt === "preparing";
  const noDispatchEvidence = saved && ["sessionId", "requestFingerprint", "dispatchId", "replyConfirmed", "replyResultFingerprint",
    "replyIntent", "delivery", "replyInspection", "inspection", "resolution"].every(key => saved[key] === undefined);
  check((preparedState || recoverableState) && saved.preparation && noDispatchEvidence, "invalid_restart_checkpoint");
  check(saved.preparation.sessionId === sessionId, "restart_session_changed");
  checks.preparedFingerprint = hash(saved.preparation.input);
  checks.preparedShaMatches = checks.preparedFingerprint === saved.preparation.fingerprint
    && checks.preparedFingerprint === childEvidence.checks.preparedFingerprint;
  check(checks.preparedShaMatches, "restart_input_changed");
  let runResult;
  const gateway = new Gateway(store, {
    createSession: forbidden("recovery_create"), buildSessionCreateRequest: forbidden("recovery_build"),
    uploadFile: forbidden("recovery_upload"), addSessionResource: forbidden("recovery_resource"),
    inspectSessionReadiness: async (id, signal) => {
      counts.readinessChecks++; check(counts.readinessChecks === 1 && id === sessionId, "readiness_replayed_or_wrong_session");
      const readiness = await client.inspectSessionReadiness(id, signal);
      checks.idleBeforeRecovery = readiness.status === "idle";
      checks.readinessBindingMatches = readiness.sessionId === sessionId && readiness.agentId === config.arkAgentId;
      save("inspected"); check(checks.idleBeforeRecovery && checks.readinessBindingMatches, "session_not_ready_or_binding_changed"); return readiness;
    },
    run: async (id, input, timeoutMs) => {
      counts.runs++; check(counts.runs === 1 && id === sessionId, "run_replayed_or_wrong_session");
      checks.runInputShaMatches = hash(input) === checks.preparedFingerprint;
      check(checks.runInputShaMatches, "run_input_changed");
      save("dispatching");
      runResult = await client.run(id, input, timeoutMs);
      save("run_ended", { terminal: runResult.terminal }); return runResult;
    }
  }, async (_message, outbound) => {
    counts.replies++;
    checks.replyNonceMatches = outbound.type === "text" && outbound.text.trim() === meta.nonce;
  }, gatewayOptions(config, true));
  gateway.recoverPendingMessages(message.channelType, message.installationId);
  // 与启动批次合并同一次核查；此方法领取后即返回，不等待整轮模型运行。
  await gateway.reconcilePendingMessage(message);
  check(checks.idleBeforeRecovery === true, "idle_inspection_not_confirmed");
  check(store.inbox.findMessage(message)?.state !== "uncertain", "prepared_task_not_claimed");
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
  while (store.inbox.findMessage(message)?.state !== "completed") {
    const state = store.inbox.findMessage(message)?.state;
    check(state !== "failed" && state !== "awaiting_authorization", "recovery_failed_or_needs_auth");
    check(Date.now() < deadline, "recovery_timeout_no_retry");
    await delay(100);
  }
  check(runResult?.terminal === "idle" && !runResult.authorizationRequired, "run_not_successful");
  check(counts.runs === 1 && counts.httpMessages === 1 && counts.readinessChecks === 1 && counts.credentialMaintenance === 1, "recovery_count_mismatch");
  check(counts.blockedOperations === 0 && counts.creates === 0 && counts.uploads === 0 && counts.configBuilds === 0 && counts.configHooks === 0, "preparation_repeated");
  check(store.getSession(toConversationKey(message, true)) === sessionId, "conversation_session_changed");
  // 运行结束后只读核验完整历史，不补发消息、不压缩、不轮换Session。
  const events = await client.listSessionEvents(sessionId, AbortSignal.timeout(10_000));
  const textOf = event => (event.content || []).filter(part => part.type === "text").map(part => part.text || "").join("");
  const userMessages = events.filter(event => event.type === "user.message");
  const compactCommands = userMessages.filter(event => /^\/compact(?:\s|$)/i.test(textOf(event).trim())).length;
  const compactEvents = events.filter(event => /compact/i.test(event.type)).length;
  const sessionErrors = events.filter(event => ["session.error", "session.status_failed"].includes(event.type)).length;
  const toolUses = events.filter(event => event.type === "agent.tool_use").length;
  checks.eventInputShaMatches = userMessages.length === 1 && hash(textOf(userMessages[0])) === checks.preparedFingerprint;
  checks.eventNonceMatches = events.filter(event => event.type === "agent.message").some(event => textOf(event).trim() === meta.nonce);
  checks.resultNonceMatches = runResult.messages.join("\n").trim() === meta.nonce;
  check(userMessages.length === 1 && compactCommands === 0 && compactEvents === 0 && sessionErrors === 0 && toolUses === 0, "unexpected_session_events");
  check(checks.eventInputShaMatches && checks.eventNonceMatches && checks.resultNonceMatches && checks.replyNonceMatches && counts.replies === 1, "nonce_or_delivery_mismatch");
  return { userMessages: userMessages.length, compactCommands, compactEvents, sessionErrors, toolUses,
    preparationCreates: childEvidence.counts.creates, preparationCredentialMaintenance: childEvidence.counts.credentialMaintenance,
    preparationConfigBuilds: childEvidence.counts.configBuilds, preparationConfigHooks: childEvidence.counts.configHooks,
    syntheticReplyOnly: true };
}

try {
  check((childMode || resumeMode || process.argv[2] === "--live") && process.argv[3]
    && process.argv.length === (childMode || resumeMode ? 5 : 4), "usage_expected_live_config_or_resume_config_evidence_dir");
  const configPath = resolve(process.argv[3]);
  evidenceDir = childMode || resumeMode ? resolve(process.argv[4]) : mkdtempSync(join(tmpdir(), "ark-prepared-live-"));
  // 库日志可能含服务端上下文；探针仅输出自己的稳定错误码、计数和SessionID。
  console.log = console.warn = console.error = () => { counts.suppressedLogs++; };
  const env = {}; loadConfigFile(configPath, env);
  const config = loadEmployeeConfig(env);
  hardTimer = setTimeout(() => {
    abort.abort(); childProcess?.kill("SIGKILL");
    output(save("failed", { reason: "hard_timeout_no_retry", evidenceDir })); process.exit(1);
  }, childMode ? CHILD_TIMEOUT_MS : (resumeMode ? 0 : CHILD_TIMEOUT_MS) + RECOVERY_TIMEOUT_MS + 30_000);
  if (childMode) {
    await prepareInChild(config, JSON.parse(readFileSync(join(evidenceDir, "probe.json"), "utf8")));
  } else {
    const meta = resumeMode ? JSON.parse(readFileSync(join(evidenceDir, "probe.json"), "utf8"))
      : { id: randomUUID(), nonce: `PREPARED_${randomUUID().replaceAll("-", "")}`, createdAt: Date.now() };
    if (!resumeMode) writeFileSync(join(evidenceDir, "probe.json"), JSON.stringify(meta), { mode: 0o600 });
    output(save("started", { evidenceDir, evidenceName }));
    const code = resumeMode ? undefined : await launchChild(configPath);
    let childEvidence;
    try { childEvidence = JSON.parse(readFileSync(join(evidenceDir, "child-evidence.json"), "utf8")); } catch { /* 失败时保留父进程证据。 */ }
    sessionId = safeSessionId(childEvidence?.sessionId);
    check((resumeMode || code === 77) && childEvidence?.stage === "prepared_before_dispatch" && sessionId, "child_did_not_exit_prepared");
    check(childEvidence.counts.creates === 1 && childEvidence.counts.httpCreates === 1 && childEvidence.counts.runs === 0
      && childEvidence.counts.httpMessages === 0 && childEvidence.counts.blockedOperations === 0
      && childEvidence.counts.configBuilds === 1 && childEvidence.counts.configHooks === 1
      && childEvidence.counts.credentialMaintenance === 1, "invalid_child_counts");
    if (resumeMode) {
      const previous = JSON.parse(readFileSync(join(evidenceDir, "parent-evidence.json"), "utf8"));
      check(previous.stage === "failed" && previous.sessionId === sessionId && previous.counts.runs === 0
        && previous.counts.httpMessages === 0 && previous.counts.creates === 0, "previous_dispatch_not_excluded");
    }
    const result = await recoverInParent(config, meta, childEvidence);
    output(save("passed", { ...result, evidenceDir, evidenceName }));
  }
} catch (error) {
  output(save("failed", { reason: error?.probeCode || "operation_failed_no_retry", evidenceDir }));
  process.exitCode = 1;
} finally {
  clearTimeout(hardTimer); abort.abort(); childProcess?.kill("SIGKILL"); store?.close();
}
