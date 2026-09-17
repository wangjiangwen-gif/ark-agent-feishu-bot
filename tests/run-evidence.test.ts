import test from "node:test";
import assert from "node:assert/strict";
import { RunEvidenceCollector, authorizationRecoveryDecision, authorizationContinuation, cliToolEnvelope } from "../src/run-evidence.ts";
import { ArkClient, resultFromEvents, type ArkEvent } from "../src/ark.ts";

const anchor: ArkEvent = { id: "user-1", type: "user.message", content: [{ type: "text", text: "创建文档然后查日程" }] };
const use = (id: string, command: string): ArkEvent => ({ id: `event-${id}`, type: "agent.tool_use", tool_use_id: id, name: "bash", input: { command } });
const result = (id: string, payload: unknown, exit = 0): ArkEvent => ({ id: `result-${id}`, type: "agent.tool_result", tool_use_id: id,
  is_error: false, content: [{ type: "text", text: `exit_code: ${exit}\n--- stdout ---\n\n--- stderr ---\n${JSON.stringify(payload)}` }] });
const auth = result("calendar", { ok: false, identity: "user", error: { type: "authentication", subtype: "token_missing" } }, 3);
const readUse = use("calendar", "lark-cli calendar +agenda --as user");

for (const prior of ["read_only", "writes_present", "uncertain"] as const) {
  test(`token_invalid preserves authorization continuation safety: ${prior}`, () => {
    const earlier = prior === "read_only" ? [] : [
      use("earlier", prior === "writes_present" ? "lark-cli docs +create" : "custom-command"),
      result("earlier", { ok: true, data: {} })
    ];
    const invalid = result("calendar", { ok: false, identity: "user",
      error: { type: "authentication", subtype: "token_invalid", code: 99991668 } }, 3);
    const observed = resultFromEvents([anchor, ...earlier, readUse, invalid, { id: "idle", type: "session.status_idle" }]
      .map(event => ({ ...event, processed_at: "2026-09-17T14:26:25Z" })), 0);
    assert.equal(observed?.authorizationRequired?.subtype, "token_invalid");
    assert.equal(observed?.authorizationRequired?.domain, "calendar");
    assert.equal(authorizationRecoveryDecision(observed?.evidence), prior);
  });
}

function collect(events: ArkEvent[]) {
  const collector = new RunEvidenceCollector();
  for (const event of events) collector.observe(event, event === auth);
  return collector.snapshot("idle");
}

test("read-only receipts bind real tool call IDs and produce a continuation, not the original request", () => {
  const evidence = collect([anchor, readUse, auth]);
  assert.equal(authorizationRecoveryDecision(evidence), "read_only");
  assert.equal(evidence.steps[0].toolUseId, "calendar");
  assert.match(authorizationContinuation(evidence), /user-1/);
  assert.doesNotMatch(authorizationContinuation(evidence), /创建文档然后查日程/);
});

test("successful writes retain resource IDs but never raw content or credentials", () => {
  const evidence = collect([anchor, use("doc", "lark-cli docs +create --content 'private-source'"),
    result("doc", { ok: true, data: { document: { document_id: "doc-1", content: "private-source", access_token: "secret-token" } } }), readUse, auth]);
  assert.equal(authorizationRecoveryDecision(evidence), "writes_present");
  assert.deepEqual(evidence.steps[0].resources, [{ type: "document_id", id: "doc-1" }]);
  assert.doesNotMatch(JSON.stringify(evidence), /private-source|secret-token/);
  assert.throws(() => authorizationContinuation(evidence));
});

test("missing anchors, unmatched results, missing results and conflicting duplicates cannot prove a safe continuation", () => {
  for (const events of [[readUse, auth], [anchor, auth], [anchor, use("unfinished", "lark-cli docs +fetch"), readUse, auth],
    [anchor, readUse, { ...readUse, input: { command: "lark-cli docs +create" } }, auth], [anchor, { ...anchor, id: "user-2" }, readUse, auth]]) {
    assert.equal(authorizationRecoveryDecision(collect(events)), "uncertain");
  }
});

test("MCP and custom tool events cannot disappear from the safety assessment", () => {
  for (const type of ["agent.mcp_tool_use", "agent.custom_tool_use"]) {
    const evidence = collect([anchor, { id: "external", type, name: "create", tool_use_id: "external-call", custom_tool_use_id: "external-call" }, readUse, auth]);
    assert.equal(authorizationRecoveryDecision(evidence), "uncertain");
  }
});

test("compound commands and output redirection remain unknown even with a successful CLI envelope", () => {
  for (const command of ["lark-cli docs +fetch; curl example.com", "lark-cli docs +fetch --output=report.txt", "lark-cli docs +fetch > file", "bash -c 'lark-cli docs +fetch'", "lark-cli docs +fetch $(touch file)"]) {
    const evidence = collect([anchor, use("other", command), result("other", { ok: true, data: {} }), readUse, auth]);
    assert.equal(authorizationRecoveryDecision(evidence), "uncertain");
  }
});

