import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Gateway, resultToReply, shouldHandleMessage, toConversationKey, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channelType: "lark", installationId: "cli-test", eventId: "event-1", messageId: "message-1",
    conversationId: "chat-1", conversationType: "direct", threadId: "", rootMessageId: "", parentMessageId: "",
    createTime: 1_700_000_000_000, senderId: "user-1", tenantId: "tenant-1", text: "你好",
    resources: [], mentionedBot: false, ...overrides
  };
}

const collectText = (target: string[]) => async (_message: IncomingMessage, outbound: { type: "text"; text: string } | { type: "markdown"; markdown: string } | { type: "card"; card: Record<string, unknown> }): Promise<void> => {
  if (outbound.type === "text") target.push(outbound.text);
};

test("group messages require an explicit bot mention", () => {
  assert.equal(shouldHandleMessage(message({ conversationType: "group", mentionedBot: false })), false);
  assert.equal(shouldHandleMessage(message({ conversationType: "group", mentionedBot: true })), true);
});

test("group conversations are isolated by the sender open_id", () => {
  const first = message({ conversationType: "group", mentionedBot: true, senderId: "ou-user-1" });
  const second = message({ conversationType: "group", mentionedBot: true, senderId: "ou-user-2" });
  const store = new GatewayStore(":memory:");
  assert.notEqual(store.conversationKey(toConversationKey(first)), store.conversationKey(toConversationKey(second)));
  store.close();
});

test("per-message mode starts same-chat group requests concurrently in isolated sessions", async () => {
  const store = new GatewayStore(":memory:");
  const created: Array<{ sessionId: string; env: Record<string, string> }> = [];
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const gateway = new Gateway(store, {
    createSession: async (_agentId, _environmentId, _vaultIds, env) => {
      const sessionId = `session-${created.length + 1}`;
      created.push({ sessionId, env });
      return sessionId;
    },
    run: async sessionId => {
      started.push(sessionId);
      await new Promise<void>(resolve => releases.set(sessionId, resolve));
      return { terminal: "idle" as const, messages: [`${sessionId} 完成`] };
    }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, perMessageSessions: true
  });

  gateway.accept(message({
    eventId: "event-a", messageId: "message-a", conversationType: "group", mentionedBot: true,
    senderId: "ou-a", text: "任务 A"
  }));
  gateway.accept(message({
    eventId: "event-b", messageId: "message-b", conversationType: "group", mentionedBot: true,
    senderId: "ou-b", text: "任务 B"
  }));
  await delay(20);

  assert.deepEqual(started, ["session-1", "session-2"]);
  assert.equal(created[0].env.FEISHU_USER_OPEN_ID, "ou-a");
  assert.equal(created[1].env.FEISHU_USER_OPEN_ID, "ou-b");
  releases.get("session-2")?.();
  releases.get("session-1")?.();
  await delay(20);
  assert.equal(store.getSession(toConversationKey(message({ senderId: "ou-a" }))), undefined);
  assert.equal(store.listAuditLogs().length, 2);
  store.close();
});

test("per-message mode still queues direct messages and reuses one Session", async () => {
  const store = new GatewayStore(":memory:");
  let creates = 0;
  const started: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const gateway = new Gateway(store, {
    createSession: async () => `session-${++creates}`,
    run: async (_sessionId, input) => {
      started.push(input);
      if (input === "私聊 A") await new Promise<void>(resolve => { releaseFirst = resolve; });
      return { terminal: "idle" as const, messages: [`${input} 完成`] };
    }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, perMessageSessions: true
  });

  gateway.accept(message({ eventId: "event-a", messageId: "message-a", text: "私聊 A" }));
  gateway.accept(message({ eventId: "event-b", messageId: "message-b", text: "私聊 B" }));
  await delay(20);

  assert.deepEqual(started, ["私聊 A"]);
  releaseFirst?.();
  await delay(30);
  assert.deepEqual(started, ["私聊 A", "私聊 B"]);
  assert.equal(creates, 1);
  assert.equal(store.getSession(toConversationKey(message())), "session-1");
  store.close();
});

