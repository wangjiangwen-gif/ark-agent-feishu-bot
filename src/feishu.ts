import type { Gateway, IncomingMessage } from "./gateway.ts";

type FeishuEvent = {
  event_id?: string;
  tenant_key?: string;
  sender?: { sender_id?: { open_id?: string } };
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{ key?: string; id?: { open_id?: string }; name?: string }>;
  };
};

export async function startFeishuGateway(options: {
  appId: string;
  appSecret: string;
  gateway: Gateway;
}): Promise<void> {
  const Lark = await import("@larksuiteoapi/node-sdk");
  const baseConfig = { appId: options.appId, appSecret: options.appSecret };
  const wsClient = new Lark.WSClient({ ...baseConfig, loggerLevel: Lark.LoggerLevel.info });
  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: unknown) => {
      const message = normalizeFeishuMessage(data as FeishuEvent);
      if (message) options.gateway.accept(message);
    }
  });
  // SDK 的事件处理函数只做去重与入队，不等待 Agent 执行，满足飞书 3 秒处理约束。
  await wsClient.start({ eventDispatcher: dispatcher });
}

export function normalizeFeishuMessage(event: FeishuEvent): IncomingMessage | undefined {
  const message = event.message;
  if (!message?.message_id || !message.chat_id || message.message_type !== "text") return undefined;
  let text = "";
  try {
    const content = JSON.parse(message.content || "{}") as { text?: string };
    text = String(content.text || "");
  } catch {
    return undefined;
  }
  for (const mention of message.mentions || []) {
    if (mention.key) text = text.replaceAll(mention.key, "");
  }
  return {
    eventId: event.event_id || message.message_id,
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type === "p2p" ? "p2p" : "group",
    threadId: message.thread_id || message.root_id || message.parent_id || "",
    userOpenId: event.sender?.sender_id?.open_id || "",
    tenantKey: event.tenant_key || "default",
    text: text.trim(),
    mentionedBot: Boolean(message.mentions?.length)
  };
}
