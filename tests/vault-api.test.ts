import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ArkClient } from "../src/ark.ts";

const vault = (id = "vault-one", extra: Record<string, unknown> = {}) => ({ id, type: "vault", display_name: "用户凭证库",
  metadata: { operation: "fixture-operation" }, created_at: "2026-09-17T01:00:00Z", updated_at: "2026-09-17T01:00:01Z", ...extra });
const credential = (id = "credential-one", extra: Record<string, unknown> = {}) => ({ id, type: "vault_credential", vault_id: "vault-one",
  display_name: "用户凭证", auth: { type: "environment_variable", secret_name: "LARKSUITE_CLI_USER_ACCESS_TOKEN", networking: { type: "unrestricted" },
    secret_value: "PRIVATE-SECRET-MUST-NOT-RETURN" }, metadata: { operation: "fixture-operation" },
  created_at: "2026-09-17T01:00:00Z", updated_at: "2026-09-17T01:00:01Z", ...extra });
function safeError(error: unknown) {
  assert.ok(error instanceof Error);
  assert.match(error.message, /凭证资源核查失败/);
  assert.doesNotMatch(String(error.stack), /PRIVATE|synthetic-key/);
  assert.equal(error.cause, undefined);
  return true;
}
function fixture(pages: unknown[], timeout = 5_000) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const client = new ArkClient("synthetic-key", "https://ark.invalid/api/v3", async (url, init) => {
    calls.push({ path: String(url).replace("https://ark.invalid/api/v3", ""), method: init?.method || "GET",
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return Response.json(pages[calls.length - 1]);
  }, { inspectionTimeoutMs: timeout });
  return { client, calls };
}

test("vault listing reads all pages and preserves only projected metadata", async () => {
  const { client, calls } = fixture([{ data: [vault()], next_page: "page/+", total: 2 },
    { data: [vault("vault-two", { secret: "PRIVATE-TOP-LEVEL" })], total: 2 }]);
  const result = await client.listVaults();
  assert.deepEqual(result, ["vault-one", "vault-two"].map(id => ({ id, displayName: "用户凭证库", type: "vault",
    metadata: { operation: "fixture-operation" }, createdAt: "2026-09-17T01:00:00Z", updatedAt: "2026-09-17T01:00:01Z" })));
  assert.deepEqual(calls.map(call => call.path), ["/vaults?limit=100", "/vaults?limit=100&page=page%2F%2B"]);
  assert.ok(calls.every(call => call.method === "GET"));
});

test("credential listing follows pages and never returns secret fields", async () => {
  const { client, calls } = fixture([{ data: [credential()], next_page: "second" }, { data: [credential("credential-two")], next_page: "" }]);
  const result = await client.listCredentials("vault-one");
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { id: "credential-one", displayName: "用户凭证", authType: "environment_variable",
    secretName: "LARKSUITE_CLI_USER_ACCESS_TOKEN", vaultId: "vault-one", type: "vault_credential", networking: { type: "unrestricted" },
    metadata: { operation: "fixture-operation" }, createdAt: "2026-09-17T01:00:00Z", updatedAt: "2026-09-17T01:00:01Z" });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret_value/);
  assert.equal(calls[1].path, "/vaults/vault-one/credentials?limit=100&page=second");
});

test("an unnamed Credential stays in the complete list with the legacy empty display name", async () => {
  const { client, calls } = fixture([{ data: [credential("unnamed", { display_name: undefined })], next_page: "second" },
    { data: [credential("named")], next_page: "" }]);
  const result = await client.listCredentials("vault-one");
  assert.deepEqual(result.map(item => ({ id: item.id, displayName: item.displayName })),
    [{ id: "unnamed", displayName: "" }, { id: "named", displayName: "用户凭证" }]);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret_value/);
});

test("an unnamed Credential detail uses no guessed name or authorization evidence", async () => {
  const { client } = fixture([credential("credential-one", { display_name: undefined })]);
  const result = await client.getCredential("vault-one", "credential-one");
  assert.equal(result.displayName, "");
  assert.equal(result.vaultId, "vault-one");
  assert.notEqual(result.displayName, "lark-cli-user-access-token");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret_value/);
});

for (const name of [null, 1, {}]) test(`invalid Credential name ${JSON.stringify(name)} is not treated as omitted`, async () => {
  const { client } = fixture([{ data: [credential("credential-one", { display_name: name })] },
    credential("credential-one", { display_name: name })]);
  await assert.rejects(client.listCredentials("vault-one"), safeError);
  await assert.rejects(client.getCredential("vault-one", "credential-one"), safeError);
});

