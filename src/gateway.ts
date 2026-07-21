import type { ArkClient, RunResult } from "./ark.ts";
import type { ConversationKey, GatewayStore } from "./store.ts";

export type IncomingMessage = {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  threadId: string;
  userOpenId: string;
  tenantKey: string;
  text: string;
  mentionedBot: boolean;
};

export type Reply = (chatId: string, text: string) => Promise<void>;

export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();

  enqueue(key: string, task: () => Promise<void>): void {
    const previous = this.tails.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(task).finally(() => {
      if (this.tails.get(key) === current) this.tails.delete(key);
    });
    this.tails.set(key, current);
  }
}

export class Gateway {
  private queue = new KeyedQueue();
  private store: GatewayStore;
  private ark: Pick<ArkClient, "createSession" | "run">;
  private reply: Reply;
  private options: { agentId: string; environmentId: string; vaultId: string; authorizedUserOpenId: string; timeoutMs: number; progressDelayMs?: number; beforeCreateSession?: () => Promise<void> };

  constructor(
    store: GatewayStore,
    ark: Pick<ArkClient, "createSession" | "run">,
    reply: Reply,
    options: { agentId: string; environmentId: string; vaultId: string; authorizedUserOpenId: string; timeoutMs: number; progressDelayMs?: number; beforeCreateSession?: () => Promise<void> }
  ) {
    this.store = store;
    this.ark = ark;
    this.reply = reply;
    this.options = options;
  }

  accept(message: IncomingMessage): boolean {
    if (!shouldHandleMessage(message)) return false;
    if (!this.store.claimEvent(message.eventId)) return false;
    const key = toConversationKey(message);
    this.queue.enqueue(this.store.conversationKey(key), async () => {
      try {
        await this.process(message, key);
        this.store.completeEvent(message.eventId, "completed");
      } catch (error) {
        this.store.completeEvent(message.eventId, "failed");
        const reason = error instanceof Error ? error.message : String(error);
        await this.reply(message.chatId, `执行失败：${reason.slice(0, 240)}`);
      }
    });
    return true;
  }

  private async process(message: IncomingMessage, key: ConversationKey): Promise<void> {
    if (message.userOpenId !== this.options.authorizedUserOpenId) {
      await this.reply(message.chatId, "当前用户未授权。这个版本仅支持 init 时扫码授权的用户，请由该用户私聊或重新运行 init。");
      return;
    }
    await this.options.beforeCreateSession?.();
    if (message.text.trim() === "/new") {
      this.store.resetSession(key);
      await this.reply(message.chatId, "已开启新会话，下一条消息会创建新的 Agent Session。");
      return;
    }
    let sessionId = this.store.getSession(key);
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    let progressReply: Promise<void> | undefined;
    if (!sessionId) {
      await this.reply(message.chatId, "已收到，正在处理。首次启动可能需要几分钟。");
      sessionId = await this.ark.createSession(this.options.agentId, this.options.environmentId, [this.options.vaultId]);
      this.store.saveSession(key, sessionId, this.options.agentId);
    } else {
      progressTimer = setTimeout(() => {
        progressReply = this.reply(message.chatId, "已收到，正在处理，请稍候。").catch(error => {
          console.warn("发送处理中提示失败：", error instanceof Error ? error.message : error);
        });
      }, this.options.progressDelayMs ?? 2_500);
    }
    try {
      // 过程事件仍由 ArkClient 消费，但不传 onProgress，避免把 tool_use/tool_result
      // 转成“执行进度：xxx”消息刷屏。
      const result = await this.ark.run(sessionId, message.text, this.options.timeoutMs);
      if (progressTimer) clearTimeout(progressTimer);
      await progressReply;
      await this.reply(message.chatId, resultToReply(result));
    } finally {
      if (progressTimer) clearTimeout(progressTimer);
    }
  }
}

export function shouldHandleMessage(message: IncomingMessage): boolean {
  if (!message.text.trim()) return false;
  return message.chatType === "p2p" || message.mentionedBot;
}

export function toConversationKey(message: IncomingMessage): ConversationKey {
  return {
    tenantKey: message.tenantKey,
    chatId: message.chatId,
    threadId: message.threadId,
    userOpenId: message.chatType === "p2p" ? message.userOpenId : ""
  };
}

export function resultToReply(result: RunResult): string {
  if (result.terminal === "failed") throw new Error("Agent Session 执行失败");
  if (!result.messages.length) throw new Error("Agent Session 已结束，但没有产生回复");
  // 一个 run 可能产生多条 agent.message：前面的通常是“让我先检查…”一类
  // 工具执行播报，最后一条才是面向用户的完整结果。
  return result.messages.at(-1)!;
}
