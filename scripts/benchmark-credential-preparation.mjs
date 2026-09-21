// 本地性能诊断：真实Gateway、授权管理器、SQLite与回复适配层；MA、OAuth、飞书全部模拟。
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as flush } from "node:timers/promises";
import { balancedOrder, summarize, traceSynchronousMethods } from "./profile-text-reply-recovery.mjs";

const baselineRef = "1070b63", warmup = 16;
const reply = "用户凭证仍然有效，已完成本轮测试。";
const identity = { channelType: "lark", installationId: "fixture-app", tenantId: "fixture-tenant", openId: "fixture-user" };
const prototypeMessage = { channelType: identity.channelType, installationId: identity.installationId, tenantId: identity.tenantId,
  senderId: identity.openId, conversationId: "fixture-chat", conversationType: "direct", threadId: "", rootMessageId: "", parentMessageId: "",
  text: "请回复本轮测试结果", createTime: 0, resources: [], mentionedBot: false };

export function parseOptions(args) {
  let samples = 128, durable = false;
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!["--samples", "--durable"].includes(name) || seen.has(name)) throw new Error("参数：--samples 样本数（8至2000的8的倍数） [--durable]");
    seen.add(name);
    if (name === "--durable") durable = true;
    else {
      const value = args[++i];
      if (!value || !/^\d+$/.test(value)) throw new Error("样本数应为8至2000的8的倍数");
      samples = Number(value);
    }
  }
  if (!Number.isSafeInteger(samples) || samples < 8 || samples > 2000 || samples % 8) throw new Error("样本数应为8至2000的8的倍数");
  return { samples, durable };
}

const counts = () => ({ create: 0, run: 0, post: 0, send: 0, inspect: 0, refresh: 0, update: 0, provision: 0,
  begin: 0, card: 0, legacyEnsureFresh: 0, prepare: 0, refreshPrepared: 0, matches: 0, guard: 0 });

export function validateCounts(calls, label, expected) {
  for (const key of ["create", "inspect", "refresh", "update", "provision", "begin", "card", "refreshPrepared"]) {
    if (calls[key] !== 0) throw new Error(`有效凭证不应额外调用 ${key}`);
  }
  for (const key of ["run", "post", "send"]) if (calls[key] !== expected) throw new Error(`每轮必须且仅能调用一次 ${key}`);
  if (label === "before") {
    if (calls.legacyEnsureFresh !== expected || calls.prepare !== 0 || calls.matches !== 0 || calls.guard !== 0) throw new Error("基线凭证维护路径不一致");
  } else if (calls.legacyEnsureFresh !== 0 || calls.prepare !== expected || calls.matches < expected * 3 || calls.guard !== expected) {
    throw new Error("新版授权准备或发送前校验没有实际运行");
  }
}

function sourceFingerprint(repo) {
  const hash = createHash("sha256");
  for (const path of ["package.json", ...readdirSync(join(repo, "src"), { recursive: true }).filter(name => name.endsWith(".ts")).map(name => `src/${name}`)].sort()) {
    hash.update(path); hash.update("\0"); hash.update(readFileSync(join(repo, path))); hash.update("\0");
  }
  return hash.digest("hex");
}

function archiveBaseline(repo, destination) {
  const archived = spawnSync("git", ["archive", "--format=tar", baselineRef, "src", "package.json"], { cwd: repo, maxBuffer: 20 * 1024 * 1024 });
  if (archived.status !== 0) throw new Error("无法只读归档指定基线提交");
  mkdirSync(destination);
  const unpacked = spawnSync("tar", ["-xf", "-", "-C", destination], { input: archived.stdout, maxBuffer: 1024 * 1024 });
  if (unpacked.status !== 0) throw new Error("无法展开基线归档");
  symlinkSync(join(repo, "node_modules"), join(destination, "node_modules"), "dir");
}