test("missing Vault name remains invalid in lists and details", async () => {
  const { client } = fixture([{ data: [vault("vault-one", { display_name: undefined })] }, vault("vault-one", { display_name: undefined })]);
  await assert.rejects(client.listVaults(), safeError);
  await assert.rejects(client.getVault("vault-one"), safeError);
});

test("metadata parameters extend create requests without changing legacy request bodies", async () => {
  const { client, calls } = fixture([{ id: "vault-one" }, { id: "vault-two" }, { id: "credential-one" }, { id: "credential-two" }]);
  await client.createVault("legacy"); await client.createVault("tracked", { operation: "op-one" });
  await client.createEnvironmentVariableCredential("vault-one", "legacy", "TOKEN_NAME", "synthetic-value");
  await client.createEnvironmentVariableCredential("vault-one", "tracked", "TOKEN_NAME", "synthetic-value", { operation: "op-two" });
  assert.deepEqual(calls.map(call => call.body), [
    { display_name: "legacy" }, { display_name: "tracked", metadata: { operation: "op-one" } },
    { display_name: "legacy", auth: { type: "environment_variable", secret_name: "TOKEN_NAME", secret_value: "synthetic-value", networking: { type: "unrestricted" } } },
    { display_name: "tracked", auth: { type: "environment_variable", secret_name: "TOKEN_NAME", secret_value: "synthetic-value", networking: { type: "unrestricted" } }, metadata: { operation: "op-two" } }
  ]);
  assert.ok(calls.every(call => call.method === "POST"));
});

test("resource metadata accepts nested JSON objects without treating non-string values as an API error", async () => {
  const metadata = { operation: "fixture", nested: { flags: [true, 2, null], details: { owner: "test" } } };
  const { client } = fixture([{ data: [vault("vault-one", { metadata })] }, credential("credential-one", { metadata })]);
  assert.deepEqual((await client.listVaults())[0].metadata, metadata);
  assert.deepEqual((await client.getCredential("vault-one", "credential-one")).metadata, metadata);
});

test("creation validates metadata before serialization without invoking getters or toJSON", async () => {
  const { client, calls } = fixture([]);
  let invoked = 0;
  const getter = Object.defineProperty({}, "secret", { enumerable: true, get() { invoked++; throw new Error("PRIVATE-GETTER"); } });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const toJSON = { toJSON() { invoked++; return "PRIVATE-JSON"; } };
  const deep: Record<string, unknown> = {}; let nested = deep;
  for (let i = 0; i < 40; i++) nested = nested.inner = {};
  for (const metadata of [getter, cycle, toJSON, deep, { invalid: BigInt(1) }, { invalid: undefined }, { invalid: new Map() }]) {
    await assert.rejects(client.createVault("fixture", metadata), /凭证资源元信息无效/);
    await assert.rejects(client.createEnvironmentVariableCredential("vault-one", "fixture", "TOKEN", "synthetic", metadata), /凭证资源元信息无效/);
  }
  assert.equal(invoked, 0); assert.equal(calls.length, 0);
});

test("detail endpoints require exact resource and Vault identities and only expose metadata", async () => {
  const { client, calls } = fixture([vault(), credential()]);
  const one = await client.getVault("vault-one"), two = await client.getCredential("vault-one", "credential-one");
  assert.equal(one.id, "vault-one"); assert.equal(one.type, "vault");
  assert.equal(two.id, "credential-one"); assert.equal(two.vaultId, "vault-one");
  assert.doesNotMatch(JSON.stringify(two), /PRIVATE|secret_value/);
  assert.deepEqual(calls.map(call => call.path), ["/vaults/vault-one", "/vaults/vault-one/credentials/credential-one"]);
  assert.ok(calls.every(call => call.method === "GET"));
});

for (const [name, resource, operation] of [
  ["wrong Vault id", vault("other"), "vault"], ["wrong Vault type", vault("vault-one", { type: "session" }), "vault"],
  ["nested Vault envelope", { data: vault() }, "vault"], ["wrong Credential id", credential("other"), "credential"],
  ["wrong Credential type", credential("credential-one", { type: "vault" }), "credential"],
  ["wrong Credential owner", credential("credential-one", { vault_id: "other" }), "credential"],
  ["missing Credential owner", credential("credential-one", { vault_id: undefined }), "credential"],
  ["nested Credential envelope", { data: credential() }, "credential"]
] as const) test(`resource detail rejects ${name}`, async () => {
  const { client, calls } = fixture([resource]);
  await assert.rejects(operation === "vault" ? client.getVault("vault-one") : client.getCredential("vault-one", "credential-one"), safeError);
  assert.equal(calls.length, 1);
});

