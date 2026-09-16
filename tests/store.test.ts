import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { GatewayStore } from "../src/store.ts";

const key = { channelType: "lark", installationId: "cli-one", tenantId: "tenant", conversationId: "chat", threadId: "", senderId: "user" };

test("store saves, reuses and resets a conversation session with its mounted Vaults", () => {
  const store = new GatewayStore(":memory:");
  store.saveSession(key, "session-1", "agent-1", "3", ["vlt-bot", "vlt-user"]);
  assert.equal(store.getSession(key), "session-1");
  assert.deepEqual(store.getSessionVaultIds(key), ["vlt-bot", "vlt-user"]);
  store.resetSession(key);
  assert.equal(store.getSession(key), undefined);
  store.close();
});

test("same database refuses a second live Gateway and releases its own lock on close", t => {
  const directory = mkdtempSync(join(tmpdir(), "arkagent-lock-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "gateway.db");
  const first = new GatewayStore(path), second = new GatewayStore(path);
  first.acquireRuntimeLock();
  assert.throws(() => second.acquireRuntimeLock(), /已有Gateway运行/);
  first.close();
  assert.doesNotThrow(() => second.acquireRuntimeLock());
  second.close();
});

test("runtime lock can recover only after its owning process actually exited", t => {
  const directory = mkdtempSync(join(tmpdir(), "arkagent-dead-lock-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "gateway.db");
  const script = `import { GatewayStore } from './src/store.ts'; const store = new GatewayStore(${JSON.stringify(path)}); store.acquireRuntimeLock(); process.exit(0);`;
  execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: "pipe" });
  const store = new GatewayStore(path); t.after(() => store.close());
  assert.doesNotThrow(() => store.acquireRuntimeLock());
});

test("configuration evidence survives reopening and is never rewritten as current configuration", t => {
  const directory = mkdtempSync(join(tmpdir(), "arkagent-session-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "gateway.db");
  const first = new GatewayStore(path);
  const metadata = { requestFingerprint: "hash", environmentId: "env", vaultIds: ["vault"], hasSystemOverride: false };
  first.saveSessionConfiguration("session", "original", metadata); first.close();
  const second = new GatewayStore(path); t.after(() => second.close());
  second.saveSessionConfiguration("session", "changed", { ...metadata, environmentId: "new" });
  assert.equal(second.getSessionConfiguration("session")?.fingerprint, "original");
  assert.equal(second.getSessionConfiguration("session")?.metadata.environmentId, "env");
  assert.equal(second.getSessionConfiguration("legacy"), undefined);
});

test("sessions are isolated by channel installation", () => {
  const store = new GatewayStore(":memory:");
  const otherInstallation = { ...key, installationId: "cli-two" };
  const otherChannel = { ...key, channelType: "slack", installationId: "workspace-one" };
  store.saveSession(key, "session-1", "agent-1");
  store.saveSession(otherInstallation, "session-2", "agent-1");
  store.saveSession(otherChannel, "session-3", "agent-1");
  assert.equal(store.getSession(key), "session-1");
  assert.equal(store.getSession(otherInstallation), "session-2");
  assert.equal(store.getSession(otherChannel), "session-3");
  store.close();
});

test("opening a v0.2 database migrates legacy sessions and audit columns", () => {
  const directory = mkdtempSync(join(tmpdir(), "arkagent-store-"));
  const path = join(directory, "gateway.db");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE conversations (conversation_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, agent_version TEXT, updated_at TEXT NOT NULL);
    INSERT INTO conversations VALUES ('tenant:chat:-:user', 'legacy-session', 'agent-1', NULL, '2026-01-01T00:00:00.000Z');
    CREATE TABLE audit_logs (id TEXT PRIMARY KEY, tenant_key TEXT NOT NULL, open_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL, session_id TEXT, action TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER, request_id TEXT, summary TEXT, created_at TEXT NOT NULL);
  `);
  legacy.close();
  const store = new GatewayStore(path);
  store.resetSession(key);
  assert.equal(store.getSession(key), undefined);
  const reopen = new DatabaseSync(path);
  reopen.prepare("INSERT INTO conversations (conversation_key, session_id, agent_id, agent_version, updated_at) VALUES (?, ?, ?, ?, ?)").run("tenant:chat:-:user", "legacy-session", "agent-1", null, "2026-01-01T00:00:00.000Z");
  reopen.close();
  assert.equal(store.getSession(key), "legacy-session");
  assert.equal(store.getSessionVaultIds(key), undefined);
  const log = store.addAuditLog({ channelType: "lark", installationId: "cli-one", tenantKey: "tenant", openId: "user", chatId: "chat", messageId: "om-1", action: "message", status: "succeeded" });
  assert.equal(log.installationId, "cli-one");
  assert.equal(store.listAuditLogs()[0].channelType, "lark");
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("store claims the same channel event only once", () => {
  const store = new GatewayStore(":memory:");
  assert.equal(store.claimEvent("lark", "cli-one", "event-1"), true);
  assert.equal(store.claimEvent("lark", "cli-one", "event-1"), false);
  store.completeEvent("lark", "cli-one", "event-1", "completed");
  assert.equal(store.claimEvent("lark", "cli-one", "event-1"), false);
  assert.equal(store.claimEvent("lark", "cli-two", "event-1"), true);
  store.close();
});

test("safe failures and expired pre-dispatch leases can retry but submitted work cannot", () => {
  const store = new GatewayStore(":memory:");
  const now = Date.now();
  store.claimEvent("lark", "cli", "retry", now);
  store.completeEvent("lark", "cli", "retry", "failed");
  assert.equal(store.claimEvent("lark", "cli", "retry", now + 3_000), true);
  assert.equal(store.claimEvent("lark", "cli", "retry", now + 4_000), false);
  store.claimEvent("lark", "cli", "crashed", now);
  assert.equal(store.claimEvent("lark", "cli", "crashed", now + 16 * 60_000), true);
  store.claimEvent("lark", "cli", "sent", now);
  store.touchEvent({ channelType: "lark", installationId: "cli", messageId: "sent" } as any, true);
  store.completeEvent("lark", "cli", "sent", "failed");
  assert.equal(store.claimEvent("lark", "cli", "sent", now + 60 * 60_000), false);
  store.close();
});

test("configured Agent mismatch never silently reuses another Agent Session", () => {
  const store = new GatewayStore(":memory:");
  store.saveSession(key, "original-session", "agent-a");
  store.assertSessionAgent(key, "agent-a");
  assert.throws(() => store.assertSessionAgent(key, "agent-b"), /Agent.*不一致/);
  assert.equal(store.getSession(key), "original-session");
  store.close();
});

test("legacy in-flight and failed events remain non-retryable after migration", t => {
  const directory = mkdtempSync(join(tmpdir(), "arkagent-legacy-events-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "gateway.db");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE processed_events (event_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO processed_events VALUES ('lark:cli:running', 'processing', '2026-01-01T00:00:00.000Z');
    INSERT INTO processed_events VALUES ('lark:cli:failed', 'failed', '2026-01-01T00:00:00.000Z');`);
  legacy.close();
  const store = new GatewayStore(path);
  t.after(() => store.close());
  assert.equal(store.claimEvent("lark", "cli", "running"), false);
  assert.equal(store.claimEvent("lark", "cli", "failed"), false);
  assert.equal(store.claimEvent("lark", "cli", "new"), true);
});

test("store resets every session without clearing event deduplication", () => {
  const store = new GatewayStore(":memory:");
  const anotherKey = { ...key, conversationId: "chat-2" };
  store.saveSession(key, "session-1", "agent-1");
  store.saveSession(anotherKey, "session-2", "agent-1");
  assert.equal(store.claimEvent("lark", "cli-one", "event-1"), true);
  assert.equal(store.resetAllSessions(), 2);
  assert.equal(store.getSession(key), undefined);
  assert.equal(store.getSession(anotherKey), undefined);
  assert.equal(store.claimEvent("lark", "cli-one", "event-1"), false);
  store.close();
});

test("group context cursors are session-bound, monotonic and cleared with the session", () => {
  const store = new GatewayStore(":memory:");
  store.saveSession(key, "session-1", "agent-1");
  store.saveConversationContextCursor(key, "session-1", 200);
  store.saveConversationContextCursor(key, "session-1", 100);
  assert.equal(store.getConversationContextCursor(key, "session-1"), 200);

  store.saveSession(key, "session-2", "agent-1");
  store.saveConversationContextCursor(key, "session-2", 50);
  assert.equal(store.getConversationContextCursor(key, "session-1"), undefined);
  assert.equal(store.getConversationContextCursor(key, "session-2"), 50);

  store.resetSession(key);
  assert.equal(store.getConversationContextCursor(key, "session-2"), undefined);
  store.close();
});

test("employee users are observed with first, latest and usage count", () => {
  const store = new GatewayStore(":memory:");
  const first = store.observeEmployeeUser("tenant", "user-1");
  const second = store.observeEmployeeUser("tenant", "user-1");
  assert.equal(first.usageCount, 1);
  assert.equal(second.usageCount, 2);
  assert.equal(second.firstUsedAt, first.firstUsedAt);
  assert.equal(store.listEmployeeUsers().length, 1);
  store.close();
});

test("audit logs are newest first", () => {
  const store = new GatewayStore(":memory:");
  store.addAuditLog({ tenantKey: "tenant", openId: "user-1", chatId: "chat", messageId: "message-1", action: "message", status: "failed" });
  store.addAuditLog({ tenantKey: "tenant", openId: "user-2", chatId: "chat", messageId: "message-2", action: "message", status: "succeeded", durationMs: 12 });
  const logs = store.listAuditLogs();
  assert.equal(logs.length, 2);
  assert.equal(logs[0].openId, "user-2");
  store.close();
});

test("conversation audit keeps request and response summaries for history fallback", () => {
  const store = new GatewayStore(":memory:");
  store.addAuditLog({
    channelType: "lark", installationId: "cli-one", tenantKey: "tenant", openId: "user-1",
    chatId: "chat", messageId: "message-1", action: "message", status: "succeeded",
    summary: "读取文档 https://example.com/wiki/one", responseSummary: "已使用 Bot 身份读取文档", messageCreateTime: 100
  });
  store.addAuditLog({
    channelType: "lark", installationId: "cli-two", tenantKey: "tenant", openId: "user-2",
    chatId: "chat", messageId: "message-2", action: "message", status: "succeeded", summary: "另一个应用"
  });
  store.addAuditLog({
    channelType: "lark", installationId: "cli-one", tenantKey: "tenant", openId: "user-3",
    chatId: "chat", messageId: "message-future", action: "message", status: "succeeded",
    summary: "未来消息", messageCreateTime: 300
  });

  const logs = store.listConversationAudit({
    channelType: "lark", installationId: "cli-one", tenantKey: "tenant", chatId: "chat", beforeCreateTime: 200, limit: 10
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].summary, "读取文档 https://example.com/wiki/one");
  assert.equal(logs[0].responseSummary, "已使用 Bot 身份读取文档");
  assert.equal(logs[0].messageCreateTime, 100);
  store.close();
});

test("session audit fallback is scoped to one Managed Agents Session", () => {
  const store = new GatewayStore(":memory:");
  store.addAuditLog({
    channelType: "lark", installationId: "cli-one", tenantKey: "tenant", openId: "user-1",
    chatId: "chat", messageId: "message-1", sessionId: "session-old", action: "message", status: "succeeded",
    summary: "项目代号是北极星", responseSummary: "已记住项目代号", messageCreateTime: 100
  });
  store.addAuditLog({
    channelType: "lark", installationId: "cli-one", tenantKey: "tenant", openId: "user-1",
    chatId: "chat", messageId: "message-2", sessionId: "session-other", action: "message", status: "succeeded",
    summary: "不应串入", responseSummary: "其他会话", messageCreateTime: 200
  });
  store.addAuditLog({
    channelType: "lark", installationId: "cli-one", tenantKey: "tenant", openId: "user-1",
    chatId: "chat", messageId: "message-3", sessionId: "session-old", action: "authorization_required", status: "succeeded",
    summary: "不应作为对话上下文"
  });

  const logs = store.listSessionAudit("session-old", 10);

  assert.equal(logs.length, 1);
  assert.equal(logs[0].summary, "项目代号是北极星");
  assert.equal(logs[0].responseSummary, "已记住项目代号");
  store.close();
});
