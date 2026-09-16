// 本地SQLite与真实Gateway/Manager对照；远端立即返回，不测飞书或MA网络延迟。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as flush } from "node:timers/promises";

if (!process.argv[2]) throw new Error("请提供已确认commit的只读基线源码目录");
const count = Number(process.argv[3] || 200), warmup = 20;
if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error("样本数须为1至1000");
const directory = mkdtempSync(join(tmpdir(), "ark-user-preparation-bench-"));
const runtimes = [];
const groups = [];
try {
  for (const [label, source] of [["before", resolve(process.argv[2])], ["after", resolve(".")]]) {
    const { GatewayStore } = await import(pathToFileURL(join(source, "src/store.ts")).href);
    const { Gateway } = await import(pathToFileURL(join(source, "src/gateway.ts")).href);
    const { EmployeeAuthorizationManager } = await import(pathToFileURL(join(source, "src/employee-auth.ts")).href);
    for (const durableQueue of [false, true]) {
      const store = new GatewayStore(join(directory, `${label}-${durableQueue}.db`));
      store.acquireRuntimeLock();
      const completed = new Set(), completeEvent = store.completeEvent.bind(store);
      store.completeEvent = (...args) => { completeEvent(...args); if (args[3] === "completed") completed.add(args[2]); };
      const calls = { vaultList: 0, credentialList: 0, vaultCreate: 0, credentialCreate: 0, inspect: 0, run: 0, reply: 0 };
      const ark = {
        listVaults: async () => { calls.vaultList++; return []; },
        listCredentials: async () => { calls.credentialList++; return []; },
        createVault: async () => `vault-${++calls.vaultCreate}`,
        createEnvironmentVariableCredential: async () => `credential-${++calls.credentialCreate}`,
        getVault: async () => { calls.inspect++; throw new Error("正常路径不应核查"); },
        getCredential: async () => { calls.inspect++; throw new Error("正常路径不应核查"); },
        updateEnvironmentCredential: async () => { throw new Error("未过期凭证不应同步"); },
        createSession: async () => { throw new Error("应复用已有Session"); },
        run: async (_session, _text, _timeout, _onUpdate, _attachment, guard) => {
          guard?.(); calls.run++; return { terminal: "idle", messages: ["完成"] };
        }
      };
      const manager = new EmployeeAuthorizationManager(store, ark, { applicationId: "bench-app" },
        async () => { throw new Error("不应发授权卡"); }, () => { throw new Error("不应重放授权任务"); });
      const lifecycle = { revision: "benchmark-v1", prepare: (m, intent) => manager.prepareUserTurn(m, intent),
        refresh: (m, expected) => manager.refreshPreparedAuthorization(m, expected),
        matches: (m, expected, dispatch) => manager.matchesPreparedAuthorization(m, expected, dispatch),
        ...(typeof manager.captureUserTurn === "function" ? {
          capture: m => manager.captureUserTurn(m), recover: (m, intent) => manager.recoverUserTurn(m, intent),
          matchesIntent: (m, intent) => manager.matchesUserTurnIntent(m, intent)
        } : {}) };
      const gateway = new Gateway(store, ark, async () => { calls.reply++; }, { agentId: "agent", environmentId: "env",
        vaultId: "bot-vault", timeoutMs: 2000, platformAccess: true, dualIdentity: true, durableQueue,
        sessionConfigurationRevision: "benchmark-v1", userCredentialLifecycle: lifecycle });
      const runtime = { label, durableQueue, store, manager, gateway, calls, completed };
      runtimes.push(runtime);
      for (const bound of [false, true]) groups.push({ runtime, bound, samples: [], calls: undefined });
    }
  }
  for (const bound of [false, true]) {
    const selected = groups.filter(g => g.bound === bound);
    const baselines = new Map(selected.map(g => [g, { ...g.runtime.calls }]));
    for (let index = 0; index < count + warmup; index++) for (const group of index % 2 ? selected.toReversed() : selected) {
      const { runtime } = group, { store, gateway } = runtime;
      const user = `user-${bound}-${index}`, messageId = `message-${bound}-${index}`;
      const identity = { channelType: "lark", installationId: "bench-app", tenantId: "tenant", openId: user };
      const message = { ...identity, senderId: user, messageId, eventId: messageId, text: "你好",
        conversationId: `chat-${user}`, conversationType: "direct", resources: [], createTime: Date.now(),
        threadId: "", rootMessageId: "", parentMessageId: "", mentionedBot: false };
      if (bound) store.credentials.save(identity, { vaultId: `bound-vault-${index}`, credentialId: `bound-credential-${index}`,
        status: "ready", scopes: ["calendar:read"], expiresAt: Date.now() + 3600000, refreshToken: "synthetic" }, 0);
      store.saveSession(message, `session-${user}`, "agent");
      const started = performance.now();
      assert.equal(gateway.accept(message), true);
      for (;;) {
        const task = runtime.durableQueue ? store.inbox.findMessage(message) : undefined;
        const done = runtime.durableQueue ? task?.state === "completed" : runtime.completed.has(messageId);
        if (done) break;
        if (performance.now() - started > 2000) throw new Error("基准业务未按时完成");
        await flush();
      }
      if (index >= warmup) group.samples.push(performance.now() - started);
    }
    for (const group of selected) {
      group.calls = Object.fromEntries(Object.entries(group.runtime.calls).map(([key, value]) => [key, value - baselines.get(group)[key]]));
      const expected = count + warmup;
      assert.deepEqual(group.calls, { vaultList: bound ? 0 : expected, credentialList: bound ? 0 : expected,
        vaultCreate: bound ? 0 : expected, credentialCreate: bound ? 0 : expected, inspect: 0, run: expected, reply: expected });
    }
  }
  console.log(JSON.stringify({ externalServices: "mock", storage: "file-backed SQLite", count, warmup,
    includes: "Gateway.accept到Inbox/event完成；排除预置测试Session/已绑定凭证；同进程交替顺序",
    groups: groups.map(({ runtime, bound, calls, samples }) => {
      samples.sort((a, b) => a - b);
      return { label: runtime.label, durableQueue: runtime.durableQueue, bound, calls,
        p50Ms: samples[Math.ceil(samples.length * .5) - 1], p95Ms: samples[Math.ceil(samples.length * .95) - 1] };
    }) }));
} finally {
  for (const { manager, store } of runtimes) { manager.close(); store.close(); }
  rmSync(directory, { recursive: true, force: true });
}
