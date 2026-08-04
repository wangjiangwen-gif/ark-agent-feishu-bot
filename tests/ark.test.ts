import test from "node:test";
import assert from "node:assert/strict";
import { ArkClient, drainEventBuffer, eventProgress, eventText, resultFromEvents } from "../src/ark.ts";

test("drainEventBuffer parses SSE frames split from network chunks", () => {
  const first = drainEventBuffer('data: {"type":"agent.message","id":"1"}\n\ndata: {"type":"session.');
  assert.equal(first.events.length, 1);
  const second = drainEventBuffer(first.rest + 'status_idle","id":"2"}\n\n');
  assert.equal(second.events[0].type, "session.status_idle");
});

test("drainEventBuffer parses NDJSON without treating chunks as events", () => {
  const result = drainEventBuffer('{"type":"agent.message","id":"1"}\n{"type":"session.status_idle"}\n');
  assert.equal(result.events.length, 2);
});

test("eventText joins text blocks only", () => {
  assert.equal(eventText({ content: [{ type: "text", text: "甲" }, { type: "image" }, { type: "text", text: "乙" }] }), "甲\n乙");
});

test("Ark requests configure lark-cli, Vault credential and Session binding", async () => {
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  const client = new ArkClient("key", "https://ark.example/api/v3", async (url, init) => {
    const path = String(url).replace("https://ark.example/api/v3", "");
    calls.push({ path, method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/environments") return new Response(JSON.stringify({ id: "env-1", name: "env" }), { status: 200 });
    if (path === "/environments/env-1") return new Response(JSON.stringify({ id: "env-1", config: {
      type: "cloud", networking: { type: "unrestricted" },
      env: { LARKSUITE_CLI_APP_ID: "cli-1", KEEP_ME: "yes" },
      setup_script: "setup"
    } }), { status: 200 });
    if (path === "/vaults") return new Response(JSON.stringify({ id: "vlt-1" }), { status: 200 });
    if (path.endsWith("/credentials")) return new Response(JSON.stringify({ id: "vcrd-1" }), { status: 200 });
    if (path.endsWith("/credentials/vcrd-1")) return new Response(JSON.stringify({ id: "vcrd-1" }), { status: 200 });
    return new Response(JSON.stringify({ id: "sesn-1" }), { status: 200 });
  });
  await client.createEnvironment("env", "cli-1");
  const vault = await client.createVault("vault");
  const credential = await client.createEnvironmentCredential(vault, "token", "uat");
  await client.updateEnvironmentCredential(vault, credential, "uat-2");
  await client.createSession("agent-1", "env-1", [vault], { FEISHU_USER_OPEN_ID: "ou-message-user" });
  assert.deepEqual(calls[0].body, {
    name: "env",
    config: {
      type: "cloud", networking: { type: "unrestricted" },
      env: { LARKSUITE_CLI_APP_ID: "cli-1" },
      setup_script: "set -e\nnpm install -g @larksuite/cli\nlark-cli --version"
    }
  });
  assert.deepEqual(calls.at(-1)?.body, {
    agent: "agent-1",
    environment: {
      id: "env-1",
      type: "environment_with_overrides",
      config: {
        type: "cloud", networking: { type: "unrestricted" },
        env: { LARKSUITE_CLI_APP_ID: "cli-1", KEEP_ME: "yes", FEISHU_USER_OPEN_ID: "ou-message-user" },
        setup_script: "setup"
      }
    },
    vault_ids: ["vlt-1"]
  });
  assert.equal(calls.at(-1)?.body?.environment_id, undefined);
});

test("Ark creates an office Agent with the requested tools and system prompt", async () => {
  let body: Record<string, unknown> = {};
  const client = new ArkClient("key", "https://ark.example/api/v3", async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: "agent-office", version: 1 }), { status: 200 });
  });
  const agent = await client.createAgent({
    name: "飞书办公助手（方舟 MA 版）", description: "desc",
    model: { id: "doubao-seed-2-1-pro-260628" }, system: "use lark-cli",
    tools: [{ type: "agent_toolset_20260701" }], skills: [], mcp_servers: [], metadata: { created_via: "ark-feishu-cli" }
  });
  assert.equal(agent.id, "agent-office");
  assert.equal(body.name, "飞书办公助手（方舟 MA 版）");
  assert.deepEqual(body.tools, [{ type: "agent_toolset_20260701" }]);
});

test("eventProgress exposes descriptions but never raw shell commands", () => {
  assert.equal(eventProgress({ type: "agent.tool_use", name: "bash", input: { description: "检查 lark-cli", command: "env | grep TOKEN" } }), "正在执行：检查 lark-cli");
  assert.equal(eventProgress({ type: "agent.tool_use", name: "read", input: { file_path: "/secret" } }), "正在调用工具：read");
  assert.equal(eventProgress({ type: "agent.tool_result", is_error: true }), "工具执行未成功，Agent 正在尝试恢复");
  assert.equal(eventProgress({ type: "agent.thinking" }), undefined);
});

test("resultFromEvents only recovers a terminal result from the current run", () => {
  const since = Date.parse("2026-07-21T17:00:00+08:00");
  const result = resultFromEvents([
    { type: "agent.message", processed_at: "2026-07-21T16:59:00+08:00", content: [{ type: "text", text: "旧回复" }] },
    { type: "agent.message", processed_at: "2026-07-21T17:00:01+08:00", content: [{ type: "text", text: "新回复" }] },
    { type: "session.status_idle", processed_at: "2026-07-21T17:00:02+08:00" }
  ], since);
  assert.deepEqual(result, { terminal: "idle", messages: ["新回复"] });
});

test("run establishes SSE before sending the user message", async () => {
  const calls: string[] = [];
  const client = new ArkClient("key", "https://ark.example/api/v3", async url => {
    const path = String(url).replace("https://ark.example/api/v3", "");
    calls.push(path);
    if (path.endsWith("/events/stream")) {
      return new Response([
        'data: {"type":"agent.message","content":[{"type":"text","text":"完成"}]}',
        "",
        'data: {"type":"session.status_idle"}',
        ""
      ].join("\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("{}", { status: 200 });
  });
  const result = await client.run("session-1", "你好", 5_000);
  assert.deepEqual(calls, ["/sessions/session-1/events/stream", "/sessions/session-1/events"]);
  assert.deepEqual(result, { terminal: "idle", messages: ["完成"] });
});