test("per-message group Session receives bounded history and current channel identifiers", async () => {
  const store = new GatewayStore(":memory:");
  let prompt = "";
  let sessionEnv: Record<string, string> = {};
  const gateway = new Gateway(store, {
    createSession: async (_agentId, _environmentId, _vaultIds, env) => { sessionEnv = env; return "session-one"; },
    run: async (_sessionId, input) => { prompt = input; return { terminal: "idle" as const, messages: ["完成"] }; }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, perMessageSessions: true, dualIdentity: true,
    loadRecentHistory: async () => [
      { messageId: "history-1", senderId: "ou-a", senderName: "张三", senderType: "user", source: "thread", text: "下午改到四点", createTime: 1_699_999_999_000 }
    ]
  });
  gateway.accept(message({
    conversationType: "group", mentionedBot: true, senderId: "ou-b", text: "帮大家约一下",
    threadId: "omt-one", rootMessageId: "om-root", parentMessageId: "om-root"
  }));
  await delay(30);

  assert.match(prompt, /<conversation_context/);
  assert.match(prompt, /"context_scope":"thread"/);
  assert.match(prompt, /张三.*下午改到四点/);
  assert.match(prompt, /<current_request>\n帮大家约一下/);
  assert.deepEqual(sessionEnv, {
    FEISHU_USER_OPEN_ID: "ou-b",
    FEISHU_CHAT_ID: "chat-1",
    FEISHU_THREAD_ID: "omt-one",
    FEISHU_TRIGGER_MESSAGE_ID: "message-1",
    FEISHU_TRIGGER_CREATE_TIME: "1700000000000",
    LARKSUITE_CLI_STRICT_MODE: "off"
  });
  store.close();
});

test("group requests still run when recent history cannot be loaded", async () => {
  const store = new GatewayStore(":memory:");
  let prompt = "";
  const gateway = new Gateway(store, {
    createSession: async () => "session-one",
    run: async (_sessionId, input) => { prompt = input; return { terminal: "idle" as const, messages: ["完成"] }; }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, perMessageSessions: true,
    loadRecentHistory: async () => { throw new Error("missing scope"); }
  });

  gateway.accept(message({ conversationType: "group", mentionedBot: true, text: "只处理当前请求" }));
  await delay(30);

  assert.equal(prompt, "只处理当前请求");
  assert.equal(store.listAuditLogs()[0].status, "succeeded");
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
  const gateway = new Gateway(store, ark, collectText(replies), { agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000 });
  assert.equal(gateway.accept(message()), true);
  assert.equal(gateway.accept(message()), false);
  assert.equal(gateway.accept(message({ eventId: "duplicate-event", messageId: "message-1" })), false);
  gateway.accept(message({ eventId: "event-2", messageId: "message-2", text: "再问" }));
  await delay(30);
  assert.equal(creates, 1);
  assert.equal(runs, 2);
  assert.deepEqual(replies, ["已收到，正在处理。首次启动可能需要几分钟。", "回复", "回复"]);
  store.close();
});

test("gateway creates a session bound to the user Vault", async () => {
  const store = new GatewayStore(":memory:");
  let sessionAgentId = "";
  let sessionEnvironmentId = "";
  let sessionVaultIds: string[] | undefined;
  let sessionEnv: Record<string, string> | undefined;
  const gateway = new Gateway(store, {
    createSession: async (agentId, environmentId, vaultIds, env) => {
      sessionAgentId = agentId;
      sessionEnvironmentId = environmentId;
      sessionVaultIds = vaultIds;
      sessionEnv = env;
      return "session-1";
    },
    run: async () => ({ terminal: "idle" as const, messages: ["完成"] })
  }, async () => undefined, { agentId: "agent-user-owned", environmentId: "env-user-owned", vaultId: "vlt-1", authorizedUserId: "ou-current-user", timeoutMs: 5_000 });
  gateway.accept(message({ senderId: "ou-current-user" }));
  await delay(30);
  assert.equal(sessionAgentId, "agent-user-owned");
  assert.equal(sessionEnvironmentId, "env-user-owned");
  assert.deepEqual(sessionVaultIds, ["vlt-1"]);
  assert.deepEqual(sessionEnv, { FEISHU_USER_OPEN_ID: "ou-current-user" });
  store.close();
});

