import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import { startEmployeeWeb } from "../src/web.ts";
import { Gateway } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import type { EmployeeConfig } from "../src/config.ts";
import type { ChannelMessage } from "../src/channel.ts";

const config: EmployeeConfig = { arkApiKey: "secret", arkAgentId: "agent", arkEnvironmentId: "env", arkBaseUrl: "https://example.invalid",
  arkVaultId: "vault", arkCredentialId: "credential", feishuAppId: "app", feishuAppSecret: "app-secret", feishuBotName: "测试数字员工",
  databasePath: ":memory:", sessionTimeoutMs: 1000, webHost: "127.0.0.1", webPort: 0, webToken: "web-secret" };
const message: ChannelMessage = { channelType: "lark", installationId: "app", tenantId: "tenant", senderId: "user", conversationId: "chat",
  conversationType: "direct", threadId: "", rootMessageId: "", parentMessageId: "", messageId: "original", eventId: "event",
  createTime: 1, text: "private request", resources: [], mentionedBot: false };
const headers = { Authorization: "Bearer web-secret", "Content-Type": "application/json" };

test("HTTP queue control requires admin token, JSON, same origin, current revision and explicit confirmation", async () => {
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock(); let queries = 0, runs = 0;
  const gateway = new Gateway(store, { createSession: async () => "session", run: async () => { runs++; throw new Error("lost"); },
    inspectRun: async () => { queries++; return { status: "ended", anchorEventId: "anchor", terminalEventId: "terminal", result: { terminal: "idle", messages: ["private model result"] } }; }
  }, async () => {}, { agentId: "agent", environmentId: "env", vaultId: "vault", appId: "app", platformAccess: true,
    durableQueue: true, sharedGroupSessions: true, timeoutMs: 1000, sessionCompaction: false });
  gateway.accept(message);
  for (let n = 0; n < 100 && store.inbox.findMessage(message)?.state !== "uncertain"; n++) await flush();
  const task = store.inbox.findMessage(message)!; assert.equal(task.state, "uncertain");
  const web = await startEmployeeWeb({ store, config, recovery: gateway }); const base = web.url.split("/#")[0], endpoint = base + "/api/employees/agent/recovery";
  const body = { id: task.id, revision: task.revision, action: "discard", confirmDiscard: task.id };
  const post = (value: unknown, extra: Record<string, string> = {}) => fetch(endpoint, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(value) });
  try {
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await post(body, { Authorization: "wrong" })).status, 401);
    assert.equal((await post(body, { Origin: "https://attacker.invalid" })).status, 403);
    assert.equal((await post(body, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await post(body, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post({ ...body, confirmDiscard: false })).status, 400);
    assert.equal((await post({ ...body, revision: 1.5 })).status, 400);
    assert.equal((await post({ ...body, action: "retry" })).status, 400);
    assert.equal((await post({ ...body, revision: 1 })).status, 409);
    assert.equal((await fetch(endpoint + "?after=-1", { headers })).status, 400);
    assert.equal((await fetch(base + "/api/employees/foreign/recovery", { headers })).status, 404);
    assert.equal(queries, 0);
    const listing = await (await fetch(endpoint, { headers })).text();
    assert.doesNotMatch(listing, /private|secret|requestFingerprint/); assert.equal(JSON.parse(listing).items.length, 1);
    assert.equal((await post(body, { Origin: base })).status, 200);
    assert.equal(store.inbox.findMessage(message)!.state, "failed"); assert.equal(runs, 1); assert.equal(queries, 1);
    assert.equal((await post(body)).status, 409);
    assert.equal((await (await fetch(endpoint, { headers })).json() as any).items.length, 0);
    const html = await (await fetch(base)).text();
    assert.match(html, /待处理任务/); assert.match(html, /window.confirm/); assert.match(html, /不会撤销已创建/);
  } finally { await new Promise<void>(resolve => web.server.close(() => resolve())); store.close(); }
});

test("unsupported queue is explicit and HTTP action errors never echo underlying payload", async () => {
  const store = new GatewayStore(":memory:");
  const web = await startEmployeeWeb({ store, config, recovery: {
    listRecoveryTasks: () => ({ enabled: false, items: [] }),
    controlRecoveryTask: async () => { throw new Error("credential-secret raw request"); }
  } });
  const endpoint = web.url.split("/#")[0] + "/api/employees/agent/recovery";
  try {
    assert.deepEqual(await (await fetch(endpoint, { headers })).json(), { enabled: false, items: [] });
    const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ id: "12345678-1234-1234-1234-123456789abc", revision: 1, action: "reconcile" }) });
    assert.equal(response.status, 409); assert.doesNotMatch(await response.text(), /credential-secret|raw request/);
    const invalid = await fetch(endpoint, { method: "POST", headers, body: "{" }); assert.equal(invalid.status, 400);
  } finally { await new Promise<void>(resolve => web.server.close(() => resolve())); store.close(); }
});
