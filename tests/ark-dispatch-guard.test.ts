import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ArkClient, type ArkEvent } from "../src/ark.ts";

const safeFailure = "发送前校验未通过，已停止发送消息";
const input = "当前任务";
const completed: ArkEvent[] = [
  { id: "user-current", type: "user.message", content: [{ type: "text", text: input }] },
  { id: "reply-current", type: "agent.message", content: [{ type: "text", text: "完成" }] },
  { id: "idle-current", type: "session.status_idle" }
];
const sseResponse = () => new Response(completed.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
  headers: { "Content-Type": "text/event-stream" }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(options: {
  history?: () => Promise<Response>;
  stream?: (signal: AbortSignal) => Promise<Response>;
  onPost?: () => void;
} = {}) {
  const calls: string[] = [];
  let posted = false;
  const client = new ArkClient("synthetic-key", "https://ark.invalid/api/v3", async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method || "GET";
    calls.push(`${method} ${path}`);
    if (method === "POST") {
      options.onPost?.();
      assert.equal(path, "/api/v3/sessions/session/events");
      assert.deepEqual(JSON.parse(String(init?.body)), { events: [{ type: "user.message", content: [{ type: "text", text: input }] }] });
      posted = true;
      return Response.json({});
    }
    if (path.endsWith("/events/stream")) return options.stream ? options.stream(init!.signal as AbortSignal) : sseResponse();
    return options.history ? options.history() : Response.json({ data: posted ? completed : [] });
  }, { sseHeadStartMs: 1_000, eventPollIntervalMs: 1 });
  return { client, calls };
}

const failure = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, safeFailure);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(String(error.stack), /PRIVATE-CREDENTIAL/);
  return true;
};
const noDispatch = (calls: string[]) => assert.deepEqual(calls, [
  "GET /api/v3/sessions/session/events", "GET /api/v3/sessions/session/events/stream"
]);

test("dispatch guard rechecks identity after the initial history GET settles", async () => {
  const waiting = deferred<void>(), release = deferred<Response>();
  let identity = "expected", checks = 0, callbacks = 0;
  const { client, calls } = fixture({ history: () => { waiting.resolve(); return release.promise; } });
  const result = client.run("session", input, 5_000, async () => { callbacks++; }, async () => { callbacks++; }, () => {
    checks++;
    if (identity !== "expected") throw new Error("PRIVATE-CREDENTIAL changed");
  });
  const rejected = assert.rejects(result, failure);
  await waiting.promise;
  identity = "replaced";
  release.resolve(Response.json({ data: [] }));
  await rejected;
  assert.equal(checks, 1);
  assert.equal(callbacks, 0);
  noDispatch(calls);
});

test("dispatch guard rechecks identity after waiting for SSE response headers", async () => {
  const waiting = deferred<void>(), release = deferred<Response>();
  let allowed = true, checks = 0, streamSignal: AbortSignal | undefined;
  const { client, calls } = fixture({ stream: signal => { streamSignal = signal; waiting.resolve(); return release.promise; } });
  const result = client.run("session", input, 5_000, undefined, undefined, () => {
    checks++;
    if (!allowed) throw new Error("PRIVATE-CREDENTIAL revoked");
  });
  const rejected = assert.rejects(result, failure);
  await waiting.promise;
  allowed = false;
  release.resolve(sseResponse());
  await rejected;
  assert.equal(checks, 1);
  assert.equal(streamSignal?.aborted, true);
  noDispatch(calls);
});

test("dispatch guard failure is never recovered as an old run when its timeout also fires", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const { client, calls } = fixture({ history: async () => Response.json({ data: ++reads === 1 ? [] : completed }) });
  await assert.rejects(client.run("session", input, 100, undefined, undefined, () => {
    context.mock.timers.tick(100);
    throw new Error("PRIVATE-CREDENTIAL timeout collision");
  }), failure);
  noDispatch(calls);
  assert.equal(reads, 1);
});

test("successful dispatch guard is synchronous with the actual POST and is invoked exactly once", async () => {
  const order: string[] = [];
  const { client, calls } = fixture({ onPost: () => { order.push("post"); } });
  const result = await client.run("session", input, 5_000, undefined, undefined, () => {
    order.push("guard");
    queueMicrotask(() => { order.push("microtask"); });
  });
  assert.deepEqual(order, ["guard", "post", "microtask"]);
  assert.deepEqual(result, { terminal: "idle", messages: ["完成"] });
  assert.equal(calls.filter(call => call.startsWith("POST")).length, 1);
});

