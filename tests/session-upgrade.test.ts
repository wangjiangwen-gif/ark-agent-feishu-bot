import test from "node:test";
import assert from "node:assert/strict";
import { ArkClient } from "../src/ark.ts";

const stamp = "2026-09-16T10:00:00+08:00";
const snapshot = (status = "upgrading", patch: Record<string, unknown> = {}) => ({
  id: "session", type: "session", status, updated_at: stamp,
  agent: { system: "PRIVATE-SYSTEM" }, environment: { config: { env: { SECRET: "PRIVATE-ENV" } } },
  vault_ids: ["vault"], ...patch
});
const request = { agent: { native_config: { arbitrary: [1, true, null] } }, environment: {}, vault_ids: [] };

test("upgrade rejects executable or non-JSON parameter structures without invoking getters", async () => {
  let calls = 0, getters = 0;
  const client = new ArkClient("KEY", "https://ark.test", async () => { calls++; return Response.json(snapshot()); });
  const cycle: any = {}; cycle.self = cycle;
  const getter = Object.defineProperty({}, "private", { enumerable: true, get() { getters++; throw new Error("PRIVATE-GETTER"); } });
  const deep: any = {}; let tail = deep; for (let i = 0; i < 40; i++) tail = tail.child = {};
  for (const value of [cycle, getter, deep, { a: BigInt(1) }, { a: () => 1 }, { a: new Map() }, { a: new Array(3) }, { toJSON: () => "PRIVATE" }]) {
    await assert.rejects(client.upgradeSession("session", { agent: value }), /升级请求/);
  }
  assert.equal(calls, 0); assert.equal(getters, 0);
});

test("upgrade sends the native body once to the documented endpoint without create aliases", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const client = new ArkClient("KEY", "https://ark.test", async (url, init) => {
    calls.push({ url: String(url), method: init!.method!, body: JSON.parse(String(init!.body)) });
    return Response.json(snapshot());
  });
  const result = await client.upgradeSession("session", request);
  assert.equal(result.status, "accepted");
  assert.match(result.requestFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls, [{ url: "https://ark.test/sessions/session/upgrades", method: "POST", body: request }]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|native_config|SECRET|\bKEY\b/);
  assert.equal(result.status === "accepted" && result.snapshot.status, "upgrading");
});

test("upgrade rejects invalid input before HTTP and never silently drops native creation fields", async () => {
  let calls = 0;
  const client = new ArkClient("KEY", "https://ark.test", async () => { calls++; return Response.json(snapshot()); });
  const invalid = [null, [], {}, { agent: "agent" }, { environment_id: "env" }, { resources: [] },
    { vault_ids: [1] }, { agent: null }, { initial_events: [null] }, { initial_events: "events" },
    { agent: { version: NaN } }, { agent: { nested: undefined } }, { agent: new Date() },
    JSON.parse('{"environment":{"__proto__":{"secret":true}}}'), { agent: { huge: "x".repeat(256 * 1024) } }];
  for (const value of invalid) await assert.rejects(client.upgradeSession("session", value as any), /升级请求/);
  for (const id of ["", "a/b", "..", "a?secret", "a\n", "x".repeat(300)]) {
    await assert.rejects(client.upgradeSession(id, request), /Session ID/);
  }
  assert.equal(calls, 0);
});

test("upgrade request fingerprints are canonical and initial events are not resubmitted elsewhere", async () => {
  const bodies: unknown[] = [];
  const client = new ArkClient("KEY", "https://ark.test", async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body))); return Response.json(snapshot());
  });
  const one = await client.upgradeSession("session", { vault_ids: ["v"], agent: { b: 1, a: 2 } });
  const two = await client.upgradeSession("session", { agent: { a: 2, b: 1 }, vault_ids: ["v"] });
  assert.equal(one.requestFingerprint, two.requestFingerprint);
  const events = { initial_events: [{ type: "user.message", content: [{ type: "text", text: "PRIVATE-USER" }] }] };
  const submitted = await client.upgradeSession("session", events);
  assert.deepEqual(bodies[2], events);
  assert.doesNotMatch(JSON.stringify(submitted), /PRIVATE-USER/);
  assert.equal(bodies.length, 3);
});

for (const [status, code, expected] of [[400, "InvalidParameter", "rejected"], [400, "OtherError", "unknown"],
  [403, "AccessDenied", "unknown"], [429, "Throttling", "unknown"], [500, "InternalError", "unknown"]] as const) {
  test(`upgrade HTTP ${status}/${code} never retries and reports ${expected}`, async () => {
    let calls = 0;
    const client = new ArkClient("PRIVATE-KEY", "https://ark.test", async () => {
      calls++; return Response.json({ error: { code, message: "PRIVATE-BODY" } }, { status, headers: { "x-request-id": "req-1" } });
    });
    const result = await client.upgradeSession("session", request);
    assert.equal(result.status, expected);
    assert.equal(result.failure?.status, status);
    assert.equal(result.failure?.requestId, "req-1");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    assert.equal(calls, 1);
  });
}