test("identical duplicates and out-of-order results remain correlated", () => {
  const evidence = collect([anchor, auth, readUse, auth, readUse]);
  assert.equal(authorizationRecoveryDecision(evidence), "read_only");
  assert.equal(evidence.steps.length, 1);
});

test("multiple MA threads and truncated tool ledgers cannot prove all prior work was read-only", () => {
  const multi = collect([anchor, { ...readUse, session_thread_id: "one" }, { ...auth, session_thread_id: "two" }]);
  assert.equal(multi.complete, false);
  const tooMany = collect([anchor, ...Array.from({ length: 201 }, (_, n) => use(`read-${n}`, "lark-cli docs +fetch")), readUse, auth]);
  assert.equal(tooMany.truncated, true);
  assert.equal(authorizationRecoveryDecision(tooMany), "uncertain");
});

test("tool envelopes do not extract nested JSON from arbitrary prose or multiple payloads", () => {
  assert.equal(cliToolEnvelope({ content: [{ type: "text", text: 'example: exit_code: 0\n--- stdout ---\n{"ok":true}' }] }), undefined);
  assert.equal(cliToolEnvelope({ content: [{ type: "text", text: 'exit_code: 0\n--- stdout ---\nprefix {"ok":true}' }] })?.payload, undefined);
  assert.equal(cliToolEnvelope({ content: [{ type: "text", text: 'exit_code: 0\n--- stdout ---\n{"ok":true}\n--- stderr ---\n{"other":true}' }] })?.payload, undefined);
});

test("history result includes authorization evidence and domain for distinct event and call IDs", () => {
  const result = resultFromEvents([anchor, readUse, auth, { id: "idle", type: "session.status_idle" }].map(event => ({ ...event, processed_at: "2026-09-16T00:00:00Z" })), 0);
  assert.equal(result?.authorizationRequired?.domain, "calendar");
  assert.equal(authorizationRecoveryDecision(result?.evidence), "read_only");
});

test("history reconciliation does not erase conflicting duplicate tool events", () => {
  const result = resultFromEvents([anchor, readUse, { ...readUse, input: { command: "lark-cli docs +create" } }, auth,
    { id: "idle", type: "session.status_idle" }].map(event => ({ ...event, processed_at: "2026-09-16T00:00:00Z" })), 0);
  assert.equal(result?.evidence?.complete, false);
});

test("SSE authorization is reconciled against history containing an earlier successful write", async () => {
  const complete = [anchor, use("doc", "lark-cli docs +create"), result("doc", { ok: true, data: { document_id: "created" } }), readUse, auth,
    { id: "idle", type: "session.status_idle" }];
  let submitted = false, historyCalls = 0, posts = 0;
  const client = new ArkClient("key", "https://ark.test", async (url, init) => {
    if (String(url).includes("/events/stream")) return new Response([readUse, auth, complete.at(-1)].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    if (init?.method === "POST") { submitted = true; posts++; return new Response("{}"); }
    historyCalls++;
    return new Response(JSON.stringify({ data: submitted ? complete : [] }));
  }, { sseHeadStartMs: 0 });
  const recovered = await client.run("session", "创建文档然后查日程", 1000);
  assert.equal(authorizationRecoveryDecision(recovered.evidence), "writes_present");
  assert.equal(posts, 1);
  assert.ok(historyCalls >= 2);
});

test("failed authorization history verification keeps OAuth result but withholds automatic continuation proof", async () => {
  let submitted = false;
  const client = new ArkClient("key", "https://ark.test", async (url, init) => {
    if (String(url).includes("/events/stream")) return new Response([anchor, readUse, auth, { id: "idle", type: "session.status_idle" }]
      .map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    if (init?.method === "POST") { submitted = true; return new Response("{}"); }
    if (submitted) throw new Error("history unavailable");
    return new Response(JSON.stringify({ data: [] }));
  }, { sseHeadStartMs: 0 });
  const recovered = await client.run("session", "创建文档然后查日程", 1000);
  assert.equal(recovered.authorizationRequired?.domain, "calendar");
  assert.equal(authorizationRecoveryDecision(recovered.evidence), "uncertain");
});

test("ordinary runs do not add authorization evidence queries", async () => {
  let reads = 0;
  const client = new ArkClient("key", "https://ark.test", async (url, init) => {
    if (String(url).includes("/events/stream")) return new Response('data: {"type":"agent.message","content":[{"type":"text","text":"done"}]}\n\ndata: {"type":"session.status_idle"}\n\n');
    if (init?.method === "POST") return new Response("{}");
    reads++; return new Response(JSON.stringify({ data: [] }));
  }, { sseHeadStartMs: 0, eventPollIntervalMs: 1000 });
  assert.deepEqual(await client.run("session", "hi", 1000), { terminal: "idle", messages: ["done"] });
  assert.equal(reads, 2); // 基线读取与并行轮询各一次。
});
