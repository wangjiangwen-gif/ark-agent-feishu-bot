// 性能诊断，不是业务实现；仅模拟MA/飞书，真实Gateway、SQLite与Channel适配层。
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setImmediate as flush } from "node:timers/promises";

export function balancedOrder(values, round) {
  const offset = round % values.length;
  const order = [...values.slice(offset), ...values.slice(0, offset)];
  return Math.floor(round / values.length) % 2 ? order.toReversed() : order;
}

export function summarize(values) {
  if (!values.length || values.some(value => !Number.isFinite(value))) throw new Error("计时样本无效");
  const sorted = values.toSorted((a, b) => a - b);
  return { count: sorted.length, minMs: sorted[0], p50Ms: sorted[Math.floor((sorted.length - 1) * .5)],
    p95Ms: sorted[Math.floor((sorted.length - 1) * .95)], maxMs: sorted.at(-1), meanMs: values.reduce((a, b) => a + b, 0) / values.length };
}

export function traceSynchronousMethods(target, prefix, currentTrace, completed, clock = () => performance.now()) {
  const names = [];
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(target)))) {
    if (name === "constructor" || typeof descriptor.value !== "function") continue;
    const original = descriptor.value;
    if (original.constructor.name === "AsyncFunction") throw new Error("这里只能计时同步Store方法");
    if (Object.hasOwn(target, name)) throw new Error("不能覆盖实例已有方法");
    target[name] = function (...args) {
      const trace = currentTrace();
      if (!trace) return original.apply(this, args);
      const outermost = trace.storeDepth++ === 0, start = outermost ? clock() : 0;
      let result;
      try { result = original.apply(this, args); }
      finally {
        trace.storeDepth--;
        if (outermost) {
          const elapsed = clock() - start;
          trace.storeMs += elapsed;
          const key = `${prefix}.${name}`;
          trace.operations[key] = (trace.operations[key] || 0) + elapsed;
        }
      }
      completed(`${prefix}.${name}`, args, result);
      return result;
    };
    names.push(name);
  }
  return () => { for (const name of names) delete target[name]; };
}

