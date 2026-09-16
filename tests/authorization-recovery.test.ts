import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayStore } from "../src/store.ts";
import { Gateway, toConversationKey, type IncomingMessage } from "../src/gateway.ts";

const incoming: IncomingMessage = { channelType: "lark", installationId: "cli", tenantId: "tenant", senderId: "user",
  conversationId: "chat", conversationType: "direct", threadId: "", parentMessageId: "", rootMessageId: "",
  messageId: "message", eventId: "event", text: "查看日程", resources: [], mentionedBot: false, createTime: 1 };
const options = { agentId: "agent", environmentId: "env", vaultId: "bot", timeoutMs: 1000, platformAccess: true };

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), "后台任务应在测试期限内完成");
}

test("authorization recovery attempts persist and remain bound to the original identity and Session", t => {
  const dir = mkdtempSync(join(tmpdir(), "arkagent-auth-recovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.db");
  const first = new GatewayStore(path);
  assert.equal(first.startAuthorizationRecovery(incoming, "original"), true);
  assert.equal(first.startAuthorizationRecovery(incoming, "different"), false);
  assert.equal(first.claimAuthorizationRecovery(incoming), true);
  first.close();
  const second = new GatewayStore(path); t.after(() => second.close());
  assert.equal(second.getAuthorizationRecovery(incoming)?.sessionId, "original");
  assert.equal(second.getAuthorizationRecovery(incoming)?.state, "resuming");
  assert.equal(second.claimAuthorizationRecovery(incoming), false);
  for (const changed of [{ installationId: "other" }, { tenantId: "other" }, { senderId: "other" }, { conversationId: "other" }]) {
    assert.equal(second.getAuthorizationRecovery({ ...incoming, ...changed }), undefined);
  }
});

test("legacy Session without the authorized Vault is not silently handed off", async () => {
  const store = new GatewayStore(":memory:");
  store.saveSession(toConversationKey(incoming), "original", "agent");
  store.startAuthorizationRecovery(incoming, "original");
  let operations = 0;
  const replies: string[] = [];
  const gateway = new Gateway(store, {
    createSession: async () => { operations++; return "wrong"; },
    run: async () => { operations++; return { terminal: "idle", messages: ["wrong"] }; }
  }, async (_message, output) => { if (output.type === "text") replies.push(output.text); }, options);
  gateway.resumeAfterAuthorization(incoming, "user-vault");
  await until(() => replies.length > 0);
  assert.equal(operations, 0);
  assert.equal(store.getSession(toConversationKey(incoming)), "original");
  assert.match(replies[0], /未挂载.*Vault/);
  assert.match(replies[0], /文件.*不会迁移/);
  assert.equal(store.getAuthorizationRecovery(incoming)?.state, "blocked");
  store.close();
});

test("late OAuth completion cannot resurrect a reset or replaced Session", async () => {
  for (const replacement of [undefined, "replacement"]) {
    const store = new GatewayStore(":memory:");
    store.startAuthorizationRecovery(incoming, "original");
    if (replacement) store.saveSession(toConversationKey(incoming), replacement, "agent", undefined, ["bot", "user-vault"]);
    let operations = 0, replies = 0;
    const gateway = new Gateway(store, {
      createSession: async () => { operations++; return "wrong"; },
      run: async () => { operations++; return { terminal: "idle", messages: ["wrong"] }; }
    }, async () => { replies++; }, options);
    gateway.resumeAfterAuthorization(incoming, "user-vault");
    await until(() => replies > 0);
    assert.equal(operations, 0);
    assert.equal(store.getSession(toConversationKey(incoming)), replacement);
    assert.equal(store.getAuthorizationRecovery(incoming)?.state, "blocked");
    store.close();
  }
});

test("duplicate OAuth callbacks enqueue at most one recovery across Gateway instances", async () => {
  const store = new GatewayStore(":memory:");
  store.saveSession(toConversationKey(incoming), "original", "agent", undefined, ["bot", "user-vault"]);
  store.startAuthorizationRecovery(incoming, "original");
  let runs = 0;
  const ark = { createSession: async () => { throw new Error("no new Session"); },
    run: async () => { runs++; return { terminal: "idle" as const, messages: ["完成"] }; } };
  const one = new Gateway(store, ark, async () => undefined, options);
  const two = new Gateway(store, ark, async () => undefined, options);
  one.resumeAfterAuthorization(incoming, "user-vault");
  two.resumeAfterAuthorization(incoming, "user-vault");
  await until(() => store.getAuthorizationRecovery(incoming)?.state === "completed");
  assert.equal(runs, 1);
  store.close();
});

test("authorization recovery never submits while MA state is running, failed or unknown", async () => {
  for (const status of ["running", "failed", undefined] as const) {
    const store = new GatewayStore(":memory:");
    store.saveSession(toConversationKey(incoming), "original", "agent", undefined, ["bot", "user-vault"]);
    store.startAuthorizationRecovery(incoming, "original");
    let runs = 0;
    const replies: string[] = [];
    const gateway = new Gateway(store, {
      createSession: async () => { throw new Error("no new Session"); },
      getSessionStats: async () => ({ eventCount: 10, status }),
      run: async () => { runs++; return { terminal: "idle", messages: ["wrong"] }; }
    }, async (_message, output) => { if (output.type === "text") replies.push(output.text); }, options);
    gateway.resumeAfterAuthorization(incoming, "user-vault");
    await until(() => replies.length > 0);
    assert.equal(runs, 0);
    assert.match(replies[0], /尚未确认空闲/);
    assert.equal(store.getSession(toConversationKey(incoming)), "original");
    store.close();
  }
});

test("recovery validates the Session after queue admission, not only at callback arrival", async () => {
  const store = new GatewayStore(":memory:");
  store.saveSession(toConversationKey(incoming), "original", "agent", undefined, ["bot", "user-vault"]);
  store.startAuthorizationRecovery(incoming, "original");
  let started = false, runs = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const replies: string[] = [];
  const gateway = new Gateway(store, {
    createSession: async () => { throw new Error("no new Session"); },
    run: async () => { started = true; runs++; await blocked; return { terminal: "idle", messages: ["其他任务完成"] }; }
  }, async (_message, output) => { if (output.type === "text") replies.push(output.text); }, options);
  gateway.accept({ ...incoming, messageId: "other", eventId: "other" });
  await until(() => started);
  gateway.accept({ ...incoming, messageId: "reset", eventId: "reset", text: "/new" });
  gateway.resumeAfterAuthorization(incoming, "user-vault");
  release();
  await until(() => store.getAuthorizationRecovery(incoming)?.state === "blocked");
  assert.equal(runs, 1);
  assert.equal(store.getSession(toConversationKey(incoming)), undefined);
  assert.ok(replies.some(reply => reply.includes("原会话已重置或替换")));
  store.close();
});

test("employee group initialization skips UAT hooks even in legacy per-message mode", async () => {
  const store = new GatewayStore(":memory:");
  let hooks = 0, runs = 0;
  const gateway = new Gateway(store, {
    createSession: async request => {
      assert.deepEqual(request.vault_ids, ["bot"]);
      assert.equal(request.environment?.config?.env?.LARKSUITE_CLI_STRICT_MODE, "bot");
      return "group";
    },
    run: async () => { runs++; return { terminal: "idle", messages: ["完成"] }; }
  }, async () => undefined, { ...options, perMessageSessions: true,
    beforeDirectTurn: async () => { hooks++; }, getUserVaultIds: async () => { hooks++; return ["user-vault"]; } });
  gateway.accept({ ...incoming, conversationType: "group", mentionedBot: true });
  await until(() => store.listAuditLogs().length > 0);
  assert.equal(runs, 1);
  assert.equal(hooks, 0);
  store.close();
});
