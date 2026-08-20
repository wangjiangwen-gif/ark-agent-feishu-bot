import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GatewayStore } from "../src/store.ts";

const key = { channelType: "lark", installationId: "cli-one", tenantId: "tenant", conversationId: "chat", threadId: "", senderId: "user" };

test("store saves, reuses and resets a conversation session", () => {
  const store = new GatewayStore(":memory:");
  store.saveSession(key, "session-1", "agent-1", "3");
  assert.equal(store.getSession(key), "session-1");
  store.resetSession(key);
  assert.equal(store.getSession(key), undefined);
  store.close();
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
  reopen.prepare("INSERT INTO conversations VALUES (?, ?, ?, ?, ?)").run("tenant:chat:-:user", "legacy-session", "agent-1", null, "2026-01-01T00:00:00.000Z");
  reopen.close();
  assert.equal(store.getSession(key), "legacy-session");
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
