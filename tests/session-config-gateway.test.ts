import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Gateway } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import type { ChannelMessage } from "../src/channel.ts";
import type { SessionConfiguration } from "../src/session-config.ts";

const message = (id: string): ChannelMessage => ({ channelType: "lark", installationId: "app", tenantId: "tenant", eventId: id, messageId: id,
  conversationType: "group", conversationId: "chat", threadId: "", rootMessageId: "", parentMessageId: "", createTime: Date.now(), senderId: "user", text: "测试", resources: [], mentionedBot: true });
async function until(fn: () => boolean) { const end = Date.now() + 2000; while (!fn()) { if (Date.now() > end) throw new Error("test timeout"); await delay(5); } }
function harness(store: GatewayStore, configuration?: SessionConfiguration, hook?: any) {
  const requests: any[] = [], inputs: string[] = [], replies: string[] = [], environments: string[] = [];
  const gateway = new Gateway(store, {
    buildSessionCreateRequest: async defaults => {
      environments.push(defaults.environmentId);
      return { agent: defaults.agentId, environment: { id: defaults.environmentId, type: "environment_with_overrides", config: { type: "cloud", env: { APP_BASE: defaults.environmentId, ...defaults.envOverrides }, setup_script: `setup-${defaults.environmentId}` } }, vault_ids: defaults.vaultIds };
    },
    createSession: async request => { requests.push(request); return `session-${requests.length}`; },
    uploadFile: async () => ({ id: "file-test", name: "file.pdf" }),
    run: async (_id, input) => { inputs.push(input); return { terminal: "idle", messages: ["完成"] }; }
  }, async (_message, reply) => { if (reply.type === "text") replies.push(reply.text); }, {
    agentId: "agent", environmentId: "base-env", vaultId: "bot", appId: "app", platformAccess: true, sharedGroupSessions: true,
    timeoutMs: 1000, sessionCompaction: false, sessionConfiguration: configuration,
    buildSessionRequest: hook, downloadAttachment: async () => ({ bytes: new Uint8Array([1]), mimeType: "application/pdf" })
  });
  return { gateway, requests, inputs, replies, environments };
}

test("gateway loads the configured Environment and appends files after native resource replacement", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  const h = harness(store, { schemaVersion: 1, group: { request: { environment_id: "custom-env", future_field: [1, 2], resources: [{ type: "memory_store", memory_store_id: "mem" }] } } },
    (_message: unknown, draft: any) => ({ ...draft, resources: [{ type: "future", id: "hook" }] }));
  h.gateway.accept({ ...message("files"), resources: [{ id: "file", name: "file.pdf", type: "file" }] });
  await until(() => h.replies.length > 0);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].resources.map((x: any) => x.type), ["future", "file"]);
  assert.equal(h.requests[0].environment.config.setup_script, "setup-custom-env");
  assert.equal(h.requests[0].environment.config.env.APP_BASE, "custom-env");
  assert.deepEqual(h.requests[0].future_field, [1, 2]);
});

test("hook changing Environment hydrates the new base without retaining the old setup", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  const h = harness(store, undefined, (_message: unknown, draft: any) => {
    const { environment, ...rest } = draft; return { ...rest, environment_id: "hook-env" };
  });
  h.gateway.accept(message("hook")); await until(() => h.replies.length > 0);
  assert.deepEqual(h.environments, ["base-env", "hook-env"]);
  assert.equal(h.requests[0].environment.config.setup_script, "setup-hook-env");
});

test("hook cannot hide conflicting Environment aliases during final hydration", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  const h = harness(store, undefined, (_message: unknown, draft: any) => ({ ...draft, environment_id: "other" }));
  h.gateway.accept(message("conflict")); await until(() => h.replies.length > 0);
  assert.equal(h.requests.length, 0);
  assert.match(h.replies[0], /environment.*冲突/);
});

test("startup rejects misbound Agent or unknown group Vault without creating a Session", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  for (const request of [{ agent: "other" }, { vault_ids: ["unclassified"] }]) {
    const h = harness(store, { schemaVersion: 1, group: { request } });
    await assert.rejects(h.gateway.validateConfiguration());
    assert.equal(h.requests.length, 0);
  }
});

test("changing configuration warns but preserves existing Session and files", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  const first = harness(store, { schemaVersion: 1, group: { request: { title: "old" } } });
  first.gateway.accept(message("one")); await until(() => first.replies.length > 0);
  const before = store.getSessionConfiguration("session-1");
  const second = harness(store, { schemaVersion: 1, group: { request: { title: "new" } } });
  second.gateway.accept(message("two")); await until(() => second.replies.length > 0);
  assert.equal(second.requests.length, 0);
  assert.match(second.inputs[0], /新配置未应用到旧Session/);
  assert.deepEqual(store.getSessionConfiguration("session-1"), before);
});

test("startup does not execute developer hook or create resources", async t => {
  const store = new GatewayStore(":memory:"); t.after(() => store.close());
  const h = harness(store, undefined, () => { throw new Error("hook must not execute"); });
  await h.gateway.validateConfiguration();
  assert.equal(h.requests.length, 0);
  assert.equal(h.inputs.length, 0);
});