async function createGroup(repo, label, durableQueue, dir) {
  const { Gateway, toConversationKey } = await import(pathToFileURL(join(repo, "src/gateway.ts")).href);
  const { GatewayStore } = await import(pathToFileURL(join(repo, "src/store.ts")).href);
  const { EmployeeAuthorizationManager } = await import(pathToFileURL(join(repo, "src/employee-auth.ts")).href);
  const { LarkChannelAdapter } = await import(pathToFileURL(join(repo, "src/lark-channel.ts")).href);
  const path = join(dir, `${label}-${durableQueue}.db`), store = new GatewayStore(path);
  store.acquireRuntimeLock();
  const group = { label, durableQueue, store, records: [], trace: undefined, calls: counts() };
  try {
    store.credentials.save(identity, { vaultId: "fixture-user-vault", credentialId: "fixture-credential", status: "ready",
      refreshToken: "synthetic-refresh-token-not-valid", expiresAt: Date.now() + 24 * 3600_000, scopes: ["calendar:calendar.event:read"] }, 0);
    store.saveSession(toConversationKey(prototypeMessage, true), "fixture-session", "fixture-agent", undefined, ["fixture-bot-vault", "fixture-user-vault"]);
    group.reader = new DatabaseSync(path, { readOnly: true });
    const forbidden = name => async () => { group.calls[name]++; throw new Error(`基准不允许远端操作 ${name}`); };
    const ark = { createSession: forbidden("create"), inspectRun: forbidden("inspect"), inspectSessionReadiness: forbidden("inspect"),
      listVaults: forbidden("provision"), createVault: forbidden("provision"), listCredentials: forbidden("provision"),
      createEnvironmentVariableCredential: forbidden("provision"), updateEnvironmentCredential: forbidden("update"),
      run: async (sessionId, input, _timeout, _progress, _delta, guard) => {
        group.calls.run++;
        if (sessionId !== "fixture-session" || !input.includes(prototypeMessage.text)) throw new Error("基准任务绑定或输入错误");
        if (guard) { group.calls.guard++; guard(); }
        group.calls.post++;
        return { terminal: "idle", messages: [reply] };
      } };
    group.auth = new EmployeeAuthorizationManager(store, ark, { applicationId: identity.installationId,
      refresh: forbidden("refresh"), begin: forbidden("begin"), poll: forbidden("begin") }, forbidden("card"), () => { throw new Error("基准不能自动续跑"); });
    const finish = (name, args, result) => {
      if (name !== (durableQueue ? "store.finishMessage" : "store.completeEvent")) return;
      const state = durableQueue ? result?.state : args[3];
      if (state !== "completed") { group.reject(new Error("基准业务未成功落盘")); return; }
      const trace = group.trace;
      trace.terminalAt = performance.now(); trace.terminalStoreMs = trace.storeMs; trace.terminalOperations = { ...trace.operations };
      group.done();
    };
    for (const [name, target] of [["store", store], ["inbox", store.inbox], ["credentials", store.credentials], ["authorizations", store.authorizations]]) {
      traceSynchronousMethods(target, name, () => group.trace, finish);
    }
    const timed = (name, operation, asyncOperation) => (...args) => {
      group.calls[name]++;
      const trace = group.trace, started = performance.now(), storeBefore = trace.storeMs;
      const complete = () => { trace.credentialMs += performance.now() - started; trace.credentialStoreMs += trace.storeMs - storeBefore; };
      if (asyncOperation) return Promise.resolve().then(() => operation(...args)).finally(complete);
      try { return operation(...args); } finally { complete(); }
    };
    const adapter = new LarkChannelAdapter({ appId: identity.installationId, appSecret: "", channel: {
      send: async (_chat, output) => {
        group.calls.send++;
        if (output.text !== reply) throw new Error("基准回复正文不符");
        group.trace.replyAt = performance.now();
        return { messageId: `reply-${group.calls.send}` };
      }
    } });
    const authOptions = label === "before"
      ? { beforeDirectTurn: timed("legacyEnsureFresh", message => group.auth.ensureCredentialFresh(message), true) }
      : { userCredentialLifecycle: { revision: "employee-credentials-v1",
        prepare: timed("prepare", message => group.auth.prepareUserTurn(message), true),
        refresh: timed("refreshPrepared", (message, proof) => group.auth.refreshPreparedAuthorization(message, proof), true),
        matches: timed("matches", (message, proof, final) => group.auth.matchesPreparedAuthorization(message, proof, final), false) } };
    group.gateway = new Gateway(store, ark, (message, output, observer) => adapter.reply(message, output, observer), {
      agentId: "fixture-agent", environmentId: "fixture-env", vaultId: "fixture-bot-vault", appId: identity.installationId,
      durableQueue, platformAccess: true, sharedGroupSessions: true, dualIdentity: true,
      timeoutMs: 5_000, progressDelayMs: 60_000, sessionConfigurationRevision: "benchmark-credentials-v1",
      getUserVaultIds: message => group.auth.vaultIds(message), inspectReply: forbidden("inspect"), ...authOptions
    });
    return group;
  } catch (error) { group.auth?.close(); group.reader?.close(); store.close(); throw error; }
}

