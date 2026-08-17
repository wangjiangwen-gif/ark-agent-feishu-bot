import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Gateway, resultToReply, shouldHandleMessage, toConversationKey, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return { eventId: "event-1", messageId: "message-1", chatId: "chat-1", chatType: "p2p", threadId: "", userOpenId: "user-1", tenantKey: "tenant-1", text: "你好", attachments: [], mentionedBot: false, ...overrides };
}

test("group messages require an explicit bot mention", () => {
  assert.equal(shouldHandleMessage(message({ chatType: "group", mentionedBot: false })), false);
  assert.equal(shouldHandleMessage(message({ chatType: "group", mentionedBot: true })), true);
});

test("group conversations are isolated by the sender open_id", () => {
  const first = message({ chatType: "group", mentionedBot: true, userOpenId: "ou-user-1" });
  const second = message({ chatType: "group", mentionedBot: true, userOpenId: "ou-user-2" });
  const store = new GatewayStore(":memory:");
  assert.notEqual(store.conversationKey(toConversationKey(first)), store.conversationKey(toConversationKey(second)));
  store.close();
});

test("result requires both a successful terminal and a business message", () => {
  assert.throws(() => resultToReply({ terminal: "idle", messages: [] }), /没有产生回复/);
  assert.throws(() => resultToReply({ terminal: "failed", messages: ["partial"] }), /执行失败/);
  assert.equal(resultToReply({ terminal: "idle", messages: ["完成"] }), "完成");
  assert.equal(resultToReply({
    terminal: "idle",
    messages: ["让我先检查 lark-cli。", "现在读取相关 Skill。", "文档已创建：https://example.com/docx/1"]
  }), "文档已创建：https://example.com/docx/1");
});

test("gateway acknowledges quickly, deduplicates, and reuses a session", async () => {
  const store = new GatewayStore(":memory:");
  let creates = 0;
  let runs = 0;
  const replies: string[] = [];
  const ark = {
    createSession: async () => `session-${++creates}`,
    run: async () => { runs++; return { terminal: "idle" as const, messages: ["回复"] }; }
  };
  const gateway = new Gateway(store, ark, async (_chatId, text) => { replies.push(text); }, { agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserOpenId: "user-1", timeoutMs: 5_000 });
  assert.equal(gateway.accept(message()), true);
  assert.equal(gateway.accept(message()), false);
  gateway.accept(message({ eventId: "event-2", messageId: "message-2", text: "再问" }));
  await delay(30);
  assert.equal(creates, 1);
  assert.equal(runs, 2);
  assert.deepEqual(replies, ["已收到，正在处理。首次启动可能需要几分钟。", "回复", "回复"]);
  store.close();
});

test("gateway creates a session bound to the user Vault", async () => {
  const store = new GatewayStore(":memory:");
  let sessionVaultIds: string[] | undefined;
  let sessionEnv: Record<string, string> | undefined;
  const gateway = new Gateway(store, {
    createSession: async (_agentId, _environmentId, vaultIds, env) => {
      sessionVaultIds = vaultIds;
      sessionEnv = env;
      return "session-1";
    },
    run: async () => ({ terminal: "idle" as const, messages: ["完成"] })
  }, async () => undefined, { agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserOpenId: "ou-current-user", timeoutMs: 5_000 });
  gateway.accept(message({ userOpenId: "ou-current-user" }));
  await delay(30);
  assert.deepEqual(sessionVaultIds, ["vlt-1"]);
  assert.deepEqual(sessionEnv, { FEISHU_USER_OPEN_ID: "ou-current-user" });
  store.close();
});

test("reused slow sessions receive one delayed processing reply", async () => {
  const store = new GatewayStore(":memory:");
  const replies: string[] = [];
  let runs = 0;
  const gateway = new Gateway(store, {
    createSession: async () => "session-1",
    run: async () => {
      runs++;
      if (runs === 2) await delay(20);
      return { terminal: "idle" as const, messages: ["回复"] };
    }
  }, async (_chatId, text) => { replies.push(text); }, { agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserOpenId: "user-1", timeoutMs: 5_000, progressDelayMs: 5 });
  gateway.accept(message());
  await delay(20);
  gateway.accept(message({ eventId: "event-2", messageId: "message-2" }));
  await delay(40);
  assert.deepEqual(replies, [
    "已收到，正在处理。首次启动可能需要几分钟。", "回复",
    "已收到，正在处理，请稍候。", "回复"
  ]);
  store.close();
});

test("gateway filters Agent tool progress and sends only the final reply", async () => {
  const store = new GatewayStore(":memory:");
  store.saveSession({ tenantKey: "tenant-1", chatId: "chat-1", threadId: "", userOpenId: "user-1" }, "session-1", "agent-1");
  const replies: string[] = [];
  let receivedProgressCallback = false;
  const gateway = new Gateway(store, {
    createSession: async () => "session-1",
    run: async (_sessionId, _text, _timeout, onProgress) => {
      receivedProgressCallback = Boolean(onProgress);
      await onProgress?.("正在执行：检查 lark-cli");
      return { terminal: "idle" as const, messages: ["可用"] };
    }
  }, async (_chatId, text) => { replies.push(text); }, { agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserOpenId: "user-1", timeoutMs: 5_000, progressDelayMs: 50 });
  gateway.accept(message());
  await delay(20);
  assert.equal(receivedProgressCallback, false);
  assert.deepEqual(replies, ["可用"]);
  store.close();
});

