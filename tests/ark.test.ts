import test from "node:test";
import assert from "node:assert/strict";
import { ArkClient, drainEventBuffer, eventProgress, eventText, eventUserAuthorizationRequired, resultFromEvents } from "../src/ark.ts";

test("Ark network failures identify the failed API operation", async () => {
  const client = new ArkClient("key", "https://ark.example.com", async () => {
    throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
  });

  await assert.rejects(client.getAgent("agent-one"), /方舟网络请求失败.*GET \/agents\/agent-one.*ECONNRESET/);
});

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

test("lark-cli user token_missing is parsed from a successful MA tool_result envelope", () => {
  const toolUse = {
    type: "agent.tool_use", id: "call-one", name: "bash",
    input: { command: "lark-cli calendar +agenda --as user", description: "查询日程" }
  };
  const toolResult = {
    type: "agent.tool_result", tool_use_id: "call-one", is_error: false,
    content: [{ type: "text", text: `exit_code: 3\n--- stdout ---\n\n--- stderr ---\n{\n  "ok": false,\n  "identity": "user",\n  "error": {\n    "type": "authentication",\n    "subtype": "token_missing",\n    "message": "no access token available for user"\n  }\n}` }]
  };

  assert.deepEqual(eventUserAuthorizationRequired(toolResult, new Map([["call-one", "calendar"]])), {
    identity: "user", errorType: "authentication", subtype: "token_missing", domain: "calendar"
  });
  assert.equal(eventUserAuthorizationRequired({ ...toolResult, content: [{ type: "text", text: "exit_code: 2\n--- stderr ---\n{}" }] }, new Map()), undefined);
  assert.equal(eventUserAuthorizationRequired({ ...toolResult, content: [{ type: "text", text: `exit_code: 3\n--- stderr ---\n{"ok":false,"identity":"bot","error":{"type":"authorization","subtype":"app_scope_not_applied"}}` }] }, new Map()), undefined);
  assert.equal((toolUse.input.command.match(/lark-cli\s+([\w-]+)/) || [])[1], "calendar");
});

test("lark-cli token_missing is parsed from numbered combined tool output", () => {
  const toolResult = {
    type: "agent.tool_result", tool_use_id: "call-numbered", is_error: false,
    content: [{ type: "text", text: `exit_code: 3
--- output (stdout + stderr) ---
     1\t{
     2\t  "ok": false,
     3\t  "identity": "user",
     4\t  "error": {
     5\t    "type": "authentication",
     6\t    "subtype": "token_missing",
     7\t    "message": "no access token available for user"
     8\t  }
     9\t}
` }]
  };

  assert.deepEqual(eventUserAuthorizationRequired(toolResult, new Map([["call-numbered", "calendar"]])), {
    identity: "user", errorType: "authentication", subtype: "token_missing", domain: "calendar"
  });
});

test("resultFromEvents preserves user authorization requirements despite MA is_error false", () => {
  const processedAt = new Date(Date.now() + 1_000).toISOString();
  const result = resultFromEvents([
    { type: "agent.tool_use", id: "call-one", name: "bash", input: { command: "lark-cli calendar +agenda --as user" }, processed_at: processedAt },
    { type: "agent.tool_result", tool_use_id: "call-one", is_error: false, content: [{ type: "text", text: `exit_code: 3\n--- stdout ---\n\n--- stderr ---\n{"ok":false,"identity":"user","error":{"type":"authentication","subtype":"token_missing"}}` }], processed_at: processedAt },
    { type: "agent.message", content: [{ type: "text", text: "请先授权" }], processed_at: processedAt },
    { type: "session.status_idle", processed_at: processedAt }
  ], Date.now());

  assert.deepEqual(result?.authorizationRequired, {
    identity: "user", errorType: "authentication", subtype: "token_missing", domain: "calendar"
  });
});

