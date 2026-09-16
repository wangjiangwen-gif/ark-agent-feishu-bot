import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createContext, runInContext } from "node:vm";
import { GatewayStore } from "../src/store.ts";
import { startEmployeeWeb } from "../src/web.ts";
import type { ChannelMessage } from "../src/channel.ts";
import type { EmployeeConfig } from "../src/config.ts";

const message: ChannelMessage = { channelType: "lark", installationId: "app", tenantId: "tenant", senderId: "user", conversationId: "chat",
  conversationType: "group", threadId: "thread", rootMessageId: "root", parentMessageId: "parent", messageId: "source", eventId: "event",
  createTime: 1, text: "PRIVATE-CONTENT", resources: [], mentionedBot: true };
const config: EmployeeConfig = { arkApiKey: "secret", arkAgentId: "agent", arkEnvironmentId: "env", arkBaseUrl: "https://example.invalid",
  arkVaultId: "vault", arkCredentialId: "credential", feishuAppId: "app", feishuAppSecret: "app-secret", feishuBotName: "测试数字员工",
  databasePath: ":memory:", sessionTimeoutMs: 1000, webHost: "127.0.0.1", webPort: 0, webToken: "web-secret" };
const key = "a".repeat(64);
const headers = { Authorization: "Bearer web-secret" };

test("attachment diagnostics are scoped by channel and installation, not client-supplied application ids", () => {
  const store = new GatewayStore(":memory:");
  for (const patch of [{}, { channelType: "other" }, { installationId: "other" }, { tenantId: "tenant-2" }]) {
    store.attachmentTrace.begin({ ...message, ...patch }, key, "download");
  }
  const page = store.attachmentTrace.listForInstallation("lark", "app");
  assert.equal(page.scope, "installation");
  assert.deepEqual(page.items.map(x => x.tenantId), ["tenant-2", "tenant"]);
  assert.ok(page.items.every(x => x.conversationId === "chat" && x.threadId === "thread" && x.messageId === "source"));
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE-CONTENT|senderId|eventId/);
  store.close();
});

test("attachment diagnostics paginate newest first without gaps or newer inserts disturbing the next page", () => {
  const store = new GatewayStore(":memory:");
  for (let n = 0; n < 105; n++) store.attachmentTrace.begin(message, key, "upload");
  const first = store.attachmentTrace.listForInstallation("lark", "app");
  store.attachmentTrace.begin(message, key, "upload");
  const second = store.attachmentTrace.listForInstallation("lark", "app", { before: first.next });
  assert.equal(first.items.length, 100); assert.equal(second.items.length, 5);
  assert.equal(second.next, undefined);
  assert.deepEqual([...first.items, ...second.items].map(x => x.sequence), Array.from({ length: 105 }, (_, i) => 105 - i));
  store.close();
});

test("diagnostics filter exact source message and session together, preserving pending and error ambiguity", () => {
  const store = new GatewayStore(":memory:");
  const pending = store.attachmentTrace.begin(message, key, "mount", { sessionId: "session" });
  const failed = store.attachmentTrace.begin(message, key, "mount", { sessionId: "session" });
  store.attachmentTrace.finish(failed, "error");
  store.attachmentTrace.begin({ ...message, messageId: "source-2" }, key, "mount", { sessionId: "session" });
  store.attachmentTrace.begin(message, key, "mount", { sessionId: "other-session" });
  const page = store.attachmentTrace.listForInstallation("lark", "app", { messageId: "source", sessionId: "session" });
  assert.deepEqual(page.items.map(x => [x.id, x.status]), [[failed, "error"], [pending, "pending"]]);
  assert.equal(page.items[1].durationMs, undefined);
  assert.equal(store.attachmentTrace.listForInstallation("lark", "app", { messageId: "source%" }).items.length, 0);
  store.close();
});

test("diagnostic filters are bounded and cannot modify SQL", () => {
  const store = new GatewayStore(":memory:");
  store.attachmentTrace.begin(message, key, "download");
  for (const before of [-1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.attachmentTrace.listForInstallation("lark", "app", { before }), /游标/);
  }
  for (const value of ["", "x".repeat(257), "a\nb", "a\0b"]) {
    assert.throws(() => store.attachmentTrace.listForInstallation("lark", "app", { messageId: value }), /筛选/);
    assert.throws(() => store.attachmentTrace.listForInstallation("lark", "app", { sessionId: value }), /筛选/);
  }
  assert.equal(store.attachmentTrace.listForInstallation("lark", "app", { messageId: "' OR 1=1 --" }).items.length, 0);
  assert.equal(store.attachmentTrace.listForInstallation("lark", "app").items.length, 1);
  store.close();
});