test("detail rejects unsafe paths and aborted operations without network requests", async () => {
  const { client, calls } = fixture([]);
  for (const id of ["", "a/b", "..", "a?token=PRIVATE", "x".repeat(257)]) {
    await assert.rejects(client.getVault(id), safeError);
    await assert.rejects(client.getCredential(id, "credential-one"), safeError);
    await assert.rejects(client.getCredential("vault-one", id), safeError);
  }
  const controller = new AbortController(); controller.abort(new Error("PRIVATE-ABORT"));
  await assert.rejects(client.getVault("vault-one", controller.signal), safeError);
  await assert.rejects(client.getCredential("vault-one", "credential-one", controller.signal), safeError);
  assert.equal(calls.length, 0);
});

test("optional metadata fields stay absent and networking has no guessed defaults or enumeration", async () => {
  const { client } = fixture([{ data: [{ id: "v", display_name: "legacy" }] },
    { data: [{ id: "c", display_name: "legacy", auth: { type: "environment_variable" } }] },
    credential("credential-one", { auth: { type: "future_auth", networking: { type: "future_restricted", allowed_hosts: ["example.test"], secret_value: "PRIVATE-NETWORK" } } })]);
  assert.deepEqual(await client.listVaults(), [{ id: "v", displayName: "legacy" }]);
  assert.deepEqual(await client.listCredentials("vault-one"), [{ id: "c", displayName: "legacy", authType: "environment_variable" }]);
  const detail = await client.getCredential("vault-one", "credential-one");
  assert.deepEqual(detail.networking, { type: "future_restricted", allowed_hosts: ["example.test"] });
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE|secret_value/);
});

for (const operation of ["vault-list", "credential-list", "vault-detail", "credential-detail"] as const) {
  test(`${operation} accepts MA null metadata as absent without inventing ownership`, async () => {
    const isVault = operation.startsWith("vault-");
    const item = isVault ? vault("vault-one", { metadata: null }) : credential("credential-one", { metadata: null });
    const { client } = fixture([operation.endsWith("list") ? { data: [item] } : item]);
    const result = operation === "vault-list" ? (await client.listVaults())[0]
      : operation === "credential-list" ? (await client.listCredentials("vault-one"))[0]
      : operation === "vault-detail" ? await client.getVault("vault-one")
      : await client.getCredential("vault-one", "credential-one");
    assert.equal(Object.hasOwn(result, "metadata"), false);
    assert.equal(result.id, item.id);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret_value/);
  });
}

for (const [name, payload] of [
  ["missing data", {}], ["nested envelope", { data: { items: [] } }], ["data null", { data: null }],
  ["error envelope", { data: [], error: { message: "PRIVATE-UPSTREAM" } }], ["number cursor", { data: [], next_page: 3 }],
  ["control cursor", { data: [], next_page: "bad\nPRIVATE" }], ["oversized cursor", { data: [], next_page: "x".repeat(2049) }],
  ["invalid total", { data: [], total: "1" }], ["incomplete total", { data: [], total: 1 }],
  ["invalid item", { data: [null] }], ["missing id", { data: [vault(undefined, { id: undefined })] }],
  ["unsafe id", { data: [vault("a/b")] }], ["wrong type", { data: [vault("v", { type: "session" })] }],
  ["invalid name", { data: [vault("v", { display_name: 2 })] }], ["invalid metadata", { data: [vault("v", { metadata: [] })] }],
  ["invalid timestamp", { data: [vault("v", { created_at: "PRIVATE-NOT-A-DATE" })] }]
] as const) test(`vault list rejects ${name} instead of treating it as not found`, async () => {
  const { client, calls } = fixture([payload]);
  await assert.rejects(client.listVaults(), safeError);
  assert.equal(calls.length, 1);
});

