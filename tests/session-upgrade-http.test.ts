import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { ArkClient } from "../src/ark.ts";

// 真实本机HTTP传输，服务端模拟MA；不使用真实凭证或额度。
async function localServer(handler: RequestListener, work: (url: string) => Promise<void>) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await work(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
const body = (status: string) => JSON.stringify({ id: "session", type: "session", status, updated_at: "2026-09-16T00:00:00Z", agent: { system: "PRIVATE-系统提示词" } });

test("native HTTP upgrade roundtrip keeps session ID, handles split UTF-8 and only polls with GET", async () => {
  const calls: Array<{ method?: string; path?: string; body: string; authorization?: string }> = [];
  await localServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push({ method: request.method, path: request.url, body: Buffer.concat(chunks).toString(), authorization: request.headers.authorization });
    const bytes = Buffer.from(body(calls.length < 3 ? "upgrading" : "idle"));
    response.writeHead(200, { "content-type": "application/json" });
    for (let i = 0; i < bytes.length; i += 7) response.write(bytes.subarray(i, i + 7));
    response.end();
  }, async url => {
    const client = new ArkClient("SYNTHETIC-TEST-KEY", url);
    const submission = await client.upgradeSession("session", { environment: {} });
    const result = await client.waitForSessionUpgrade(submission, { pollIntervalMs: 1, timeoutMs: 1000 });
    assert.equal(result.status, "settled");
    assert.equal(result.snapshot?.sessionId, "session");
    assert.equal(result.configurationVerified, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|系统提示词|SYNTHETIC/);
  });
  assert.deepEqual(calls.map(call => [call.method, call.path]), [
    ["POST", "/sessions/session/upgrades"], ["GET", "/sessions/session"], ["GET", "/sessions/session"]
  ]);
  assert.deepEqual(JSON.parse(calls[0].body), { environment: {} });
  assert.ok(calls.every(call => call.authorization === "Bearer SYNTHETIC-TEST-KEY"));
  assert.ok(calls.slice(1).every(call => call.body === ""));
});

test("native HTTP upgrade response loss never resends the POST or initial events", async () => {
  let calls = 0, appliedEvents = 0;
  await localServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls++; appliedEvents += JSON.parse(Buffer.concat(chunks).toString()).initial_events.length;
    response.destroy();
  }, async url => {
    const client = new ArkClient("SYNTHETIC-TEST-KEY", url);
    const result = await client.upgradeSession("session", { initial_events: [{ type: "user.message", content: [{ type: "text", text: "测试" }] }] });
    assert.equal(result.status, "unknown");
    assert.equal(calls, 1); assert.equal(appliedEvents, 1);
  });
});

test("native HTTP upgrade polling abort closes the request without cancelling the remote operation", async () => {
  let calls = 0;
  let queryArrived: () => void = () => {};
  const arrived = new Promise<void>(resolve => { queryArrived = resolve; });
  let queryClosed: () => void = () => {};
  const closed = new Promise<void>(resolve => { queryClosed = resolve; });
  await localServer((request, response) => {
    calls++;
    if (request.method === "POST") { response.end(body("upgrading")); return; }
    response.on("close", queryClosed);
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"id":"session",');
    queryArrived();
  }, async url => {
    const client = new ArkClient("SYNTHETIC-TEST-KEY", url);
    const submission = await client.upgradeSession("session", { environment: {} });
    const controller = new AbortController();
    const waiting = client.waitForSessionUpgrade(submission, { signal: controller.signal, timeoutMs: 1000 });
    await arrived; controller.abort();
    const result = await waiting;
    assert.equal(result.status, "unknown"); assert.equal(result.reason, "cancelled");
    await closed;
    assert.equal(calls, 2);
  });
});