test("pre-diagnostics trace rows remain readable after indexed migration and queries do not mutate state", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ark-attachment-diagnostics-")), "gateway.db");
  let store = new GatewayStore(path);
  const id = store.attachmentTrace.begin(message, key, "upload");
  store.attachmentTrace.finish(id, "succeeded", { bytes: 7, sha256: key, fileId: "file" });
  store.close();
  const db = new DatabaseSync(path);
  db.exec("DROP INDEX IF EXISTS attachment_stage_installation; DROP INDEX IF EXISTS attachment_stage_message; DROP INDEX IF EXISTS attachment_stage_session");
  db.close();
  store = new GatewayStore(path);
  const before = store.attachmentTrace.list(message);
  for (let n = 0; n < 3; n++) assert.equal(store.attachmentTrace.listForInstallation("lark", "app").items[0].fileId, "file");
  assert.deepEqual(store.attachmentTrace.list(message), before);
  store.close();
  const readonly = new DatabaseSync(path, { readOnly: true });
  const query = readonly.prepare("EXPLAIN QUERY PLAN SELECT * FROM attachment_stage_receipts WHERE json_extract(scope, '$[0]')=? AND json_extract(scope, '$[1]')=? AND sequence<? ORDER BY sequence DESC LIMIT 101").all("lark", "app", 1000);
  assert.match(JSON.stringify(query), /attachment_stage_installation/);
  readonly.close();
});

