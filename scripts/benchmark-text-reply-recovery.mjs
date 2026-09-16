// 交替对照Gateway、真实SQLite和Channel适配层；外部发送/MA为模拟，不代表用户端时延。
// 旧测量口径保留供复现：reply后的setImmediate也计入总耗时，且顺序仅正反交替。
// 定位回退时使用profile-text-reply-recovery.mjs：成功落盘终点、分段计时、均衡位置与A/A校准。
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setImmediate as flush } from "node:timers/promises";

if (!process.argv[2]) throw new Error("需要提供基线源码目录");
const samples = Number(process.argv[3] || 200), warmup = 10;
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 1000) throw new Error("样本数应为1至1000");
const dir = mkdtempSync(join(tmpdir(), "ark-text-reply-bench-"));
const groups = [];
try {
  for (const [label, repo] of [["before", resolve(process.argv[2])], ["after", resolve(".")]]) {
    const { Gateway } = await import(pathToFileURL(join(repo, "src/gateway.ts")).href);
    const { GatewayStore } = await import(pathToFileURL(join(repo, "src/store.ts")).href);
    const { LarkChannelAdapter } = await import(pathToFileURL(join(repo, "src/lark-channel.ts")).href);
    for (const durableQueue of [false, true]) {
      const store = new GatewayStore(join(dir, `${label}-${durableQueue}.db`)); store.acquireRuntimeLock();
      const group = { label, durableQueue, store, text: "", done: undefined, times: {}, calls: { create: 0, run: 0, send: 0, inspect: 0 } };
      const adapter = new LarkChannelAdapter({ appId: "app", appSecret: "", channel: {
        send: async (_chat, input) => {
          group.calls.send++;
          if (input.text !== group.text) throw new Error("回复正文发生变化");
          const id = `reply-${group.calls.send}`;
          return { messageId: id, chunkIds: [id, id + "-last"] };
        }
      } });
      group.gateway = new Gateway(store, {
        createSession: async () => { group.calls.create++; return "session"; },
        run: async () => { group.calls.run++; return { terminal: "idle", messages: [group.text] }; }
      }, async (message, outbound, observer) => { await adapter.reply(message, outbound, observer); group.done(); }, {
        agentId: "agent", environmentId: "env", vaultId: "vault", appId: "app", platformAccess: true, sharedGroupSessions: true,
        durableQueue, timeoutMs: 5000, sessionCompaction: false,
        inspectReply: async () => { group.calls.inspect++; throw new Error("正常发送不应核查"); }
      });
      groups.push(group);
    }
  }
  for (const [scenario, text] of [["short", "回复".repeat(50)], ["long", "长回复\n".repeat(5000)]]) {
    for (const group of groups) group.times[scenario] = [];
    for (let n = 0; n < samples + warmup; n++) for (const group of n % 2 ? groups.toReversed() : groups) {
      group.text = text;
      const id = `${scenario}-${n}`;
      const message = { channelType: "lark", installationId: "app", tenantId: "tenant", senderId: "user", conversationType: "direct",
        conversationId: "chat", messageId: id, eventId: id, threadId: "", rootMessageId: "", parentMessageId: "", createTime: Date.now(),
        mentionedBot: false, text: "测试", resources: [] };
      let timer;
      const finished = new Promise((resolve, reject) => {
        group.done = resolve; timer = setTimeout(() => reject(new Error("基准请求超时")), 5000);
      });
      const start = performance.now();
      group.gateway.accept(message);
      try { await finished; await flush(); } finally { clearTimeout(timer); }
      if (n >= warmup) group.times[scenario].push(performance.now() - start);
      if (group.durableQueue && group.store.inbox.findMessage(message)?.state !== "completed") throw new Error("任务未完成");
    }
  }
  const expected = (samples + warmup) * 2;
  for (const { calls } of groups) if (calls.create !== 1 || calls.run !== expected || calls.send !== expected || calls.inspect !== 0) throw new Error("外部调用数发生变化");
  console.log(JSON.stringify({ baseline: resolve(process.argv[2]), samples, warmup, externalServices: "mock", alternatingOrder: true,
    groups: groups.map(({ label, durableQueue, calls, times }) => ({ label, durableQueue, calls,
      times: Object.fromEntries(Object.entries(times).map(([scenario, values]) => {
        values.sort((a, b) => a - b);
        return [scenario, { p50Ms: values[Math.floor((values.length - 1) * .5)], p95Ms: values[Math.floor((values.length - 1) * .95)] }];
      })) })) }));
} finally {
  for (const group of groups) group.store.close();
  rmSync(dir, { recursive: true, force: true });
}