test("gateway compacts the old session before resuming in a user-authorized session", async () => {
  const store = new GatewayStore(":memory:");
  const key = toConversationKey(message());
  store.saveSession(key, "session-old", "agent-1");
  const operations: string[] = [];
  let resumedInput = "";
  let sessionVaultIds: string[] = [];
  const gateway = new Gateway(store, {
    createSession: async (_agentId, _environmentId, vaultIds) => {
      operations.push("create:session-new");
      sessionVaultIds = vaultIds;
      return "session-new";
    },
    run: async (sessionId, input) => {
      operations.push(`run:${sessionId}`);
      if (sessionId === "session-old") {
        assert.match(input, /不要调用工具/);
        return { terminal: "idle" as const, messages: ["用户目标：安排项目复盘；已知参会人：张三、李四。"] };
      }
      resumedInput = input;
      return { terminal: "idle" as const, messages: ["已继续处理"] };
    }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, getUserVaultIds: async () => ["vlt-user"]
  });

  gateway.resumeWithHandoff(message({ text: "帮我找大家有空的时间" }));
  await delay(40);

  assert.deepEqual(operations, ["run:session-old", "create:session-new", "run:session-new"]);
  assert.deepEqual(sessionVaultIds, ["vlt-bot", "vlt-user"]);
  assert.match(resumedInput, /source_session_id: session-old/);
  assert.match(resumedInput, /用户目标：安排项目复盘/);
  assert.match(resumedInput, /旧 Session 的文件系统、挂载文件和临时路径未迁移/);
  assert.match(resumedInput, /帮我找大家有空的时间/);
  assert.equal(store.getSession(key), "session-new");
  store.close();
});

test("gateway still rotates and resumes when old-session compaction fails", async () => {
  const store = new GatewayStore(":memory:");
  const key = toConversationKey(message());
  store.saveSession(key, "session-old", "agent-1");
  let resumedInput = "";
  const gateway = new Gateway(store, {
    createSession: async () => "session-new",
    run: async (sessionId, input) => {
      if (sessionId === "session-old") throw new Error("compact timeout");
      resumedInput = input;
      return { terminal: "idle" as const, messages: ["已继续处理"] };
    }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true
  });

  gateway.resumeWithHandoff(message({ text: "继续创建日程" }));
  await delay(40);

  assert.equal(resumedInput, "继续创建日程");
  assert.equal(store.getSession(key), "session-new");
  store.close();
});

test("gateway automatically compacts and rotates an oversized session", async () => {
  const store = new GatewayStore(":memory:");
  const key = toConversationKey(message());
  store.saveSession(key, "session-old", "agent-1");
  const operations: string[] = [];
  let newInput = "";
  const gateway = new Gateway(store, {
    getSessionStats: async sessionId => {
      operations.push(`stats:${sessionId}`);
      return { eventCount: 196, latestInputTokens: 27_611 };
    },
    createSession: async () => {
      operations.push("create:session-new");
      return "session-new";
    },
    run: async (sessionId, input) => {
      operations.push(`run:${sessionId}`);
      if (sessionId === "session-old") return { terminal: "idle" as const, messages: ["用户目标：继续完成办公任务。"] };
      newInput = input;
      return { terminal: "idle" as const, messages: ["完成"] };
    }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000
  });

  gateway.accept(message({ text: "继续" }));
  await delay(40);

  assert.deepEqual(operations, ["stats:session-old", "run:session-old", "create:session-new", "run:session-new"]);
  assert.match(newInput, /用户目标：继续完成办公任务/);
  assert.match(newInput, /<current_user_request>\n继续/);
  assert.equal(store.getSession(key), "session-new");
  store.close();
});

test("gateway reuses a session below the rotation threshold", async () => {
  const store = new GatewayStore(":memory:");
  const key = toConversationKey(message());
  store.saveSession(key, "session-current", "agent-1");
  let creates = 0;
  let runSession = "";
  const gateway = new Gateway(store, {
    getSessionStats: async () => ({ eventCount: 20, latestInputTokens: 4_000 }),
    createSession: async () => { creates++; return "session-new"; },
    run: async sessionId => {
      runSession = sessionId;
      return { terminal: "idle" as const, messages: ["完成"] };
    }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000
  });

  gateway.accept(message());
  await delay(30);

  assert.equal(creates, 0);
  assert.equal(runSession, "session-current");
  assert.equal(store.getSession(key), "session-current");
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
  }, collectText(replies), { agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000, progressDelayMs: 5 });
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
  store.saveSession(toConversationKey(message()), "session-1", "agent-1");
  const replies: string[] = [];
  let receivedProgressCallback = false;
  const gateway = new Gateway(store, {
    createSession: async () => "session-1",
    run: async (_sessionId, _text, _timeout, onProgress) => {
      receivedProgressCallback = Boolean(onProgress);
      await onProgress?.("正在执行：检查 lark-cli");
      return { terminal: "idle" as const, messages: ["可用"] };
    }
  }, collectText(replies), { agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000, progressDelayMs: 50 });
  gateway.accept(message());
  await delay(20);
  assert.equal(receivedProgressCallback, false);
  assert.deepEqual(replies, ["可用"]);
  store.close();
});