test("run stops streaming Agent denial text after lark-cli requests user authorization", async () => {
  const snapshots: string[] = [];
  const events = [
    { type: "agent.tool_use", id: "call-one", name: "bash", input: { command: "lark-cli calendar +agenda --as user" } },
    { type: "agent.tool_result", tool_use_id: "call-one", is_error: false, content: [{ type: "text", text: `exit_code: 3\n--- stdout ---\n\n--- stderr ---\n{"ok":false,"identity":"user","error":{"type":"authentication","subtype":"token_missing"}}` }] },
    { type: "agent.message", content: [{ type: "text", text: "你没有凭证，请自行授权" }] },
    { type: "session.status_idle" }
  ];
  const client = new ArkClient("key", "https://ark.example/api/v3", async url => {
    if (String(url).includes("/events/stream")) {
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });

  const result = await client.run("session-1", "查日程", 5_000, undefined, async snapshot => { snapshots.push(snapshot); });

  assert.deepEqual(snapshots, []);
  assert.equal(result.authorizationRequired?.domain, "calendar");
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
      env: {
        LARKSUITE_CLI_APP_ID: "cli-1",
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        LARKSUITE_CLI_STRICT_MODE: "off"
      },
      setup_script: (calls[0].body?.config as Record<string, unknown>).setup_script
    }
  });
  assert.match(String((calls[0].body?.config as Record<string, unknown>).setup_script), /sha256sum -c -/);
  assert.doesNotMatch(String((calls[0].body?.config as Record<string, unknown>).setup_script), /\bnpm(?:\s|$)|\bnpx(?:\s|$)/);
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

test("Environment App ID conflicts are rejected before the Session request", async () => {
  let creates = 0;
  const client = new ArkClient("key", "https://ark.example/api/v3", async url => {
    if (String(url).endsWith("/sessions")) creates++;
    return new Response(JSON.stringify({ config: { type: "cloud", env: { LARKSUITE_CLI_APP_ID: "other" } } }));
  });
  await assert.rejects(client.createSession("agent", "env", [], { LARKSUITE_CLI_APP_ID: "expected" }), /APP_ID/);
  assert.equal(creates, 0);
});

test("Environment cache returns copies and supports explicit fresh reads", async () => {
  let requests = 0;
  const client = new ArkClient("key", "https://ark.example/api/v3", async () => {
    requests++; return new Response(JSON.stringify({ config: { type: "cloud", env: { VALUE: String(requests) } } }));
  });
  const first = await client.getEnvironmentConfig("env"); first.env!.VALUE = "mutated";
  assert.equal((await client.getEnvironmentConfig("env")).env?.VALUE, "1");
  assert.equal((await client.getEnvironmentConfig("env", { fresh: true })).env?.VALUE, "2");
});

test("Ark createSession preserves the complete native Session request", async () => {
  let body: Record<string, unknown> = {};
  const client = new ArkClient("key", "https://ark.example/api/v3", async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: "sesn-native" }), { status: 200 });
  });
  const request = {
    agent: {
      id: "agent-1", type: "agent_with_overrides", version: 7,
      system: "本次会话提示词", skills: [], tools: [], future_agent_field: { enabled: true }
    },
    environment: {
      id: "env-1", type: "environment_with_overrides",
      config: { type: "cloud", tos: {}, future_environment_field: "kept" }
    },
    resources: [
      { type: "file", file_id: "file-1", mount_path: "/mnt/data/a.pdf" },
      { type: "memory_store", memory_store_id: "mem-1", access: "read_write" },
      { type: "tos", tos_bucket: "bucket-1", tos_key: "inputs/a/", tos_region: "cn-beijing", mount_path: "/mnt/data/a" }
    ],
    vault_ids: ["vlt-1", "vlt-2"],
    title: "飞书任务",
    tags: [{ key: "channel", value: "lark" }],
    future_session_field: { mode: "preview" }
  };

  assert.equal(await client.createSession(request), "sesn-native");
  assert.deepEqual(body, request);
  assert.deepEqual((body.environment as { config: { tos: object } }).config.tos, {});
  assert.deepEqual((body.agent as { skills: unknown[] }).skills, []);
});