for (const [name, item] of [
  ["wrong resource type", credential("c", { type: "vault" })], ["wrong vault", credential("c", { vault_id: "other" })],
  ["missing auth", credential("c", { auth: undefined })], ["invalid auth", credential("c", { auth: { type: 2 } })],
  ["invalid secret name", credential("c", { auth: { type: "environment_variable", secret_name: 2 } })],
  ["invalid networking", credential("c", { auth: { type: "environment_variable", networking: [] } })]
] as const) test(`credential list rejects ${name}`, async () => {
  const { client } = fixture([{ data: [item] }]);
  await assert.rejects(client.listCredentials("vault-one"), safeError);
});

test("resource listing refuses duplicate cursors, duplicate resources and changing totals", async () => {
  for (const pages of [
    [{ data: [vault("a")], next_page: "same" }, { data: [vault("b")], next_page: "same" }],
    [{ data: [vault("a")], next_page: "next" }, { data: [vault("a")] }],
    [{ data: [vault("a")], total: 2, next_page: "next" }, { data: [vault("b")], total: 3 }]
  ]) {
    const { client, calls } = fixture(pages);
    await assert.rejects(client.listVaults(), safeError);
    assert.equal(calls.length, 2);
  }
});

test("resource listing bounds all pages, item counts and cumulative response bytes", async () => {
  const pageLimit = fixture(Array.from({ length: 10 }, (_, n) => ({ data: [vault(`v-${n}`)], next_page: `page-${n}` })));
  await assert.rejects(pageLimit.client.listVaults(), safeError); assert.equal(pageLimit.calls.length, 10);
  const countLimit = fixture([{ data: Array.from({ length: 1001 }, (_, n) => vault(`v-${n}`)) }]);
  await assert.rejects(countLimit.client.listVaults(), safeError); assert.equal(countLimit.calls.length, 1);
  const byteLimit = fixture([{ data: [vault("one")], padding: "a".repeat(3 * 1024 * 1024), next_page: "next" },
    { data: [vault("two")], padding: "a".repeat(2 * 1024 * 1024) }]);
  await assert.rejects(byteLimit.client.listVaults(), safeError); assert.equal(byteLimit.calls.length, 2);
});

test("full pages missing a cursor are not mistaken for a complete Credential list", async () => {
  const data = Array.from({ length: 100 }, (_, i) => credential(`credential-${i}`));
  const missing = fixture([{ data }]);
  await assert.rejects(missing.client.listCredentials("vault-one"), safeError);
  const explicitEnd = fixture([{ data, next_page: "" }]);
  assert.equal((await explicitEnd.client.listCredentials("vault-one")).length, 100);
  const countedEnd = fixture([{ data, total: 100 }]);
  assert.equal((await countedEnd.client.listCredentials("vault-one")).length, 100);
});

test("a total never stops the next-page query early and exact limits remain valid", async () => {
  const next = fixture([{ data: [vault()], total: 1, next_page: "verify-end" }, { data: [], total: 1 }]);
  assert.equal((await next.client.listVaults()).length, 1); assert.equal(next.calls.length, 2);
  const limit = fixture(Array.from({ length: 10 }, (_, page) => ({
    data: Array.from({ length: 100 }, (_, row) => vault(`v-${page}-${row}`)), total: 1000, next_page: page === 9 ? "" : `page-${page + 1}`
  })));
  assert.equal((await limit.client.listVaults()).length, 1000); assert.equal(limit.calls.length, 10);
});

test("resource checks reject bad path identities and pre-aborted signals before fetch", async () => {
  const { client, calls } = fixture([]);
  for (const id of ["", "a/b", "..", "bad?query", "bad\n", "x".repeat(257)]) await assert.rejects(client.listCredentials(id), safeError);
  const controller = new AbortController(); controller.abort(new Error("PRIVATE-ABORT"));
  await assert.rejects(client.listVaults(controller.signal), safeError);
  await assert.rejects(client.listCredentials("vault-one", controller.signal), safeError);
  assert.equal(calls.length, 0);
});

test("resource list bounds an ignored AbortSignal and does not expose network errors", async () => {
  let calls = 0;
  const client = new ArkClient("synthetic-key", "https://ark.invalid", async () => { calls++; return new Promise(() => {}); }, { inspectionTimeoutMs: 20 });
  const started = performance.now();
  await assert.rejects(client.listVaults(), safeError);
  assert.ok(performance.now() - started < 1000); assert.equal(calls, 1);
  const rejected = new ArkClient("synthetic-key", "https://ark.invalid", async () => { throw new Error("PRIVATE-NETWORK"); });
  await assert.rejects(rejected.listCredentials("vault-one"), safeError);
});

