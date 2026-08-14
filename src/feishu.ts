import type { Gateway, IncomingMessage } from "./gateway.ts";

export const MAX_FEISHU_FILE_BYTES = 20 * 1024 * 1024;

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
  if (!message?.message_id || !message.chat_id) return undefined;
  let text = "";
  let attachments: IncomingMessage["attachments"] = [];
  try {
    const content = JSON.parse(message.content || "{}") as { text?: string; file_key?: string; file_name?: string; image_key?: string };
    if (message.message_type === "text") text = String(content.text || "");
    else if (message.message_type === "file" && content.file_key) {
      attachments = [{ key: content.file_key, name: content.file_name || content.file_key, type: "file" }];
    } else if (message.message_type === "image" && content.image_key) {
      attachments = [{ key: content.image_key, name: `${content.image_key}.jpg`, type: "image" }];
    } else return undefined;
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
    attachments,
    mentionedBot: Boolean(message.mentions?.length)
  };
}

export type FeishuResourceClient = {
  im: { messageResource: { get(payload: {
    params: { type: string };
    path: { message_id: string; file_key: string };
  }): Promise<{ getReadableStream(): AsyncIterable<Uint8Array | Buffer>; headers?: Record<string, unknown> }> } };
};

export function createFeishuResourceDownloader(client: FeishuResourceClient, maxBytes = MAX_FEISHU_FILE_BYTES) {
  return async (attachment: IncomingMessage["attachments"][number], message: IncomingMessage): Promise<{ bytes: Uint8Array; mimeType: string }> => {
    const response = await client.im.messageResource.get({
      params: { type: attachment.type },
      path: { message_id: message.messageId, file_key: attachment.key }
    });
    const declaredSize = Number(headerValue(response.headers, "content-length") || 0);
    if (declaredSize > maxBytes) throw new Error(`文件 ${attachment.name} 超过 ${formatBytes(maxBytes)} 限制`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.getReadableStream()) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      size += bytes.byteLength;
      if (size > maxBytes) throw new Error(`文件 ${attachment.name} 超过 ${formatBytes(maxBytes)} 限制`);
      chunks.push(bytes);
    }
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    return { bytes: combined, mimeType: headerValue(response.headers, "content-type") || inferMimeType(attachment.name, attachment.type) };
  };
}

function headerValue(headers: Record<string, unknown> | undefined, key: string): string {
  if (!headers) return "";
  const value = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "").split(";")[0].trim();
}

function inferMimeType(name: string, type: "file" | "image"): string {
  if (type === "image") return "image/jpeg";
  const extension = name.toLowerCase().split(".").pop();
  return ({ pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv", txt: "text/plain", md: "text/markdown" } as Record<string, string>)[extension || ""] || "application/octet-stream";
}

function formatBytes(bytes: number): string {
  return `${Math.floor(bytes / 1024 / 1024)} MB`;
}