for (const [name, response] of Object.entries({ wrongSession: snapshot("upgrading", { id: "other" }),
  wrongType: snapshot("upgrading", { type: "agent" }), missingDate: snapshot("upgrading", { updated_at: undefined }),
  invalidDate: snapshot("upgrading", { updated_at: "not-time" }), error: { error: { message: "PRIVATE" }, ...snapshot() },
  guessedEnvelope: { data: snapshot() }, invalidJSON: "PRIVATE-INVALID-JSON" })) {
  test(`upgrade ${name} response is unknown, not success or safe to retry`, async () => {
    let calls = 0;
    const client = new ArkClient("KEY", "https://ark.test", async () => { calls++; return Response.json(response); });
    const result = await client.upgradeSession("session", request);
    assert.equal(result.status, "unknown");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    assert.equal(calls, 1);
  });
}

test("upgrade lost response is unknown, cancelled before dispatch does not POST", async () => {
  let calls = 0;
  const client = new ArkClient("KEY", "https://ark.test", async () => { calls++; throw new Error("PRIVATE-NETWORK"); });
  assert.equal((await client.upgradeSession("session", request)).status, "unknown");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.upgradeSession("session", request, controller.signal), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("upgrade status polling confirms an observed transition, not business success", async () => {
  const calls: string[] = [];
  const client = new ArkClient("KEY", "https://ark.test", async (url, init) => {
    calls.push(`${init?.method || "GET"} ${url}`);
    return Response.json(snapshot(calls.length < 3 ? "upgrading" : "idle"));
  });
  const submission = await client.upgradeSession("session", request);
  const result = await client.waitForSessionUpgrade(submission, { timeoutMs: 500, pollIntervalMs: 1 });
  assert.equal(result.status, "settled");
  assert.equal(result.configurationVerified, false);
  assert.equal(result.businessResult, "not_assessed");
  assert.deepEqual(calls, ["POST https://ark.test/sessions/session/upgrades", "GET https://ark.test/sessions/session", "GET https://ark.test/sessions/session"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("idle alone after POST is not an upgrade completion proof", async () => {
  let calls = 0;
  const client = new ArkClient("KEY", "https://ark.test", async () => { calls++; return Response.json(snapshot("idle")); });
  const result = await client.waitForSessionUpgrade(await client.upgradeSession("session", request), { timeoutMs: 100, pollIntervalMs: 1 });
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "transition_not_observed");
  assert.equal(calls, 2);
});

for (const status of ["running", "failed", "archived", "future_status"]) {
  test(`upgrade ${status} is not a completion proof and never triggers a replacement Session`, async () => {
    const methods: string[] = [];
    const client = new ArkClient("KEY", "https://ark.test", async (_url, init) => {
      methods.push(init?.method || "GET"); return Response.json(snapshot(methods.length === 1 ? "upgrading" : status));
    });
    const result = await client.waitForSessionUpgrade(await client.upgradeSession("session", request), { timeoutMs: 100, pollIntervalMs: 1 });
    assert.equal(result.status, "unknown");
    assert.deepEqual(methods, ["POST", "GET"]);
  });
}

test("upgrade polling rejects reversed updated_at and session mismatch", async () => {
  for (const patch of [{ updated_at: "2026-09-15T10:00:00+08:00" }, { id: "other" }]) {
    let calls = 0;
    const client = new ArkClient("KEY", "https://ark.test", async () => Response.json(++calls === 1 ? snapshot() : snapshot("idle", patch)));
    const result = await client.waitForSessionUpgrade(await client.upgradeSession("session", request), { timeoutMs: 100, pollIntervalMs: 1 });
    assert.equal(result.status, "unknown"); assert.equal(calls, 2);
  }
});

test("upgrade timeout retains the last upgrading observation without retrying POST", async () => {
  const methods: string[] = [];
  const client = new ArkClient("KEY", "https://ark.test", async (_url, init) => {
    methods.push(init?.method || "GET"); return Response.json(snapshot());
  });
  const result = await client.waitForSessionUpgrade(await client.upgradeSession("session", request), { timeoutMs: 20, pollIntervalMs: 100 });
  assert.equal(result.status, "pending");
  assert.equal(result.reason, "timeout");
  assert.equal(result.snapshot?.status, "upgrading");
  assert.equal(methods.filter(method => method === "POST").length, 1);
  assert.ok(methods.length <= 2);
});

test("upgrade polling does not retry query errors or submit rejected/unknown operations", async () => {
  let calls = 0;
  const client = new ArkClient("KEY", "https://ark.test", async () => ++calls === 1 ? Response.json(snapshot()) : new Response("PRIVATE", { status: 429 }));
  const result = await client.waitForSessionUpgrade(await client.upgradeSession("session", request), { timeoutMs: 100, pollIntervalMs: 1 });
  assert.equal(result.status, "unknown"); assert.equal(calls, 2);
  for (const status of ["unknown", "rejected"]) {
    await assert.rejects(client.waitForSessionUpgrade({ status, requestFingerprint: "a".repeat(64) } as any), /未确认受理/);
  }
  assert.equal(calls, 2);
});

test("upgrade body limits and timeout cancel the response stream and do not expose parser errors", async () => {
  for (const mode of ["oversized", "stalled", "invalid-utf8"]) {
    let cancelled = false, calls = 0;
    const client = new ArkClient("KEY", "https://ark.test", async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(mode === "oversized" ? new Uint8Array(4 * 1024 * 1024 + 1)
          : mode === "invalid-utf8" ? new Uint8Array([0xff]) : new TextEncoder().encode('{"PRIVATE":'));
      }, cancel() { cancelled = true; } }));
    }, { inspectionTimeoutMs: 20 });
    const keepAlive = setInterval(() => {}, 5);
    try { assert.equal((await client.upgradeSession("session", request)).status, "unknown"); }
    finally { clearInterval(keepAlive); }
    assert.equal(cancelled, true); assert.equal(calls, 1);
  }
});