export async function runBenchmark(options) {
  const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const candidateFingerprint = sourceFingerprint(repo);
  const dir = mkdtempSync(join(tmpdir(), "ark-credential-benchmark-")), baseline = join(dir, "baseline"), groups = [];
  const metrics = ["toTerminalMs", "storeMs", "credentialMs", "credentialStoreMs", "credentialExclusiveMs", "otherBeforeTerminalMs", "afterReplyMs"];
  try {
    archiveBaseline(repo, baseline);
    for (const [label, source] of [["before", baseline], ["after", repo]]) {
      for (const durableQueue of options.durable ? [false, true] : [false]) groups.push(await createGroup(source, label, durableQueue, dir));
    }
    for (let round = 0; round < options.samples + warmup; round++) {
      const order = balancedOrder(groups, round);
      for (let position = 0; position < order.length; position++) {
        const group = order[position], beforeCalls = { ...group.calls };
        const message = { ...prototypeMessage, messageId: `credential-${round}`, eventId: `credential-${round}`, createTime: Date.now() };
        let timer;
        const finished = new Promise((resolve, reject) => { group.done = resolve; group.reject = reject;
          timer = setTimeout(() => reject(new Error("基准任务超时")), 5_000); });
        const trace = group.trace = { storeDepth: 0, storeMs: 0, credentialMs: 0, credentialStoreMs: 0, operations: {} };
        const start = performance.now();
        try {
          if (!group.gateway.accept(message)) throw new Error("基准消息未接收");
          await finished;
          await flush();
        } finally { clearTimeout(timer); group.trace = undefined; }
        const row = group.reader.prepare("SELECT status FROM processed_events WHERE event_id = ?")
          .get(group.store.eventKey(message.channelType, message.installationId, message.eventId));
        if (row?.status !== "completed" || (group.durableQueue && group.store.inbox.findMessage(message)?.state !== "completed")) throw new Error("独立SQLite连接未读到成功终态");
        if (!(trace.terminalAt >= trace.replyAt)) throw new Error("终点必须在回复之后的终态落盘");
        const delta = Object.fromEntries(Object.keys(group.calls).map(key => [key, group.calls[key] - beforeCalls[key]]));
        validateCounts(delta, group.label, 1);
        if (round >= warmup) {
          const toTerminalMs = trace.terminalAt - start, credentialExclusiveMs = trace.credentialMs - trace.credentialStoreMs;
          group.records.push({ sample: round - warmup, position, toTerminalMs, storeMs: trace.terminalStoreMs,
            credentialMs: trace.credentialMs, credentialStoreMs: trace.credentialStoreMs, credentialExclusiveMs,
            otherBeforeTerminalMs: toTerminalMs - trace.terminalStoreMs - credentialExclusiveMs,
            afterReplyMs: trace.terminalAt - trace.replyAt, operations: trace.terminalOperations, calls: delta });
        }
      }
    }
    if (sourceFingerprint(repo) !== candidateFingerprint) throw new Error("测量期间源码发生变化，结果不能用于对照");
    for (const group of groups) validateCounts(group.calls, group.label, options.samples + warmup);
    return { baselineRef, baselineFingerprint: sourceFingerprint(baseline), candidateFingerprint,
      samples: options.samples, warmup, modes: options.durable ? [false, true] : [false], balancedOrder: true,
      externalServices: "mock", endpoint: "successful_terminal_committed_and_independent_sqlite_read",
      notes: ["预置有效用户Credential及同一Session、Vault；不包括首次配置成本", "无真实MA、OAuth或飞书调用，不代表用户端时延",
        "终点为业务成功终态落盘；独立SQLite连接在计时外验证", "credentialMs包含维护与门禁内的Store耗时；credentialStoreMs用于拆分，不能与storeMs重复相加",
        "Store计时包含SQLite、序列化、加密、租约等本地工作，不等于纯磁盘时间", "插桩和模拟调度会影响统计；不据单次P95差异宣称性能退化"],
      comparisons: (options.durable ? [false, true] : [false]).map(durableQueue => {
        const before = groups.find(group => group.label === "before" && group.durableQueue === durableQueue).records;
        const after = groups.find(group => group.label === "after" && group.durableQueue === durableQueue).records;
        return { durableQueue, pairedDelta: Object.fromEntries(metrics.map(metric => [metric, summarize(after.map((row, index) => row[metric] - before[index][metric]))])) };
      }),
      groups: groups.map(group => ({ label: group.label, durableQueue: group.durableQueue, calls: group.calls,
        metrics: Object.fromEntries(metrics.map(metric => [metric, summarize(group.records.map(row => row[metric]))])),
        positions: Array.from({ length: groups.length }, (_, position) => ({ position, count: group.records.filter(row => row.position === position).length })),
        slowest: group.records.toSorted((a, b) => b.toTerminalMs - a.toTerminalMs).slice(0, 8) })) };
  } finally {
    for (const group of groups) { group.trace = undefined; group.auth.close(); group.reader.close(); group.store.close(); }
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runBenchmark(parseOptions(process.argv.slice(2)))));
}