test("gateway streams the final response and clears the Get reaction", async () => {
  const store = new GatewayStore(":memory:");
  store.saveSession(toConversationKey(message()), "session-1", "agent-1");
  const replies: string[] = [];
  const snapshots: string[] = [];
  const reactions: string[] = [];
  const gateway = new Gateway(store, {
    createSession: async () => "session-1",
    run: async (_sessionId, _text, _timeout, _onProgress, onDelta) => {
      await onDelta?.("流式");
      await onDelta?.("流式回复");
      return { terminal: "idle" as const, messages: ["流式回复完成"] };
    }
  }, collectText(replies), {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000,
    addReaction: async (_message, emoji) => { reactions.push(`add:${emoji}`); return "reaction-1"; },
    removeReaction: async (_message, id) => { reactions.push(`remove:${id}`); },
    streamReply: async (_message, producer) => { await producer(async snapshot => { snapshots.push(snapshot); }); }
  });

  gateway.accept(message());
  await delay(30);

  assert.deepEqual(replies, []);
  assert.deepEqual(snapshots, ["流式", "流式回复", "流式回复完成"]);
  assert.deepEqual(reactions, ["add:Get", "remove:reaction-1"]);
  store.close();
});

test("gateway clears the Get reaction when streaming fails", async () => {
  const store = new GatewayStore(":memory:");
  store.saveSession(toConversationKey(message()), "session-1", "agent-1");
  const replies: string[] = [];
  const reactions: string[] = [];
  const gateway = new Gateway(store, {
    createSession: async () => "session-1",
    run: async () => { throw new Error("stream failed"); }
  }, collectText(replies), {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000,
    addReaction: async () => { reactions.push("add"); return "reaction-1"; },
    removeReaction: async () => { reactions.push("remove"); },
    streamReply: async (_message, producer) => { await producer(async () => undefined); }
  });

  gateway.accept(message());
  await delay(30);

  assert.deepEqual(reactions, ["add", "remove"]);
  assert.match(replies[0], /stream failed/);
  store.close();
});

test("gateway rejects users other than the authorized user", async () => {
  const store = new GatewayStore(":memory:");
  const replies: string[] = [];
  const gateway = new Gateway(store, { createSession: async () => "never", run: async () => ({ terminal: "idle", messages: [] }) }, collectText(replies), { agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000 });
  gateway.accept(message({ senderId: "user-2" }));
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
  gateway.accept(message({ senderId: "platform-approved" }));
  await delay(20);
  assert.equal(creates, 1);
  assert.equal(store.getEmployeeUser("tenant-1", "platform-approved")?.usageCount, 1);
  assert.equal(store.listAuditLogs()[0].status, "succeeded");
  store.close();
});

test("/new resets the session without refreshing an expired credential", async () => {
  const store = new GatewayStore(":memory:");
  const key = toConversationKey(message());
  store.saveSession(key, "session-old", "agent-1");
  const replies: string[] = [];
  let refreshAttempts = 0;
  const gateway = new Gateway(store, {
    createSession: async () => "never",
    run: async () => ({ terminal: "idle" as const, messages: [] })
  }, collectText(replies), {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000,
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
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000,
    downloadAttachment: async attachment => ({ bytes: new Uint8Array([1, 2]), mimeType: attachment.type === "image" ? "image/jpeg" : "application/pdf" })
  });
  gateway.accept(message({ text: "", resources: [{ id: "file-key", name: "季度计划.pdf", type: "file" }] }));
  await delay(30);
  assert.deepEqual(operations, ["session", "upload:季度计划.pdf:application/pdf:2", "mount:/mnt/data/季度计划.pdf", "run"]);
  assert.match(prompt, /文件已挂载到：\n- \/mnt\/session\/uploads\/mnt\/data\/季度计划\.pdf/);
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
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000,
    downloadAttachment: async () => ({ bytes: new TextEncoder().encode(source), mimeType: "text/plain" })
  });
  gateway.accept(message({ text: "", resources: [{ id: "file-key", name: "计划.md", type: "file" }] }));
  await delay(30);
  assert.equal(uploads, 0);
  assert.equal(mounts, 0);
  assert.match(prompt, /以下是用户发送的纯文本文件原文/);
  assert.match(prompt, /# 计划\n\n- 第一项\n- 第二项/);
  store.close();
});