test("upgrade ignores unsolicited fields and does not return unrecognized status strings", async () => {
  const client = new ArkClient("KEY", "https://ark.test", async () => Response.json(snapshot("private_secret", {
    title: "PRIVATE-TITLE", unknown: "PRIVATE-UNKNOWN", resources: [{ type: "file", file_id: "PRIVATE-FILE" }]
  })));
  const result = await client.upgradeSession("session", request);
  assert.equal(result.status, "accepted");
  assert.equal(result.status === "accepted" && result.snapshot.status, "unknown");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private_secret/);
});

test("upgrade wait rejects stale/tampered receipts and invalid timing without HTTP", async () => {
  let calls = 0;
  const client = new ArkClient("KEY", "https://ark.test", async () => { calls++; return Response.json(snapshot()); });
  const result = await client.upgradeSession("session", request);
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  for (const patch of [{ checkedAt: Date.now() - 60_000 }, { checkedAt: Date.now() + 60_000 },
    { sessionId: "../other" }, { status: "PRIVATE" }, { configuration: { agent: "PRIVATE" } }, { updatedAt: "PRIVATE" }]) {
    await assert.rejects(client.waitForSessionUpgrade({ ...result, snapshot: { ...result.snapshot, ...patch } } as any), /回执/);
  }
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 120_001 }, { pollIntervalMs: 0 }, { pollIntervalMs: NaN }]) {
    await assert.rejects(client.waitForSessionUpgrade(result, options), /升级/);
  }
  assert.equal(calls, 1);
});

test("upgrade polling snapshots the supplied receipt and ignores later caller mutations", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const client = new ArkClient("KEY", "https://ark.test", async () => {
    if (++calls === 1) return Response.json(snapshot());
    await gate; return Response.json(snapshot("idle"));
  });
  const submission = await client.upgradeSession("session", request);
  assert.equal(submission.status, "accepted");
  if (submission.status !== "accepted") return;
  const originalFingerprint = submission.requestFingerprint;
  const waiting = client.waitForSessionUpgrade(submission, { timeoutMs: 200 });
  submission.snapshot.sessionId = "other";
  submission.requestFingerprint = "PRIVATE";
  release();
  const result = await waiting;
  assert.equal(result.status, "settled"); assert.equal(result.snapshot?.sessionId, "session");
  assert.equal(result.requestFingerprint, originalFingerprint);
});

test("upgrade wait cancellation does not cancel or retry the server-side upgrade", async () => {
  let calls = 0;
  const controller = new AbortController();
  const client = new ArkClient("KEY", "https://ark.test", async () => {
    if (++calls === 2) controller.abort();
    return Response.json(snapshot());
  });
  const result = await client.waitForSessionUpgrade(await client.upgradeSession("session", request), { signal: controller.signal, timeoutMs: 200 });
  assert.equal(result.reason, "cancelled"); assert.equal(result.status, "unknown"); assert.equal(calls, 2);
});