test("resource list cancels stalled response bodies within its total budget", async () => {
  let cancelled = false;
  const client = new ArkClient("synthetic-key", "https://ark.invalid", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')); }, cancel() { cancelled = true; }
  })), { inspectionTimeoutMs: 20 });
  await assert.rejects(client.listVaults(), safeError);
  assert.equal(cancelled, true);
});

test("a cancelled detail cleans up late HTTP responses without reading their metadata", async () => {
  let resolve!: (response: Response) => void, calls = 0, cancelled = false;
  const controller = new AbortController();
  const client = new ArkClient("synthetic-key", "https://ark.invalid", () => { calls++; return new Promise(done => { resolve = done; }); });
  const result = client.getCredential("vault-one", "credential-one", controller.signal);
  const rejected = assert.rejects(result, safeError);
  controller.abort(new Error("PRIVATE-ABORT"));
  await rejected;
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(done => setImmediate(done));
  assert.equal(calls, 1); assert.equal(cancelled, true);
});

test("all resource read endpoints bound stalled headers and sanitize HTTP 403", async () => {
  for (const operation of ["vault-list", "credential-list", "vault-detail", "credential-detail"]) {
    let calls = 0;
    const invoke = (client: ArkClient) => operation === "vault-list" ? client.listVaults()
      : operation === "credential-list" ? client.listCredentials("vault-one")
      : operation === "vault-detail" ? client.getVault("vault-one") : client.getCredential("vault-one", "credential-one");
    const stalled = new ArkClient("synthetic-key", "https://ark.invalid", async () => { calls++; return new Promise(() => {}); }, { inspectionTimeoutMs: 10 });
    await assert.rejects(invoke(stalled), safeError); assert.equal(calls, 1);
    const denied = new ArkClient("synthetic-key", "https://ark.invalid", async () => {
      calls++; return new Response("PRIVATE-FORBIDDEN", { status: 403 });
    });
    await assert.rejects(invoke(denied), safeError); assert.equal(calls, 2);
  }
});

test("one resource-query deadline covers successive pages rather than restarting per GET", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const releases: Array<(response: Response) => void> = [];
  const client = new ArkClient("synthetic-key", "https://ark.invalid", () => new Promise(resolve => { releases.push(resolve); }), { inspectionTimeoutMs: 100 });
  const result = client.listVaults();
  const rejected = assert.rejects(result, safeError);
  assert.equal(releases.length, 1);
  context.mock.timers.tick(60);
  releases[0](Response.json({ data: [vault()], next_page: "second" }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 2);
  context.mock.timers.tick(40);
  await rejected;
  releases[1](Response.json({ data: [vault("vault-two")], next_page: "third" }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 2);
});

test("create failures never retry writes even when upstream returns 500", async () => {
  let writes = 0;
  const client = new ArkClient("synthetic-key", "https://ark.invalid", async () => {
    writes++; return Response.json({ error: { code: "InternalError", message: "PRIVATE-UPSTREAM" } }, { status: 500 });
  });
  await assert.rejects(client.createVault("fixture", { operation: "op" }), /500/);
  await assert.rejects(client.createEnvironmentVariableCredential("vault-one", "fixture", "TOKEN", "synthetic", { operation: "op" }), /500/);
  assert.equal(writes, 2);
});

test("real local HTTP lists both Vault and Credential pages without secret disclosure", async context => {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    const url = new URL(request.url!, "http://127.0.0.1"), second = url.searchParams.has("page"), credentials = url.pathname.includes("credentials");
    response.setHeader("Content-Type", "application/json");
    if (!url.searchParams.has("limit")) { response.end(JSON.stringify(credentials ? credential() : vault())); return; }
    response.end(JSON.stringify({ data: [credentials ? credential(second ? "credential-two" : "credential-one") : vault(second ? "vault-two" : "vault-one")],
      ...(second ? {} : { next_page: "next", total: 2 }) }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  context.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const client = new ArkClient("synthetic-key", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const vaults = await client.listVaults(), credentials = await client.listCredentials("vault-one");
  assert.equal(vaults.length, 2); assert.equal(credentials.length, 2);
  assert.equal((await client.getVault("vault-one")).id, "vault-one");
  assert.equal((await client.getCredential("vault-one", "credential-one")).vaultId, "vault-one");
  assert.equal(calls.length, 6); assert.ok(calls.every(call => call.startsWith("GET ")));
  assert.doesNotMatch(JSON.stringify(credentials), /PRIVATE|secret_value/);
});