async function main() {
  if (!process.argv[2] || !process.argv[3]) throw new Error("参数：基线源码目录 对照源码目录 [样本数，8的倍数]");
  const baseline = resolve(process.argv[2]), candidate = resolve(process.argv[3]);
  const samples = Number(process.argv[4] || 512), warmup = 16;
  if (!Number.isSafeInteger(samples) || samples < 8 || samples > 2000 || samples % 8) throw new Error("样本数应为8至2000的8的倍数");
  const dir = mkdtempSync(join(tmpdir(), "ark-reply-profile-")), groups = [];
  const metrics = ["toTerminalMs", "storeMs", "replyExclusiveMs", "otherBeforeTerminalMs", "afterTerminalMs", "totalMs"];
  try {
    for (const [label, repo] of [["before", baseline], ["after", candidate]]) {
      const { Gateway } = await import(pathToFileURL(join(repo, "src/gateway.ts")).href);
      const { GatewayStore } = await import(pathToFileURL(join(repo, "src/store.ts")).href);
      const { LarkChannelAdapter } = await import(pathToFileURL(join(repo, "src/lark-channel.ts")).href);
      for (const durableQueue of [false, true]) {
        const store = new GatewayStore(join(dir, `${label}-${durableQueue}.db`)); store.acquireRuntimeLock();
        const group = { label, durableQueue, store, records: {}, text: "", trace: undefined,
          calls: { create: 0, run: 0, send: 0, inspect: 0, observer: 0 } };
        groups.push(group);
        const completed = (name, args, result) => {
          if (name !== (durableQueue ? "store.finishMessage" : "store.completeEvent")) return;
          const state = durableQueue ? result.state : args[3];
          if (state !== "completed") { group.reject(new Error(`基准任务没有成功结束：${state}`)); return; }
          group.trace.terminalAt = performance.now();
          group.trace.terminalStoreMs = group.trace.storeMs;
          group.trace.terminalOperations = { ...group.trace.operations };
          group.done();
        };
        for (const [name, target] of [["store", store], ["inbox", store.inbox]]) traceSynchronousMethods(target, name, () => group.trace, completed);
        const adapter = new LarkChannelAdapter({ appId: "app", appSecret: "", channel: {
          send: async (_chat, input) => {
            group.calls.send++;
            if (input.text !== group.text) throw new Error("回复正文不一致");
            const id = `reply-${group.calls.send}`; return { messageId: id, chunkIds: [id, id + "-last"] };
          }
        } });
        group.gateway = new Gateway(store, {
          createSession: async () => { group.calls.create++; return "session"; },
          run: async () => { group.calls.run++; return { terminal: "idle", messages: [group.text] }; }
        }, async (message, outbound, observer) => {
          if (observer) group.calls.observer++;
          const beforeStore = group.trace.storeMs, started = performance.now();
          await adapter.reply(message, outbound, observer);
          group.trace.replyExclusiveMs += performance.now() - started - (group.trace.storeMs - beforeStore);
        }, {
          agentId: "agent", environmentId: "env", vaultId: "vault", appId: "app", platformAccess: true, sharedGroupSessions: true,
          durableQueue, timeoutMs: 5000, sessionCompaction: false,
          inspectReply: async () => { group.calls.inspect++; throw new Error("正常发送不应核查"); }
        });
      }
    }
    for (const [scenario, text] of [["short", "回复".repeat(50)], ["long", "长回复\n".repeat(5000)]]) {
      for (const group of groups) group.records[scenario] = [];
      for (let n = 0; n < samples + warmup; n++) {
        const order = balancedOrder(groups, n);
        for (let position = 0; position < order.length; position++) {
          const group = order[position], id = `${scenario}-${n}`;
          group.text = text;
          const message = { channelType: "lark", installationId: "app", tenantId: "tenant", senderId: "user", conversationType: "direct",
            conversationId: "chat", messageId: id, eventId: id, threadId: "", rootMessageId: "", parentMessageId: "", createTime: Date.now(),
            mentionedBot: false, text: "测试", resources: [] };
          let timer;
          const finished = new Promise((resolve, reject) => {
            group.done = resolve; group.reject = reject; timer = setTimeout(() => reject(new Error("基准任务超时")), 5000);
          });
          const trace = group.trace = { storeDepth: 0, storeMs: 0, replyExclusiveMs: 0, operations: {} };
          const start = performance.now();
          if (!group.gateway.accept(message)) throw new Error("基准消息未接收");
          try { await finished; await flush(); } finally { clearTimeout(timer); group.trace = undefined; }
          const end = performance.now(), toTerminalMs = trace.terminalAt - start;
          if (n >= warmup) group.records[scenario].push({ sample: n - warmup, position, toTerminalMs, storeMs: trace.terminalStoreMs,
            replyExclusiveMs: trace.replyExclusiveMs, otherBeforeTerminalMs: toTerminalMs - trace.terminalStoreMs - trace.replyExclusiveMs,
            afterTerminalMs: end - trace.terminalAt, totalMs: end - start, operations: trace.terminalOperations });
          if (group.durableQueue && group.store.inbox.findMessage(message)?.state !== "completed") throw new Error("任务检查点不一致");
        }
      }
    }
    const expected = (samples + warmup) * 2;
    for (const group of groups) {
      const c = group.calls;
      if (c.create !== 1 || c.run !== expected || c.send !== expected || c.inspect !== 0 || c.observer !== (group.durableQueue ? expected : 0)) throw new Error("调用数量或模式不符");
    }
    const comparisons = [];
    for (const durableQueue of [false, true]) for (const scenario of ["short", "long"]) {
      const [before, after] = groups.filter(group => group.durableQueue === durableQueue).map(group => group.records[scenario]);
      comparisons.push({ durableQueue, scenario, pairedDelta: Object.fromEntries(metrics.map(metric => [metric,
        summarize(after.map((row, n) => row[metric] - before[n][metric]))])) });
    }
    console.log(JSON.stringify({ baseline, candidate, sameSourceControl: baseline === candidate, samples, warmup, balancedOrder: true,
      externalServices: "mock", notes: ["均衡每个变体在每个执行位置的样本数", "终点为成功终态落盘，不以reply回调代替完成", "Store嵌套调用不重复计时，适配层耗时扣除Store时间", "同步Store计时含其方法内的加密/序列化，不等于纯磁盘耗时", "统计受计时插桩开销影响，不是用户端时延"], comparisons,
      groups: groups.map(({ label, durableQueue, calls, records }) => ({ label, durableQueue, calls,
        scenarios: Object.fromEntries(Object.entries(records).map(([scenario, rows]) => [scenario, {
          metrics: Object.fromEntries(metrics.map(metric => [metric, summarize(rows.map(row => row[metric]))])),
          positions: Array.from({ length: 4 }, (_, position) => ({ position, totalMs: summarize(rows.filter(row => row.position === position).map(row => row.totalMs)) })),
          slowest: rows.toSorted((a, b) => b.totalMs - a.totalMs).slice(0, 8)
        }])) })) }));
  } finally {
    for (const group of groups) { group.trace = undefined; group.store.close(); }
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
