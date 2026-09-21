import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { ArkClient, ArkHttpError } from "../src/ark.ts";
import { failureDiagnostic } from "../src/ark-errors.ts";

async function failure(action: Promise<unknown>): Promise<any> {
  try { await action; } catch (error) { return error; }
  assert.fail("expected failure");
}

for (const [status, kind] of [[400, "invalid_request"], [401, "auth"], [403, "permission"], [404, "not_found"],
  [409, "conflict"], [413, "too_large"], [429, "rate_limit"], [500, "upstream"]] as const) {
  test(`HTTP ${status} preserves safe metadata without exposing the upstream body`, async () => {
    let calls = 0;
    const client = new ArkClient("PRIVATE-KEY", "https://example.invalid", async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: "InvalidParameter", message: "PRIVATE-KEY https://download.invalid/?token=SECRET FILE-CONTENT" } }),
        { status, headers: { "x-request-id": "20260916-request_123" } });
    });
    const error = await failure(client.uploadFile("test.pdf", "application/pdf", new Uint8Array([1])));
    assert.ok(error instanceof ArkHttpError);
    assert.equal(error.kind, kind); assert.equal(error.status, status);
    assert.equal(error.code, "InvalidParameter"); assert.equal(error.requestId, "20260916-request_123");
    assert.doesNotMatch(inspect(error) + JSON.stringify(error), /PRIVATE-KEY|SECRET|FILE-CONTENT|download.invalid/);
    assert.equal(error.cause, undefined); assert.equal(calls, 1);
  });
}

test("malformed metadata and non-JSON bodies are never included in HTTP errors", async () => {
  for (const body of ["<html>PRIVATE-KEY</html>", JSON.stringify({ error: { code: "https://PRIVATE-KEY" } }),
    JSON.stringify({ error: { code: "PRIVATE-KEY" } })]) {
    const client = new ArkClient("PRIVATE-KEY", "https://example.invalid", async () => new Response(body,
      { status: 502, headers: { "x-request-id": "https://PRIVATE-KEY" } }));
    const error = await failure(client.getAgent("a"));
    assert.equal(error.code, undefined); assert.equal(error.requestId, undefined);
    assert.doesNotMatch(inspect(error), /PRIVATE-KEY|html/);
  }
});

test("oversized error bodies are cancelled without promoting a partial code to rejection evidence", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"error":{"code":"InvalidParameter","message":"' + "x".repeat(70_000))); }, cancel() { cancelled = true; } });
  const client = new ArkClient("key", "https://example.invalid", async () => new Response(stream, { status: 400, headers: { "x-request-id": "request-1" } }));
  const error = await failure(client.getAgent("a"));
  assert.equal(error.status, 400); assert.equal(error.code, undefined); assert.equal(error.requestId, "request-1");
  assert.equal(cancelled, true);
});

test("stalled error bodies have a bounded wait while retaining HTTP metadata", async () => {
  let cancelled = false;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const client = new ArkClient("key", "https://example.invalid", async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
      { status: 503, headers: { "x-request-id": "request-2" } }), { inspectionTimeoutMs: 15 });
    const error = await failure(client.getAgent("a"));
    assert.equal(error.status, 503); assert.equal(error.code, undefined); assert.equal(error.requestId, "request-2");
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});

test("network errors keep only an allowlisted code, never their raw cause", async () => {
  const cause = Object.assign(new Error("SECRET token=value"), { code: "ECONNRESET" });
  const client = new ArkClient("key", "https://example.invalid", async () => { throw new TypeError("https://PRIVATE", { cause }); });
  const error = await failure(client.getAgent("a"));
  assert.equal(error.kind, "network"); assert.equal(error.code, "ECONNRESET");
  assert.equal(error.cause, undefined); assert.doesNotMatch(inspect(error), /SECRET|PRIVATE|token=value/);
});

test("unsupported file hint survives sanitization without exposing its surrounding message", async () => {
  const client = new ArkClient("key", "https://example.invalid", async () => new Response(JSON.stringify({ error: {
    code: "InvalidParameter", message: "file type not supported: PRIVATE-FILENAME" } }), { status: 400 }));
  const error = await failure(client.uploadFile("test.bin", "application/octet-stream", new Uint8Array([1])));
  assert.match(error.message, /file type not supported/); assert.doesNotMatch(error.message, /PRIVATE/);
});

test("legacy plain-text file format errors keep only the fixed user hint", async () => {
  const client = new ArkClient("key", "https://example.invalid", async () => new Response("file type not supported: PRIVATE-FILENAME", { status: 400 }));
  const error = await failure(client.uploadFile("test.bin", "application/octet-stream", new Uint8Array([1])));
  assert.match(error.message, /file type not supported/); assert.doesNotMatch(error.message, /PRIVATE/);
  assert.equal(error.code, undefined);
});

test("file hint does not misclassify server failures and empty bodies preserve HTTP status", async () => {
  for (const body of ["", "file type not supported: PRIVATE"]) {
    const client = new ArkClient("key", "https://example.invalid", async () => new Response(body, { status: 500 }));
    const error = await failure(client.uploadFile("test.bin", "application/octet-stream", new Uint8Array([1])));
    assert.equal(error.kind, "upstream"); assert.equal(error.status, 500);
    assert.doesNotMatch(error.message, /PRIVATE|file type not supported/);
  }
});

test("unknown errors cannot spoof trusted diagnostics through arbitrary object fields", () => {
  const error = Object.assign(new Error("PRIVATE"), { status: 400, code: "InvalidParameter", requestId: "request", kind: "invalid_request" });
  assert.deepEqual(failureDiagnostic(error), { kind: "unknown" });
});

for (const name of ["AbortError", "TimeoutError"]) test(`network ${name} is classified without keeping the reason`, async () => {
  const client = new ArkClient("key", "https://example.invalid", async () => { throw new DOMException("PRIVATE", name); });
  const error = await failure(client.getAgent("a"));
  assert.equal(error.kind, name === "AbortError" ? "cancelled" : "timeout");
  assert.doesNotMatch(inspect(error), /PRIVATE/);
});

test("invalid UTF-8 error streams are cancelled and never retain a partial structured error", async () => {
  let cancelled = false;
  const client = new ArkClient("key", "https://example.invalid", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([255])); }, cancel() { cancelled = true; }
  }), { status: 400 }));
  const error = await failure(client.getAgent("a"));
  assert.equal(error.status, 400); assert.equal(error.code, undefined); assert.equal(cancelled, true);
});
