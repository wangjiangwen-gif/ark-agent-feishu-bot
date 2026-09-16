import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Gateway, resultToReply, shouldHandleMessage, toConversationKey, type IncomingMessage } from "../src/gateway.ts";
import { GatewayStore } from "../src/store.ts";
import { baselineCompaction } from "../src/session-compaction.ts";

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

const withoutAttachmentNamespace = (value: string) => value.replace(/\/mnt\/data\/[a-f0-9]{24}\//g, "/mnt/data/");

function requestText(input: string): string {
  if (input === "/compact") return input;
  assert.match(input, /<current_actor open_id="/);
  const request = input.match(/<current_request>\n([\s\S]*?)\n<\/current_request>/);
  assert.ok(request, "业务请求应包含完整的逐轮上下文结构");
  return request[1];
}

test("group messages require an explicit bot mention", () => {
  assert.equal(shouldHandleMessage(message({ conversationType: "group", mentionedBot: false })), false);
  assert.equal(shouldHandleMessage(message({ conversationType: "group", mentionedBot: true })), true);
});

test("shared group conversations ignore sender but keep threads isolated", () => {
  const first = message({ conversationType: "group", mentionedBot: true, senderId: "ou-user-1" });
  const second = message({ conversationType: "group", mentionedBot: true, senderId: "ou-user-2" });
  const thread = message({ conversationType: "group", mentionedBot: true, senderId: "ou-user-2", threadId: "omt-one" });
  const store = new GatewayStore(":memory:");
  assert.notEqual(store.conversationKey(toConversationKey(first)), store.conversationKey(toConversationKey(second)));
  assert.equal(store.conversationKey(toConversationKey(first, true)), store.conversationKey(toConversationKey(second, true)));
  assert.notEqual(store.conversationKey(toConversationKey(first, true)), store.conversationKey(toConversationKey(thread, true)));
  store.close();
});

test("shared group mode queues users in one Session and never mounts user Vaults", async () => {
  const store = new GatewayStore(":memory:");
  const started: string[] = [];
  const vaultLists: string[][] = [];
  const reactions: string[] = [];
  let creates = 0;
  let releaseFirst: (() => void) | undefined;
  const gateway = new Gateway(store, {
    createSession: async request => {
      vaultLists.push(request.vault_ids || []);
      return `session-${++creates}`;
    },
    run: async (sessionId, input) => {
      started.push(`${sessionId}:${requestText(input)}`);
      if (requestText(input) === "群任务 A") await new Promise<void>(resolve => { releaseFirst = resolve; });
      return { terminal: "idle" as const, messages: [`${input} 完成`] };
    }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, sharedGroupSessions: true,
    getUserVaultIds: async () => ["vlt-user"],
    addReaction: async (incoming, emoji) => {
      reactions.push(`add:${incoming.messageId}:${emoji}`);
      return `${emoji.toLowerCase()}-${incoming.messageId}`;
    },
    removeReaction: async (incoming, reactionId) => { reactions.push(`remove:${incoming.messageId}:${reactionId}`); }
  });

  gateway.accept(message({
    eventId: "event-a", messageId: "message-a", conversationType: "group", mentionedBot: true,
    senderId: "ou-a", text: "群任务 A"
  }));
  gateway.accept(message({
    eventId: "event-b", messageId: "message-b", conversationType: "group", mentionedBot: true,
    senderId: "ou-b", text: "群任务 B"
  }));
  await delay(20);

  assert.deepEqual(started, ["session-1:群任务 A"]);
  assert.deepEqual([...reactions].sort(), ["add:message-a:Get", "add:message-b:OnIt"].sort());
  releaseFirst?.();
  await delay(30);
  assert.deepEqual(started, ["session-1:群任务 A", "session-1:群任务 B"]);
  assert.deepEqual(vaultLists, [["vlt-bot"]]);
  assert.equal(creates, 1);
  assert.equal(reactions.length, 6);
  assert.ok(reactions.indexOf("add:message-b:OnIt") < reactions.indexOf("remove:message-b:onit-message-b"));
  assert.ok(reactions.indexOf("remove:message-b:onit-message-b") < reactions.indexOf("add:message-b:Get"));
  assert.ok(reactions.indexOf("add:message-b:Get") < reactions.indexOf("remove:message-b:get-message-b"));
  store.close();
});

test("shared group mode gives each thread its own reusable Session", async () => {
  const store = new GatewayStore(":memory:");
  let creates = 0;
  const runs: string[] = [];
  const emojis: string[] = [];
  const gateway = new Gateway(store, {
    createSession: async () => `session-${++creates}`,
    run: async (sessionId, input) => {
      runs.push(`${sessionId}:${requestText(input)}`);
      return { terminal: "idle" as const, messages: ["完成"] };
    }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, sharedGroupSessions: true,
    addReaction: async (_incoming, emoji) => { emojis.push(emoji); return `reaction-${emojis.length}`; },
    removeReaction: async () => undefined
  });

  gateway.accept(message({ eventId: "event-a", messageId: "message-a", conversationType: "group", mentionedBot: true, threadId: "omt-a", senderId: "ou-a", text: "A1" }));
  gateway.accept(message({ eventId: "event-b", messageId: "message-b", conversationType: "group", mentionedBot: true, threadId: "omt-b", senderId: "ou-b", text: "B1" }));
  await delay(30);
  assert.equal(emojis.includes("OnIt"), false);
  gateway.accept(message({ eventId: "event-c", messageId: "message-c", conversationType: "group", mentionedBot: true, threadId: "omt-a", senderId: "ou-c", text: "A2" }));
  await delay(30);

  assert.equal(creates, 2);
  assert.deepEqual(runs, ["session-1:A1", "session-2:B1", "session-1:A2"]);
  store.close();
});

test("queued group requests still execute when the OnIt reaction fails", async () => {
  const store = new GatewayStore(":memory:");
  const started: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const gateway = new Gateway(store, {
    createSession: async () => "session-group",
    run: async (_sessionId, input) => {
      started.push(requestText(input));
      if (requestText(input) === "A") await new Promise<void>(resolve => { releaseFirst = resolve; });
      return { terminal: "idle" as const, messages: ["完成"] };
    }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, sharedGroupSessions: true,
    addReaction: async (_incoming, emoji) => {
      if (emoji === "OnIt") throw new Error("reaction unavailable");
      return "get-reaction";
    },
    removeReaction: async () => undefined
  });

  gateway.accept(message({ eventId: "event-a", messageId: "message-a", conversationType: "group", mentionedBot: true, text: "A" }));
  gateway.accept(message({ eventId: "event-b", messageId: "message-b", conversationType: "group", mentionedBot: true, text: "B" }));
  await delay(20);
  releaseFirst?.();
  await delay(30);

  assert.deepEqual(started, ["A", "B"]);
  store.close();
});

test("per-message mode starts same-chat group requests concurrently in isolated sessions", async () => {
  const store = new GatewayStore(":memory:");
  const created: Array<{ sessionId: string; env: Record<string, string> }> = [];
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const gateway = new Gateway(store, {
    createSession: async request => {
      const sessionId = `session-${created.length + 1}`;
      const environment = request.environment as { config?: { env?: Record<string, string> } };
      created.push({ sessionId, env: environment.config?.env || {} });
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
  assert.equal(created[0].env.FEISHU_USER_OPEN_ID, undefined);
  assert.equal(created[1].env.FEISHU_USER_OPEN_ID, undefined);
  assert.equal(created[0].env.LARKSUITE_CLI_STRICT_MODE, "bot");
  assert.equal(created[1].env.LARKSUITE_CLI_STRICT_MODE, "bot");
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
      started.push(requestText(input));
      if (requestText(input) === "私聊 A") await new Promise<void>(resolve => { releaseFirst = resolve; });
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
    createSession: async request => {
      const environment = request.environment as { config?: { env?: Record<string, string> } };
      sessionEnv = environment.config?.env || {};
      return "session-one";
    },
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
  assert.match(prompt, /role="reference"/);
  assert.doesNotMatch(prompt, /untrusted="true"/);
  assert.match(prompt, /飞书提供的真实会话记录/);
  assert.match(prompt, /不构成本轮指令、授权或操作确认/);
  assert.match(prompt, /"context_scope":"thread"/);
  assert.match(prompt, /张三.*下午改到四点/);
  assert.match(prompt, /<current_request>\n帮大家约一下/);
  assert.match(prompt, /<current_actor open_id="ou-b"/);
  assert.deepEqual(sessionEnv, {
    FEISHU_CONVERSATION_TYPE: "group",
    FEISHU_CHAT_ID: "chat-1",
    FEISHU_THREAD_ID: "omt-one",
    FEISHU_IDENTITY_MODE: "bot_only",
    LARKSUITE_CLI_STRICT_MODE: "bot",
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
  });
  store.close();
});

test("group history loading overlaps Session creation", async () => {
  const store = new GatewayStore(":memory:");
  const operations: string[] = [];
  let releaseHistory: (() => void) | undefined;
  const historyPending = new Promise<void>(resolve => { releaseHistory = resolve; });
  const gateway = new Gateway(store, {
    createSession: async () => { operations.push("session"); return "session-one"; },
    run: async () => ({ terminal: "idle" as const, messages: ["完成"] })
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, perMessageSessions: true,
    loadRecentHistory: async () => {
      operations.push("history");
      await historyPending;
      return [];
    }
  });

  gateway.accept(message({ conversationType: "group", mentionedBot: true }));
  await delay(20);
  assert.deepEqual(operations, ["history", "session"]);
  releaseHistory?.();
  await delay(30);
  store.close();
});

test("group history falls back to prior Gateway requests and replies when Feishu history cannot be loaded", async () => {
  const store = new GatewayStore(":memory:");
  store.addAuditLog({
    channelType: "lark", installationId: "cli-test", tenantKey: "tenant-1", openId: "ou-a",
    chatId: "chat-1", messageId: "history-message", action: "message", status: "succeeded",
    summary: "读取文档 https://example.com/wiki/one", responseSummary: "文档标题是测试方案",
    messageCreateTime: Date.now()
  });
  let prompt = "";
  const gateway = new Gateway(store, {
    createSession: async () => "session-one",
    run: async (_sessionId, input) => { prompt = input; return { terminal: "idle" as const, messages: ["完成"] }; }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, perMessageSessions: true,
    loadRecentHistory: async () => { throw new Error("missing scope"); }
  });

  gateway.accept(message({ conversationType: "group", mentionedBot: true, text: "你用的什么凭证", createTime: Date.now() + 10_000 }));
  await delay(30);

  assert.match(prompt, /读取文档 https:\/\/example\.com\/wiki\/one/);
  assert.match(prompt, /文档标题是测试方案/);
  assert.match(prompt, /<current_request>\n你用的什么凭证/);
  assert.equal(store.listAuditLogs()[0].status, "succeeded");
  store.close();
});

test("shared group Session injects a full snapshot once and only new group messages afterwards", async () => {
  const store = new GatewayStore(":memory:");
  const prompts: string[] = [];
  let history = [
    { messageId: "before-first", senderId: "ou-a", senderType: "user" as const, source: "chat" as const, text: "第一次请求前的背景", createTime: 100 }
  ];
  const gateway = new Gateway(store, {
    createSession: async () => "session-group",
    run: async (_sessionId, input) => { prompts.push(input); return { terminal: "idle" as const, messages: ["完成"] }; }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, sharedGroupSessions: true,
    loadRecentHistory: async () => history
  });

  gateway.accept(message({
    eventId: "event-a", messageId: "message-a", conversationType: "group", mentionedBot: true,
    senderId: "ou-a", text: "第一次请求", createTime: 200
  }));
  await delay(30);

  history = [
    ...history,
    { messageId: "between", senderId: "ou-b", senderType: "user" as const, source: "chat" as const, text: "两次请求之间的新消息", createTime: 250 }
  ];
  gateway.accept(message({
    eventId: "event-b", messageId: "message-b", conversationType: "group", mentionedBot: true,
    senderId: "ou-b", text: "第二次请求", createTime: 300
  }));
  await delay(30);

  assert.match(prompts[0], /第一次请求前的背景/);
  assert.match(prompts[0], /<current_request>\n第一次请求/);
  assert.doesNotMatch(prompts[1], /第一次请求前的背景/);
  assert.match(prompts[1], /两次请求之间的新消息/);
  assert.match(prompts[1], /<current_request>\n第二次请求/);
  store.close();
});

test("next group mention automatically mounts an attachment from an earlier unmentioned message", async () => {
  const store = new GatewayStore(":memory:");
  const operations: string[] = [];
  let prompt = "";
  const gateway = new Gateway(store, {
    createSession: async () => { operations.push("create"); return "session-group"; },
    uploadFile: async (name, mimeType, bytes) => {
      operations.push(`upload:${name}:${mimeType}:${bytes.byteLength}`);
      return { id: "ark-file-1", name };
    },
    addSessionResource: async (sessionId, resource) => {
      operations.push(`mount:${sessionId}:${JSON.stringify(resource)}`);
    },
    run: async (_sessionId, input) => {
      prompt = input;
      operations.push("run");
      return { terminal: "idle" as const, messages: ["已总结"] };
    }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, sharedGroupSessions: true,
    loadRecentHistory: async () => [{
      messageId: "om-unmentioned-file", senderId: "ou-a", senderName: "张三", senderType: "user",
      source: "chat", text: "[文件：会议材料.pdf]", createTime: 1_699_999_999_000,
      resources: [{ id: "file-v3-old", name: "会议材料.pdf", type: "file" }]
    }],
    downloadAttachment: async (attachment, sourceMessage) => {
      operations.push(`download:${sourceMessage.messageId}:${attachment.id}`);
      return { bytes: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" };
    }
  });

  gateway.accept(message({
    eventId: "evt-trigger", messageId: "om-trigger", conversationType: "group", mentionedBot: true,
    senderId: "ou-b", text: "请总结刚才上传的文件", createTime: 1_700_000_000_000
  }));
  await delay(50);

  assert.deepEqual(operations.map(withoutAttachmentNamespace), [
    "create",
    "download:om-unmentioned-file:file-v3-old",
    "upload:会议材料.pdf:application/pdf:3",
    'mount:session-group:{"type":"file","file_id":"ark-file-1","mount_path":"/mnt/data/会议材料.pdf"}',
    "run"
  ]);
  assert.match(prompt, /会议材料\.pdf/);
  assert.match(prompt, /\/mnt\/session\/uploads\/mnt\/data\/[a-f0-9]{24}\/会议材料\.pdf/);
  assert.match(prompt, /<current_request>\n请总结刚才上传的文件/);
  store.close();
});

test("shared group context cursor survives a Gateway restart", async () => {
  const store = new GatewayStore(":memory:");
  const firstPrompts: string[] = [];
  const history = [
    { messageId: "old", senderId: "ou-a", senderType: "user" as const, source: "chat" as const, text: "旧背景不应重复", createTime: 100 },
    { messageId: "new", senderId: "ou-b", senderType: "user" as const, source: "chat" as const, text: "重启后的新增消息", createTime: 250 }
  ];
  const createGateway = (prompts: string[]) => new Gateway(store, {
    createSession: async () => "session-group",
    run: async (_sessionId, input) => { prompts.push(input); return { terminal: "idle" as const, messages: ["完成"] }; }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, sharedGroupSessions: true,
    loadRecentHistory: async () => history
  });

  createGateway(firstPrompts).accept(message({
    eventId: "event-a", messageId: "message-a", conversationType: "group", mentionedBot: true,
    text: "第一次请求", createTime: 200
  }));
  await delay(30);

  const restartedPrompts: string[] = [];
  createGateway(restartedPrompts).accept(message({
    eventId: "event-b", messageId: "message-b", conversationType: "group", mentionedBot: true,
    text: "重启后请求", createTime: 300
  }));
  await delay(30);

  assert.doesNotMatch(restartedPrompts[0], /旧背景不应重复/);
  assert.match(restartedPrompts[0], /重启后的新增消息/);
  store.close();
});

test("successful group execution records the final reply for later context fallback", async () => {
  const store = new GatewayStore(":memory:");
  const gateway = new Gateway(store, {
    createSession: async () => "session-one",
    run: async () => ({ terminal: "idle" as const, messages: ["最终业务回复"] })
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, perMessageSessions: true
  });

  gateway.accept(message({ conversationType: "group", mentionedBot: true, text: "读取这个文档" }));
  await delay(30);

  assert.equal(store.listAuditLogs()[0].responseSummary, "最终业务回复");
  store.close();
});

test("legacy per-message employee group mode cannot bypass Bot-only OAuth restrictions", async () => {
  const store = new GatewayStore(":memory:");
  const replies: string[] = [];
  let creates = 0;
  let runs = 0;
  let authorizationCalls = 0;
  const gateway = new Gateway(store, {
    createSession: async () => `session-${++creates}`,
    run: async () => ++runs === 1 ? {
      terminal: "idle" as const, messages: ["没有用户凭证"],
      authorizationRequired: { identity: "user" as const, errorType: "authentication" as const, subtype: "token_missing" as const, domain: "calendar" }
    } : { terminal: "idle" as const, messages: ["今天没有日程"] }
  }, collectText(replies), {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, perMessageSessions: true,
    ensureAuthorization: async (_message, request) => { authorizationCalls++; assert.equal(request.domain, "calendar"); return true; }
  });

  gateway.accept(message({ conversationType: "group", mentionedBot: true, text: "看看今天的安排" }));
  await delay(80);

  assert.equal(authorizationCalls, 0);
  assert.equal(creates, 1);
  assert.equal(runs, 1);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /群聊场景仅使用 Bot 身份/);
  assert.equal(store.listAuditLogs().some(item => item.action === "authorization_required"), false);
  store.close();
});

test("shared group mode never starts user OAuth when the Agent requests UAT", async () => {
  const store = new GatewayStore(":memory:");
  const replies: string[] = [];
  let authorizationCalls = 0;
  const gateway = new Gateway(store, {
    createSession: async () => "session-group",
    run: async () => ({
      terminal: "idle" as const, messages: ["缺少用户凭证"],
      authorizationRequired: { identity: "user" as const, errorType: "authentication" as const, subtype: "token_missing" as const, domain: "calendar" }
    })
  }, collectText(replies), {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, sharedGroupSessions: true,
    ensureAuthorization: async () => { authorizationCalls++; return true; }
  });

  gateway.accept(message({ conversationType: "group", mentionedBot: true, text: "查询我的私人日程" }));
  await delay(40);

  assert.equal(authorizationCalls, 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /群聊场景仅使用 Bot 身份/);
  store.close();
});

test("repeated token_missing stops after one automatic authorization retry", async () => {
  const store = new GatewayStore(":memory:");
  const replies: string[] = [];
  const gateway = new Gateway(store, {
    createSession: async () => "session",
    run: async () => ({
      terminal: "idle" as const, messages: ["没有用户凭证"],
      authorizationRequired: { identity: "user" as const, errorType: "authentication" as const, subtype: "token_missing" as const, domain: "calendar" }
    })
  }, collectText(replies), {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, getUserVaultIds: async () => ["vlt-user"], ensureAuthorization: async () => true
  });

  gateway.accept(message({ text: "查询日程" }));
  await delay(80);

  assert.equal(replies.length, 1);
  assert.match(replies[0], /授权后仍未获得用户凭证/);
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

test("gateway avoids processing text for fast requests, deduplicates, and reuses a session", async () => {
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
  assert.deepEqual(replies, ["回复", "回复"]);
  store.close();
});

test("gateway creates a session bound to the user Vault", async () => {
  const store = new GatewayStore(":memory:");
  let sessionAgentId = "";
  let sessionEnvironmentId = "";
  let sessionVaultIds: string[] | undefined;
  let sessionEnv: Record<string, string> | undefined;
  const gateway = new Gateway(store, {
    createSession: async request => {
      const environment = request.environment as { id?: string; config?: { env?: Record<string, string> } };
      sessionAgentId = String(request.agent);
      sessionEnvironmentId = environment.id || String(request.environment_id || "");
      sessionVaultIds = request.vault_ids;
      sessionEnv = environment.config?.env;
      return "session-1";
    },
    run: async () => ({ terminal: "idle" as const, messages: ["完成"] })
  }, async () => undefined, { agentId: "agent-user-owned", environmentId: "env-user-owned", vaultId: "vlt-1", authorizedUserId: "ou-current-user", timeoutMs: 5_000 });
  gateway.accept(message({ senderId: "ou-current-user" }));
  await delay(30);
  assert.equal(sessionAgentId, "agent-user-owned");
  assert.equal(sessionEnvironmentId, "env-user-owned");
  assert.deepEqual(sessionVaultIds, ["vlt-1"]);
  assert.deepEqual(sessionEnv, {
    FEISHU_USER_OPEN_ID: "ou-current-user",
    FEISHU_CONVERSATION_TYPE: "direct",
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
  });
  store.close();
});

test("gateway hands off the old session before resuming in a user-authorized session", async () => {
  const store = new GatewayStore(":memory:");
  const key = toConversationKey(message());
  store.saveSession(key, "session-old", "agent-1");
  const operations: string[] = [];
  let resumedInput = "";
  let sessionVaultIds: string[] = [];
  const gateway = new Gateway(store, {
    createSession: async request => {
      operations.push("create:session-new");
      sessionVaultIds = request.vault_ids || [];
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
  const handoffLog = store.listAuditLogs().find(log => log.action === "session_handoff");
  assert.equal(handoffLog?.status, "succeeded");
  assert.match(handoffLog?.summary || "", /agent_summary/);
  store.close();
});

test("authorization resumes a Session in place when its user Vault was mounted at creation", async () => {
  const store = new GatewayStore(":memory:");
  const incoming = message({ text: "查询今天日程" });
  const key = toConversationKey(incoming);
  store.saveSession(key, "session-current", "agent-1", undefined, ["vlt-bot", "vlt-user"]);
  store.startAuthorizationRecovery(incoming, "session-current");
  const runs: string[] = [];
  let creates = 0;
  const gateway = new Gateway(store, {
    createSession: async () => { creates++; return "session-new"; },
    run: async sessionId => {
      runs.push(sessionId);
      return { terminal: "idle" as const, messages: ["今天没有日程"] };
    }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true
  });

  gateway.resumeAfterAuthorization(incoming, "vlt-user");
  await delay(30);

  assert.deepEqual(runs, ["session-current"]);
  assert.equal(creates, 0);
  assert.equal(store.getSession(key), "session-current");
  assert.equal(store.listAuditLogs().some(log => log.action === "session_handoff"), false);
  store.close();
});

test("authorization asks before replacing a legacy Session without Vault metadata", async () => {
  const store = new GatewayStore(":memory:");
  const incoming = message({ text: "查询今天日程" });
  const key = toConversationKey(incoming);
  store.saveSession(key, "session-legacy", "agent-1");
  store.startAuthorizationRecovery(incoming, "session-legacy");
  const runs: string[] = [];
  const replies: string[] = [];
  let creates = 0;
  const gateway = new Gateway(store, {
    createSession: async () => { creates++; return "session-upgraded"; },
    run: async (sessionId, input) => {
      runs.push(sessionId);
      return sessionId === "session-legacy"
        ? { terminal: "idle" as const, messages: ["用户要查询今天日程"] }
        : { terminal: "idle" as const, messages: [input] };
    }
  }, collectText(replies), {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-bot", timeoutMs: 5_000,
    platformAccess: true, getUserVaultIds: async () => ["vlt-user"]
  });

  gateway.resumeAfterAuthorization(incoming, "vlt-user");
  await delay(40);

  assert.deepEqual(runs, []);
  assert.equal(creates, 0);
  assert.equal(store.getSession(key), "session-legacy");
  assert.equal(store.getSessionVaultIds(key), undefined);
  assert.equal(store.listAuditLogs().some(log => log.action === "session_handoff"), false);
  assert.match(replies[0], /未挂载对应用户 Vault/);
  assert.match(replies[0], /旧文件不会迁移/);
  store.close();
});

test("gateway falls back to local audit context when OAuth handoff summarization fails", async () => {
  const store = new GatewayStore(":memory:");
  const key = toConversationKey(message());
  store.saveSession(key, "session-old", "agent-1");
  store.addAuditLog({
    channelType: "lark", installationId: "cli-test", tenantKey: "tenant-1", openId: "user-1",
    chatId: "chat-1", messageId: "message-before", sessionId: "session-old", action: "message", status: "succeeded",
    summary: "用户要安排项目复盘", responseSummary: "已确认参会人是张三和李四", messageCreateTime: 1_699_999_999_000
  });
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

  assert.match(resumedInput, /source: gateway_audit/);
  assert.match(resumedInput, /用户要安排项目复盘/);
  assert.match(resumedInput, /已确认参会人是张三和李四/);
  assert.match(resumedInput, /继续创建日程/);
  assert.equal(store.getSession(key), "session-new");
  const handoffLog = store.listAuditLogs().find(log => log.action === "session_handoff");
  assert.equal(handoffLog?.status, "succeeded");
  assert.match(handoffLog?.summary || "", /gateway_audit/);
  store.close();
});

test("automatic compaction keeps using the same Session when compact fails", async () => {
  const store = new GatewayStore(":memory:");
  const key = toConversationKey(message());
  store.saveSession(key, "session-old", "agent-1");
  store.saveCompactionCheckpoint("session-old", baselineCompaction({ eventCount: 0 }));
  const operations: string[] = [];
  let creates = 0;
  const gateway = new Gateway(store, {
    getSessionStats: async () => ({ eventCount: 200, latestInputTokens: 30_000, latestTokenSampleId: "model", latestBusinessEventId: "user", latestEventId: "idle", status: "idle" }),
    inspectCompaction: async () => ({ result: "failed", terminal: "failed", reason: "session_error" }),
    createSession: async () => { creates++; return "session-new"; },
    run: async (sessionId, input) => {
      operations.push(`${sessionId}:${requestText(input)}`);
      if (input === "/compact") throw new Error("compact timeout");
      return { terminal: "idle" as const, messages: ["继续使用旧会话"] };
    }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000
  });

  gateway.accept(message({ text: "继续当前任务" }));
  await delay(40);

  assert.equal(creates, 0);
  assert.deepEqual(operations, ["session-old:/compact", "session-old:继续当前任务"]);
  assert.equal(store.getSession(key), "session-old");
  const compactLog = store.listAuditLogs().find(log => log.action === "session_compact");
  assert.equal(compactLog?.status, "failed");
  store.close();
});

test("gateway automatically compacts an oversized Session in place", async () => {
  const store = new GatewayStore(":memory:");
  const key = toConversationKey(message());
  store.saveSession(key, "session-old", "agent-1");
  store.saveCompactionCheckpoint("session-old", baselineCompaction({ eventCount: 0 }));
  const operations: string[] = [];
  let creates = 0;
  const gateway = new Gateway(store, {
    getSessionStats: async sessionId => {
      operations.push(`stats:${sessionId}`);
      return { eventCount: 196, latestInputTokens: 27_611, latestTokenSampleId: "model", latestBusinessEventId: "user", latestEventId: "idle", status: "idle" };
    },
    inspectCompaction: async () => ({ result: "succeeded", terminal: "idle", reason: "test_adapter_verified_completion" }),
    createSession: async () => {
      creates++;
      return "session-new";
    },
    run: async (sessionId, input) => {
      operations.push(`run:${sessionId}:${requestText(input)}`);
      return { terminal: "idle" as const, messages: ["完成"] };
    }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000
  });

  gateway.accept(message({ text: "继续" }));
  await delay(40);

  assert.deepEqual(operations, ["stats:session-old", "run:session-old:/compact", "stats:session-old", "run:session-old:继续"]);
  assert.equal(creates, 0);
  assert.equal(store.getSession(key), "session-old");
  const compactLog = store.listAuditLogs().find(log => log.action === "session_compact");
  assert.equal(compactLog?.status, "succeeded");
  store.close();
});

test("gateway reuses a Session below the compaction threshold", async () => {
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

test("gateway does not compact the same event range repeatedly", async () => {
  const store = new GatewayStore(":memory:");
  const key = toConversationKey(message());
  store.saveSession(key, "session-current", "agent-1");
  store.saveCompactionCheckpoint("session-current", baselineCompaction({ eventCount: 0 }));
  const inputs: string[] = [];
  const gateway = new Gateway(store, {
    getSessionStats: async () => ({ eventCount: 196, latestInputTokens: 1_000, latestTokenSampleId: "model", latestBusinessEventId: "user", latestEventId: "idle", status: "idle" }),
    inspectCompaction: async () => ({ result: "succeeded", terminal: "idle", reason: "test_adapter_verified_completion" }),
    createSession: async () => "session-new",
    run: async (_sessionId, input) => {
      inputs.push(requestText(input));
      return { terminal: "idle" as const, messages: ["完成"] };
    }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1",
    timeoutMs: 5_000, sessionStatsCheckIntervalMs: 0
  });

  gateway.accept(message({ messageId: "message-compact-1", text: "任务一" }));
  await delay(30);
  gateway.accept(message({ messageId: "message-compact-2", text: "任务二" }));
  await delay(30);

  assert.deepEqual(inputs, ["/compact", "任务一", "任务二"]);
  assert.equal(store.getSession(key), "session-current");
  store.close();
});

test("manual compact runs the Managed Agents command in the current Session", async () => {
  const store = new GatewayStore(":memory:");
  const key = toConversationKey(message());
  store.saveSession(key, "session-current", "agent-1");
  const operations: string[] = [];
  const replies: string[] = [];
  const gateway = new Gateway(store, {
    getSessionStats: async () => ({ eventCount: 10, latestEventId: "idle", status: "idle" }),
    inspectCompaction: async () => ({ result: "succeeded", terminal: "idle", reason: "test_adapter_verified_completion" }),
    createSession: async () => "session-new",
    run: async (sessionId, input) => {
      operations.push(`${sessionId}:${input}`);
      return { terminal: "idle" as const, messages: [] };
    }
  }, async (_message, outbound) => { if (outbound.type === "text") replies.push(outbound.text); }, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000
  });

  gateway.accept(message({ text: "/compact" }));
  await delay(30);

  assert.deepEqual(operations, ["session-current:/compact"]);
  assert.deepEqual(replies, ["当前 Agent Session 已完成上下文压缩。"]);
  assert.equal(store.getSession(key), "session-current");
  store.close();
});

test("slow sessions receive one delayed processing reply without a startup message", async () => {
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
    "回复",
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

test("gateway uploads a Feishu file and mounts it while creating a new Session", async () => {
  const store = new GatewayStore(":memory:");
  const operations: string[] = [];
  let prompt = "";
  const gateway = new Gateway(store, {
    createSession: async request => {
      operations.push(`session:${JSON.stringify(request.resources || [])}`);
      return "session-1";
    },
    uploadFile: async (name, mimeType, bytes) => {
      operations.push(`upload:${name}:${mimeType}:${bytes.byteLength}`);
      return { id: "file-1", name };
    },
    run: async (_sessionId, text) => { prompt = text; operations.push("run"); return { terminal: "idle" as const, messages: ["文件摘要"] }; }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000,
    downloadAttachment: async attachment => ({ bytes: new Uint8Array([1, 2]), mimeType: attachment.type === "image" ? "image/jpeg" : "application/pdf" })
  });
  gateway.accept(message({ text: "", resources: [{ id: "file-key", name: "季度计划.pdf", type: "file" }] }));
  await delay(30);
  assert.deepEqual(operations.map(withoutAttachmentNamespace), [
    "upload:季度计划.pdf:application/pdf:2",
    'session:[{"type":"file","file_id":"file-1","mount_path":"/mnt/data/季度计划.pdf"}]',
    "run"
  ]);
  assert.match(prompt, /文件已挂载到：\n- \/mnt\/session\/uploads\/mnt\/data\/[a-f0-9]{24}\/季度计划\.pdf/);
  store.close();
});

test("gateway lets a Session builder preserve native options and adds initial attachment resources", async () => {
  const store = new GatewayStore(":memory:");
  const operations: string[] = [];
  let createRequest: Record<string, unknown> = {};
  const gateway = new Gateway(store, {
    buildSessionCreateRequest: async defaults => ({
      agent: defaults.agentId,
      environment_id: defaults.environmentId,
      vault_ids: defaults.vaultIds
    }),
    createSession: async request => {
      createRequest = request;
      operations.push("session");
      return "session-1";
    },
    uploadFile: async (name, _mimeType, _bytes) => {
      operations.push(`upload:${name}`);
      return { id: "file-1", name };
    },
    run: async () => {
      operations.push("run");
      return { terminal: "idle" as const, messages: ["完成"] };
    }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000,
    downloadAttachment: async () => ({ bytes: new Uint8Array([1, 2]), mimeType: "application/pdf" }),
    buildSessionRequest: async (_message, draft) => ({
      ...draft,
      agent: { id: "agent-1", type: "agent", version: 3 },
      title: "开发者标题",
      tags: [{ key: "source", value: "lark" }],
      resources: [
        { type: "memory_store", memory_store_id: "mem-1", access: "read_write" },
        { type: "tos", tos_bucket: "bucket-1", tos_key: "seed/context/", mount_path: "/mnt/data/context" },
        ...(draft.resources || [])
      ],
      future_session_field: "kept"
    })
  });

  gateway.accept(message({ text: "总结附件", resources: [{ id: "file-key", name: "报告.pdf", type: "file" }] }));
  await delay(40);

  assert.deepEqual(operations, ["upload:报告.pdf", "session", "run"]);
  assert.deepEqual(createRequest.agent, { id: "agent-1", type: "agent", version: 3 });
  assert.equal(createRequest.title, "开发者标题");
  assert.equal(createRequest.future_session_field, "kept");
  assert.deepEqual(JSON.parse(withoutAttachmentNamespace(JSON.stringify(createRequest.resources))), [
    { type: "memory_store", memory_store_id: "mem-1", access: "read_write" },
    { type: "tos", tos_bucket: "bucket-1", tos_key: "seed/context/", mount_path: "/mnt/data/context" },
    { type: "file", file_id: "file-1", mount_path: "/mnt/data/报告.pdf" }
  ]);
  store.close();
});

test("gateway appends a generic resource when an existing Session receives a file", async () => {
  const store = new GatewayStore(":memory:");
  const incoming = message({ text: "继续分析", resources: [{ id: "file-key", name: "补充.pdf", type: "file" }] });
  store.saveSession(toConversationKey(incoming), "session-existing", "agent-1");
  const operations: string[] = [];
  const gateway = new Gateway(store, {
    createSession: async () => { throw new Error("不应创建新 Session"); },
    uploadFile: async name => {
      operations.push(`upload:${name}`);
      return { id: "file-2", name };
    },
    addSessionResource: async (sessionId, resource) => {
      operations.push(`append:${sessionId}:${JSON.stringify(resource)}`);
    },
    run: async sessionId => {
      operations.push(`run:${sessionId}`);
      return { terminal: "idle" as const, messages: ["完成"] };
    }
  }, async () => undefined, {
    agentId: "agent-1", environmentId: "env-1", vaultId: "vlt-1", authorizedUserId: "user-1", timeoutMs: 5_000,
    sessionRotation: false,
    downloadAttachment: async () => ({ bytes: new Uint8Array([1]), mimeType: "application/pdf" })
  });

  gateway.accept(incoming);
  await delay(40);

  assert.deepEqual(operations.map(withoutAttachmentNamespace), [
    "upload:补充.pdf",
    'append:session-existing:{"type":"file","file_id":"file-2","mount_path":"/mnt/data/补充.pdf"}',
    "run:session-existing"
  ]);
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