test("gateway rejects users other than the authorized user", async () => {
  const store = new GatewayStore(":memory:");
  const replies: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => "never", run: async () => ({ terminal: "idle", messages: [] }) }, async (_chatId, text) => { replies.push(text); }, { agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserOpenId: "user-1", timeoutMs: 5_000 });
  gateway.accept(message({ userOpenId: "user-2" }));
  await delay(20);
  assert.match(replies[0], /未授权/);
  store.close();
});

test("employee platform access accepts every message delivered by Feishu and observes the user", async () => {
  const store = new GatewayStore(":memory:");
  let creates = 0;
  const gateway = new Gateway(store, {
    createSession: async () => { creates++; return "session"; },
    run: async () => ({ terminal: "idle" as const, messages: ["完成"] })
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true
  });
  gateway.accept(message({ userOpenId: "platform-approved" }));
  await delay(20);
  assert.equal(creates, 1);
  assert.equal(store.getEmployeeUser("tenant-1", "platform-approved")?.usageCount, 1);
  assert.equal(store.listAuditLogs()[0].status, "succeeded");
  store.close();
});

test("/new resets the session without refreshing an expired credential", async () => {
  const store = new GatewayStore(":memory:");
  const key = { tenantKey: "tenant-1", chatId: "chat-1", threadId: "", userOpenId: "user-1" };
  store.saveSession(key, "session-old", "agent-1");
  const replies: string[] = [];
  let refreshAttempts = 0;
  const gateway = new Gateway(store, {
    createSession: async () => "never",
    run: async () => ({ terminal: "idle" as const, messages: [] })
  }, async (_chatId, text) => { replies.push(text); }, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserOpenId: "user-1", timeoutMs: 5_000,
    beforeCreateSession: async () => { refreshAttempts++; throw new Error("expired"); }
  });
  gateway.accept(message({ text: "/new" }));
  await delay(20);
  assert.equal(refreshAttempts, 0);
  assert.equal(store.getSession(key), undefined);
  assert.match(replies[0], /已开启新会话/);
  store.close();
});

test("gateway downloads, uploads and mounts a Feishu file before running the Agent", async () => {
  const store = new GatewayStore(":memory:");
  const operations: string[] = [];
  let prompt = "";
  const gateway = new Gateway(store, {
    createSession: async () => { operations.push("session"); return "session-1"; },
    uploadFile: async (name, mimeType, bytes) => {
      operations.push(`upload:${name}:${mimeType}:${bytes.byteLength}`);
      return { id: "file-1", name };
    },
    addSessionFile: async (_sessionId, _fileId, mountPath) => { operations.push(`mount:${mountPath}`); },
    run: async (_sessionId, text) => { prompt = text; operations.push("run"); return { terminal: "idle" as const, messages: ["文件摘要"] }; }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserOpenId: "user-1", timeoutMs: 5_000,
    downloadAttachment: async attachment => ({ bytes: new Uint8Array([1, 2]), mimeType: attachment.type === "image" ? "image/jpeg" : "application/pdf" })
  });
  gateway.accept(message({ text: "", attachments: [{ key: "file-key", name: "季度计划.pdf", type: "file" }] }));
  await delay(30);
  assert.deepEqual(operations, ["session", "upload:季度计划.pdf:application/pdf:2", "mount:/mnt/data/季度计划.pdf", "run"]);
  assert.match(prompt, /\/mnt\/data\/季度计划\.pdf/);
  store.close();
});

test("gateway sends Markdown source inline without uploading it to Ark Files", async () => {
  const store = new GatewayStore(":memory:");
  let uploads = 0;
  let mounts = 0;
  let prompt = "";
  const source = "# 计划\n\n- 第一项\n- 第二项";
  const gateway = new Gateway(store, {
    createSession: async () => "session-1",
    uploadFile: async () => { uploads++; return { id: "never", name: "never" }; },
    addSessionFile: async () => { mounts++; },
    run: async (_sessionId, text) => { prompt = text; return { terminal: "idle" as const, messages: ["摘要"] }; }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserOpenId: "user-1", timeoutMs: 5_000,
    downloadAttachment: async () => ({ bytes: new TextEncoder().encode(source), mimeType: "text/plain" })
  });
  gateway.accept(message({ text: "", attachments: [{ key: "file-key", name: "计划.md", type: "file" }] }));
  await delay(30);
  assert.equal(uploads, 0);
  assert.equal(mounts, 0);
  assert.match(prompt, /以下是用户发送的纯文本文件原文/);
  assert.match(prompt, /# 计划\n\n- 第一项\n- 第二项/);
  store.close();
});