test("exact message and session diagnostic filters use dedicated indexes instead of scanning all app history", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ark-attachment-query-plan-")), "gateway.db");
  const store = new GatewayStore(path); store.close();
  const db = new DatabaseSync(path, { readOnly: true });
  for (const [field, index] of [["json_extract(scope, '$[5]')", "attachment_stage_message"], ["json_extract(details, '$.sessionId')", "attachment_stage_session"]]) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM attachment_stage_receipts WHERE json_extract(scope, '$[0]')=? AND json_extract(scope, '$[1]')=? AND ${field}=? AND sequence<? ORDER BY sequence DESC LIMIT 101`).all("lark", "app", "missing", 1000);
    assert.match(JSON.stringify(plan), new RegExp(index));
  }
  db.close();
});

async function withWeb(action: (store: GatewayStore, base: string) => Promise<void>): Promise<void> {
  const store = new GatewayStore(":memory:");
  const web = await startEmployeeWeb({ store, config });
  try { await action(store, web.url.split("/#")[0]); }
  finally { await new Promise<void>(resolve => web.server.close(() => resolve())); store.close(); }
}

test("HTTP attachment diagnostics work without durable queue, require admin auth and reject writes", async () => {
  await withWeb(async (store, base) => {
    const id = store.attachmentTrace.begin(message, key, "upload");
    store.attachmentTrace.finish(id, "succeeded", { fileId: "file", bytes: 5, sha256: key, secret: "PRIVATE-TOKEN" } as never);
    const endpoint = base + "/api/employees/agent/attachments";
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { headers: { Authorization: "wrong" } })).status, 401);
    assert.equal((await fetch(base + "/api/employees/other/attachments", { headers })).status, 404);
    assert.equal((await fetch(endpoint, { headers, method: "POST" })).status, 405);
    const response = await fetch(endpoint, { headers });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text(); const data = JSON.parse(body);
    assert.equal(data.scope, "installation"); assert.equal(data.items[0].id, id);
    assert.doesNotMatch(body, /PRIVATE|secret|understood/);
  });
});

test("HTTP diagnostics validate filters and cannot widen application scope", async () => {
  await withWeb(async (store, base) => {
    store.attachmentTrace.begin(message, key, "upload");
    store.attachmentTrace.begin({ ...message, installationId: "other" }, key, "upload");
    const endpoint = base + "/api/employees/agent/attachments";
    for (const query of ["before=-1", "before=0", "before=1.5", "before=9007199254740992", "before=", "before=1&before=2", "messageId=", "messageId=a&messageId=b", "sessionId=%0A", "messageId=" + "x".repeat(257), "installationId=other"]) {
      assert.equal((await fetch(endpoint + "?" + query, { headers })).status, 400, query);
    }
    const response = await fetch(endpoint + "?messageId=source", { headers });
    assert.equal((await response.json() as any).items.length, 1);
  });
});

test("HTTP diagnostics suppress underlying database errors and expose no raw payload", async () => {
  await withWeb(async (store, base) => {
    store.attachmentTrace.listForInstallation = () => { throw new Error("PRIVATE-TOKEN raw DB payload"); };
    const response = await fetch(base + "/api/employees/agent/attachments", { headers });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "附件阶段记录读取失败，请检查本地数据库" });
  });
});

test("attachment UI is read-only and explains reference scope and stage evidence limits", async () => {
  await withWeb(async (_store, base) => {
    const page = await (await fetch(base)).text();
    assert.match(page, /附件处理记录/);
    assert.match(page, /不代表模型已理解/);
    assert.match(page, /当前飞书应用的历史记录/);
    assert.match(page, /源消息 ID/);
    assert.match(page, /未记录结束（结果待核实）/);
    assert.match(page, /attachment-next/);
  });
});

// 执行实际页面脚本验证数据绑定和异步竞态；不将此最小DOM替身当作浏览器视觉验收。
class Element {
  children: Element[] = [];
  textContent = ""; value = ""; hidden = false; style = {}; dataset = {};
  classList = { add() {}, remove() {} };
  append(...children: Element[]): void { this.children.push(...children); }
  replaceChildren(...children: Element[]): void { this.children = children; }
  set innerHTML(_value: string) { throw new Error("不应使用innerHTML渲染附件内容"); }
}

async function pageScript(base: string) {
  const html = await (await fetch(base)).text();
  const nodes = new Map<string, Element>();
  const select = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!; };
  const context = createContext({ URLSearchParams, location: { hash: "#token=web-secret" }, document: {
    querySelector: select, querySelectorAll: () => [], createElement: () => new Element()
  }, fetch: async () => ({ ok: true, json: async () => [] }) });
  runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context);
  await new Promise(resolve => setImmediate(resolve));
  runInContext("currentEmployee='agent'", context);
  return { context, select };
}

test("attachment HTTP diagnostics and actual UI script expose safe request identifiers without raw errors", async () => {
  await withWeb(async (store, base) => {
    const id = store.attachmentTrace.begin(message, key, "upload");
    store.attachmentTrace.finish(id, "error", { failure: { kind: "permission", status: 403, code: "AccessDenied", requestId: "request-123", message: "SECRET" } } as never);
    const response = await fetch(base + "/api/employees/agent/attachments", { headers });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.doesNotMatch(JSON.stringify(payload), /SECRET|PRIVATE-CONTENT/);
    const { context, select } = await pageScript(base);
    context.items = payload.items;
    runInContext("renderAttachmentRows(items)", context);
    const status = select("#attachment-body").children[0].children[3].textContent;
    assert.match(status, /不代表远端未写入/);
    assert.match(status, /permission.*403.*AccessDenied.*request ID: request-123/);
  });
});

test("actual UI script renders hostile resource values as text and never equates mounts with understanding", async () => {
  await withWeb(async (store, base) => {
    const malicious = '<img src=x onerror="throw 1">';
    const id = store.attachmentTrace.begin({ ...message, conversationId: malicious }, key, "mount", { mountPath: malicious, sessionId: "session" });
    store.attachmentTrace.finish(id, "succeeded");
    const { context, select } = await pageScript(base);
    context.items = store.attachmentTrace.listForInstallation("lark", "app").items;
    runInContext("renderAttachmentRows(items)", context);
    const row = select("#attachment-body").children[0];
    assert.ok(row.children.some(cell => cell.textContent.includes(malicious)));
    assert.equal(row.children[3].textContent, "此阶段已确认");
    assert.equal(row.children.length, 6);
  });
});

test("actual UI script ignores stale responses, resets pagination on filter edits and clears stale rows on failure", async () => {
  await withWeb(async (_store, base) => {
    const { context, select } = await pageScript(base);
    const pending: Array<(value: unknown) => void> = [], urls: string[] = [];
    context.fetch = (url: string) => { urls.push(url); return new Promise(resolve => pending.push(resolve)); };
    select("#attachment-message").value = "first";
    const first = runInContext("loadAttachments()", context);
    select("#attachment-message").value = "second";
    const second = runInContext("loadAttachments()", context);
    const payload = (messageId: string) => ({ ok: true, json: async () => ({ items: [{ messageId, conversationId: "chat", threadId: "", tenantId: "tenant", attachmentKey: key, stage: "upload", status: "pending", startedAt: 1 }], next: 50 }) });
    pending[1](payload("second")); await second;
    pending[0](payload("first")); await first;
    assert.match(select("#attachment-body").children[0].children[1].textContent, /^second/);
    assert.deepEqual(urls, ["/api/employees/agent/attachments?messageId=first", "/api/employees/agent/attachments?messageId=second"]);
    assert.equal(select("#attachment-next").hidden, false);
    runInContext("document.querySelector('#attachment-message').oninput()", context);
    assert.equal(select("#attachment-next").hidden, true);
    assert.equal(select("#attachment-body").children.length, 0);
    const failed = runInContext("loadAttachments()", context);
    pending[2]({ ok: false, json: async () => ({ error: "附件阶段记录读取失败，请检查本地数据库" }) }); await failed;
    assert.match(select("#attachment-status").textContent, /读取失败/);
    assert.equal(select("#attachment-body").children.length, 0);
    assert.equal(select("#attachment-next").hidden, true);
  });
});

test("actual UI script discards diagnostic responses after changing the employee", async () => {
  await withWeb(async (_store, base) => {
    const { context, select } = await pageScript(base);
    let resolve: (value: unknown) => void = () => {};
    context.fetch = () => new Promise(r => { resolve = r; });
    const request = runInContext("loadAttachments()", context);
    runInContext("currentEmployee='other'", context);
    resolve({ ok: true, json: async () => ({ items: [{ messageId: "wrong employee" }], next: 1 }) });
    await request;
    assert.equal(select("#attachment-body").children.length, 0);
    assert.equal(select("#attachment-next").hidden, true);
  });
});