test("Ark createSession rejects ambiguous Environment selection before sending", async () => {
  let calls = 0;
  const client = new ArkClient("key", "https://ark.example/api/v3", async () => {
    calls++;
    return new Response(JSON.stringify({ id: "never" }), { status: 200 });
  });

  await assert.rejects(client.createSession({
    agent: "agent-1",
    environment_id: "env-1",
    environment: { id: "env-1", type: "environment_with_overrides", config: { type: "cloud" } }
  }), /environment 与 environment_id 必须且只能传一个/);
  assert.equal(calls, 0);
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
  assert.ok(calls.indexOf("/sessions/session-1/events/stream") < calls.indexOf("/sessions/session-1/events"));
  assert.deepEqual(result, { terminal: "idle", messages: ["完成"] });
});

test("run posts immediately when SSE response headers are delayed and completes from event history", async () => {
  const calls: string[] = [];
  let messageSent = false;
  const client = new ArkClient("key", "https://ark.example/api/v3", async (url, init) => {
    const path = String(url).replace("https://ark.example/api/v3", "");
    calls.push(`${init?.method || "GET"} ${path}`);
    if (path.endsWith("/events/stream")) {
      await new Promise(resolve => setTimeout(resolve, 100));
      return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (path.endsWith("/events") && init?.method === "POST") {
      messageSent = true;
      return new Response("{}", { status: 200 });
    }
    const data = messageSent ? [
      { type: "agent.message", processed_at: new Date().toISOString(), content: [{ type: "text", text: "轮询完成" }] },
      { type: "session.status_idle", processed_at: new Date().toISOString() }
    ] : [];
    return new Response(JSON.stringify({ data }), { status: 200 });
  }, { sseHeadStartMs: 5, eventPollIntervalMs: 5 });

  const startedAt = Date.now();
  const result = await client.run("session-1", "你好", 5_000);

  assert.ok(Date.now() - startedAt < 100);
  assert.ok(calls.indexOf("GET /sessions/session-1/events/stream") < calls.indexOf("POST /sessions/session-1/events"));
  assert.deepEqual(result, { terminal: "idle", messages: ["轮询完成"] });
});

test("run accumulates agent.message deltas into full-text snapshots", async () => {
  const snapshots: string[] = [];
  const client = new ArkClient("key", "https://ark.example/api/v3", async (url) => {
    const path = String(url).replace("https://ark.example/api/v3", "");
    if (path.includes("/events/stream")) return new Response([
      'data: {"type":"event_start","event":{"type":"agent.message","id":"evt-1"}}',
      "",
      'data: {"type":"event_delta","event_id":"evt-1","delta":{"type":"content_delta","index":0,"content":{"type":"text","text":"你"}}}',
      "",
      'data: {"type":"event_delta","event_id":"evt-1","delta":{"type":"content_delta","index":0,"content":{"type":"text","text":"好"}}}',
      "",
      'data: {"type":"agent.message","id":"evt-1","content":[{"type":"text","text":"你好！"}]}',
      "",
      'data: {"type":"session.status_idle"}',
      ""
    ].join("\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    return new Response("{}", { status: 200 });
  });

  const result = await client.run("session-1", "你好", 5_000, undefined, async snapshot => { snapshots.push(snapshot); });

  assert.deepEqual(snapshots, ["你", "你好", "你好！"]);
  assert.deepEqual(result, { terminal: "idle", messages: ["你好！"] });
});

test("getSessionStats reports event count and latest model input tokens", async () => {
  const client = new ArkClient("key", "https://ark.example/api/v3", async () => new Response(JSON.stringify({ data: { items: [
    { type: "span.model_request_end", model_usage: { input_tokens: 1200 } },
    { type: "agent.message" },
    { id: "model-latest", type: "span.model_request_end", model_usage: { input_tokens: 27611 } }
  ] } }), { status: 200 }));

  assert.deepEqual(await client.getSessionStats("session-1"), { eventCount: 3, latestInputTokens: 27611, latestTokenSampleId: "model-latest", latestEventId: "model-latest" });
});

test("session stats deduplicate events and exclude compact turns from business samples", async () => {
  const events = [
    { id: "user", type: "user.message", content: [{ type: "text", text: "task" }] },
    { id: "model", type: "span.model_request_end", model_usage: { input_tokens: 30000 } },
    { id: "idle", type: "session.status_idle" },
    { id: "model", type: "span.model_request_end", model_usage: { input_tokens: 30000 } },
    { id: "compact", type: "user.message", content: [{ type: "text", text: "/compact" }] },
    { id: "compact-model", type: "span.model_request_end", model_usage: { input_tokens: 40000 } },
    { id: "compact-idle", type: "session.status_idle" }
  ];
  const client = new ArkClient("key", "https://test", async () => Response.json({ data: events }));
  assert.deepEqual(await client.getSessionStats("s"), {
    eventCount: 3, latestInputTokens: 30000, latestTokenSampleId: "model", latestBusinessEventId: "user", latestEventId: "compact-idle", status: "idle"
  });
});

test("zero-token error samples do not replace a successful business token sample", async () => {
  const client = new ArkClient("key", "https://test", async () => Response.json({ data: [
    { id: "model", type: "span.model_request_end", model_usage: { input_tokens: 30000 } },
    { id: "failed-model", type: "span.model_request_end", is_error: true, model_usage: { input_tokens: 0 } },
    { id: "running", type: "session.status_running" }
  ] }));
  const stats = await client.getSessionStats("s");
  assert.equal(stats.latestTokenSampleId, "model");
  assert.equal(stats.status, "running");
});

test("compact verification requires a new native compaction event and an idle terminal", async () => {
  const base = [
    { id: "old-proof", type: "agent.thread_context_compacted", session_thread_id: "main" },
    { id: "boundary", type: "session.status_idle" },
    { id: "command", type: "user.message", content: [{ type: "text", text: "/compact" }] }
  ];
  let after: Record<string, unknown>[] = [];
  const client = new ArkClient("key", "https://test", async () => Response.json({ data: [...base, ...after] }));
  const idle = { id: "idle", type: "session.status_idle" };
  const proof = { id: "proof", type: "agent.thread_context_compacted", session_thread_id: "main" };
  after = [idle];
  assert.equal((await client.inspectCompaction("s", "boundary")).result, "unknown");
  after = [base[0], idle];
  assert.equal((await client.inspectCompaction("s", "boundary")).result, "unknown");
  after = [proof];
  assert.equal((await client.inspectCompaction("s", "boundary")).result, "unknown");
  after = [proof, idle];
  assert.deepEqual(await client.inspectCompaction("s", "boundary"), { result: "succeeded", terminal: "idle", reason: "thread_context_compacted", evidenceEventId: "proof" });
  after = [proof, { id: "error", type: "session.error" }, idle];
  assert.equal((await client.inspectCompaction("s", "boundary")).result, "failed");
  after = [proof, { id: "child", type: "session.thread_status_running", session_thread_id: "child" }, idle];
  assert.equal((await client.inspectCompaction("s", "boundary")).result, "unknown");
  assert.equal((await client.inspectCompaction("s", "missing")).reason, "boundary_not_found");
});

test("compact reconciliation never consumes a subsequent business run or its error", async () => {
  const client = new ArkClient("key", "https://test", async () => Response.json({ data: [
    { id: "boundary", type: "session.status_idle" },
    { id: "command", type: "user.message", content: [{ type: "text", text: "/compact" }] },
    { id: "proof", type: "agent.thread_context_compacted" },
    { id: "idle", type: "session.status_idle" },
    { id: "business", type: "user.message", content: [{ type: "text", text: "task" }] },
    { id: "later-error", type: "session.error" }
  ] }));
  assert.equal((await client.inspectCompaction("s", "boundary")).result, "succeeded");
  assert.equal((await client.inspectCompaction("s", "idle")).reason, "command_not_found");
});

test("session stats recognize native platform compaction without exposing its content", async () => {
  const client = new ArkClient("key", "https://test", async () => Response.json({ data: [
    { id: "business", type: "user.message", content: [{ type: "text", text: "task" }] },
    { id: "model", type: "span.model_request_end", model_usage: { input_tokens: 30000 } },
    { id: "proof", type: "agent.thread_context_compacted", session_thread_id: "main", content: "private summary" },
    { id: "idle", type: "session.status_idle" }
  ] }));
  const stats = await client.getSessionStats("s");
  assert.deepEqual(stats.latestCompaction, { eventId: "proof", eventCount: 2, tokenSampleId: "model", businessEventId: "business" });
  assert.ok(!JSON.stringify(stats).includes("private summary"));
});

test("Ark uploads a file and mounts it in a Session", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const client = new ArkClient("key", "https://ark.example/api/v3", async (url, init) => {
    const path = String(url).replace("https://ark.example/api/v3", "");
    calls.push({ path, method: init?.method || "GET", body: init?.body });
    if (path === "/files") return new Response(JSON.stringify({ id: "file-1", filename: "report.pdf" }), { status: 200 });
    return new Response(JSON.stringify({ id: "res-1" }), { status: 200 });
  });
  const file = await client.uploadFile("report.pdf", "application/pdf", new Uint8Array([1, 2, 3]));
  await client.addSessionFile("session-1", file.id, "/mnt/data/report.pdf");
  assert.equal(file.id, "file-1");
  assert.equal(calls[0].path, "/files");
  assert.ok(calls[0].body instanceof FormData);
  assert.equal((calls[0].body as FormData).get("purpose"), "user_data");
  assert.deepEqual(JSON.parse(String(calls[1].body)), {
    type: "file", file_id: "file-1", mount_path: "/mnt/data/report.pdf"
  });
});

test("run ignores replayed terminal events on both streaming and non-streaming paths", async () => {
  for (const streaming of [false, true]) {
    const old = [
      { id: "old-reply", type: "agent.message", content: [{ type: "text", text: "旧回复" }] },
      { id: "old-idle", type: "session.status_idle" }
    ];
    const snapshots: string[] = [];
    let posted = false;
    const client = new ArkClient("key", "https://test", async (url, init) => {
      if (init?.method === "POST") { posted = true; return Response.json({}); }
      if (String(url).includes("/stream")) return new Response([
        { id: "replay-wrapper", type: "event_start", event: { id: "old-reply", type: "agent.message" } },
        { id: "replay-delta", type: "event_delta", event_id: "old-reply", delta: { type: "content_delta", index: 0, content: { type: "text", text: "旧回复" } } },
        ...old,
        { id: "current-user", type: "user.message", content: [{ type: "text", text: "新问题" }] },
        { id: "current-reply", type: "agent.message", content: [{ type: "text", text: "新回复" }] },
        { id: "current-idle", type: "session.status_idle" }
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
      return Response.json({ data: posted ? [] : old });
    });
    const result = await client.run("session", "新问题", 2_000, undefined,
      streaming ? async value => { snapshots.push(value); } : undefined);
    assert.deepEqual(result.messages, ["新回复"]);
    assert.ok(!snapshots.includes("旧回复"));
  }
});

test("poll recovery uses event identity even when the local clock is ahead", async () => {
  const stamp = "2026-01-01T00:00:00Z";
  const old = [{ id: "old", type: "session.status_idle", processed_at: stamp }];
  let posted = false;
  const client = new ArkClient("key", "https://test", async (url, init) => {
    if (init?.method === "POST") { posted = true; return Response.json({}); }
    if (String(url).includes("/stream")) return new Response("", { status: 200 });
    return Response.json({ data: posted ? [...old,
      { id: "user", type: "user.message", processed_at: stamp, content: [{ type: "text", text: "/compact" }] },
      { id: "idle", type: "session.status_idle", processed_at: stamp }
    ] : old });
  });
  assert.deepEqual(await client.run("session", "/compact", 2_000), { terminal: "idle", messages: [] });
});

test("event history follows native next_page and detects the newest token usage", async () => {
  const pages: string[] = [];
  const client = new ArkClient("key", "https://test", async url => {
    pages.push(String(url));
    return String(url).includes("page=second")
      ? Response.json({ data: [{ id: "new", model_usage: { input_tokens: 1000 } }] })
      : Response.json({ data: [{ id: "old", model_usage: { input_tokens: 30000 } }], next_page: "second" });
  });
  assert.deepEqual(await client.getSessionStats("s"), { eventCount: 2, latestInputTokens: 1000, latestTokenSampleId: "new", latestEventId: "new" });
  assert.equal(pages.length, 2);
});