test("omitting dispatch guard preserves the normal request and callback counts", async () => {
  const unguarded = fixture(), guarded = fixture();
  const snapshots: string[][] = [[], []];
  const first = await unguarded.client.run("session", input, 5_000, undefined, async value => { snapshots[0].push(value); });
  let checks = 0;
  const second = await guarded.client.run("session", input, 5_000, undefined, async value => { snapshots[1].push(value); }, () => { checks++; });
  assert.deepEqual(first, second);
  assert.deepEqual(unguarded.calls, guarded.calls);
  assert.deepEqual(snapshots, [["完成"], ["完成"]]);
  assert.equal(checks, 1);
  assert.equal(unguarded.calls.filter(call => call.startsWith("POST")).length, 1);
});

for (const [name, guard] of [
  ["resolved native Promise", () => Promise.resolve()],
  ["rejected native Promise", () => Promise.reject(new Error("PRIVATE-CREDENTIAL promise"))],
  ["async resolved callback", async () => undefined],
  ["async rejected callback", async () => { throw new Error("PRIVATE-CREDENTIAL async"); }],
  ["resolved thenable", () => ({ then(resolve: (value?: unknown) => void) { resolve(); } })],
  ["rejected thenable", () => ({ then(_resolve: unknown, reject: (error: Error) => void) { reject(new Error("PRIVATE-CREDENTIAL thenable")); } })],
  ["throwing then getter", () => Object.defineProperty({}, "then", { get() { throw new Error("PRIVATE-CREDENTIAL getter"); } })]
] as const) {
  test(`dispatch guard rejects ${name} without leaking errors or unhandled rejections`, async () => {
    const { client, calls } = fixture();
    await assert.rejects(client.run("session", input, 5_000, undefined, undefined, guard), failure);
    await new Promise(resolve => setImmediate(resolve));
    noDispatch(calls);
  });
}

test("dispatch guard never awaits an unresolved Promise", async () => {
  const pending = deferred<void>();
  const { client, calls } = fixture();
  try {
    await assert.rejects(client.run("session", input, 5_000, undefined, undefined, () => pending.promise), failure);
    noDispatch(calls);
  } finally { pending.resolve(); }
});

test("dispatch guard safely rejects non-Error callback throws", async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.run("session", input, 5_000, undefined, undefined, () => {
    throw { secret: "PRIVATE-CREDENTIAL", toString() { throw new Error("PRIVATE-CREDENTIAL string conversion"); } };
  }), failure);
  noDispatch(calls);
});

test("dispatch guard rechecks after the SSE head-start expires without response headers", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const waiting = deferred<void>();
  let allowed = true;
  const { client, calls } = fixture({ stream: signal => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    waiting.resolve();
  }) });
  const result = client.run("session", input, 5_000, undefined, undefined, () => {
    if (!allowed) throw new Error("PRIVATE-CREDENTIAL changed during SSE head-start");
  });
  const rejected = assert.rejects(result, failure);
  await waiting.promise;
  allowed = false;
  context.mock.timers.tick(1_000);
  await rejected;
  noDispatch(calls);
});

for (const phase of ["history", "sse"] as const) {
  test(`real fetch prevents POST when identity changes during HTTP ${phase} waiting`, { timeout: 10_000 }, async context => {
    const waiting = deferred<void>(), release = deferred<void>();
    const calls: string[] = [];
    let generation = 1, checks = 0;
    const server = createServer((request, response) => {
      const path = new URL(request.url!, "http://127.0.0.1").pathname;
      const method = request.method || "GET";
      calls.push(`${method} ${path}`);
      const stream = path.endsWith("/stream");
      const answer = () => {
        response.setHeader("Content-Type", stream ? "text/event-stream" : "application/json");
        response.end(stream ? completed.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") : JSON.stringify({ data: [] }));
      };
      if (method === "GET" && ((phase === "history" && !stream) || (phase === "sse" && stream))) {
        waiting.resolve();
        void release.promise.then(answer);
      } else answer();
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    context.after(async () => {
      release.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    const client = new ArkClient("synthetic-key", `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v3`, fetch, {
      sseHeadStartMs: 5_000, eventPollIntervalMs: 1
    });
    const result = client.run("session", input, 8_000, undefined, undefined, () => {
      checks++;
      if (generation !== 1) throw new Error("PRIVATE-CREDENTIAL rotated");
    });
    const rejected = assert.rejects(result, failure);
    await waiting.promise;
    generation++;
    release.resolve();
    await rejected;
    assert.equal(checks, 1);
    noDispatch(calls);
  });
}
