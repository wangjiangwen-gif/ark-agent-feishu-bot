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

type PostNode = {
  tag?: string;
  text?: string;
  user_name?: string;
  image_key?: string;
};

type PostBody = {
  title?: string;
  content?: PostNode[][];
};

export async function startFeishuGateway(options: {
  appId: string;
  appSecret: string;
  gateway: Gateway;
}): Promise<void> {
  return startLegacyFeishuChannel({ ...options, onMessage: message => options.gateway.accept(message) });
}

export async function startLegacyFeishuChannel(options: {
  appId: string;
  appSecret: string;
  onMessage: (message: IncomingMessage) => void;
}): Promise<void> {
  const Lark = await import("@larksuiteoapi/node-sdk");
  const baseConfig = { appId: options.appId, appSecret: options.appSecret };
  const wsClient = new Lark.WSClient({ ...baseConfig, loggerLevel: Lark.LoggerLevel.info });
  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: unknown) => {
      const message = normalizeFeishuMessage(data as FeishuEvent, options.appId);
      if (message) options.onMessage(message);
    }
  });
  // SDK 的事件处理函数只做去重与入队，不等待 Agent 执行，满足飞书 3 秒处理约束。
  await wsClient.start({ eventDispatcher: dispatcher });
}

export function normalizeFeishuMessage(event: FeishuEvent, installationId = "legacy"): IncomingMessage | undefined {
  const message = event.message;
  if (!message?.message_id || !message.chat_id) return undefined;
  let text = "";
  let attachments: LegacyAttachment[] = [];
  try {
    const content = JSON.parse(message.content || "{}") as { text?: string; file_key?: string; file_name?: string; image_key?: string } & Record<string, unknown>;
    if (message.message_type === "text") text = String(content.text || "");
    else if (message.message_type === "file" && content.file_key) {
      attachments = [{ key: content.file_key, name: content.file_name || content.file_key, type: "file" }];
    } else if (message.message_type === "image" && content.image_key) {
      attachments = [{ key: content.image_key, name: `${content.image_key}.jpg`, type: "image" }];
    } else if (message.message_type === "post") {
      ({ text, attachments } = normalizePost(content));
    } else return undefined;
  } catch {
    return undefined;
  }
  for (const mention of message.mentions || []) {
    if (mention.key) text = text.replaceAll(mention.key, "");
  }
  return {
    channelType: "lark",
    installationId,
    eventId: event.event_id || message.message_id,
    messageId: message.message_id,
    conversationId: message.chat_id,
    conversationType: message.chat_type === "p2p" ? "direct" : "group",
    threadId: message.thread_id || message.root_id || message.parent_id || "",
    senderId: event.sender?.sender_id?.open_id || "",
    tenantId: event.tenant_key || "default",
    text: text.trim(),
    resources: attachments.map(item => ({ id: item.key, name: item.name, type: item.type })),
    mentionedBot: Boolean(message.mentions?.length)
  };
}

type LegacyAttachment = { key: string; name: string; type: "file" | "image" };

function normalizePost(content: Record<string, unknown>): { text: string; attachments: LegacyAttachment[] } {
  const body = selectPostBody(content);
  if (!body) return { text: "", attachments: [] };
  const lines: string[] = [];
  const attachments: LegacyAttachment[] = [];
  const imageKeys = new Set<string>();
  if (typeof body.title === "string" && body.title.trim()) lines.push(body.title.trim());
  for (const row of Array.isArray(body.content) ? body.content : []) {
    if (!Array.isArray(row)) continue;
    const texts: string[] = [];
    for (const node of row) {
      if (!node || typeof node !== "object") continue;
      if (["text", "a", "code_block"].includes(node.tag || "") && typeof node.text === "string" && node.text.trim()) texts.push(node.text.trim());
      else if (node.tag === "at" && typeof node.user_name === "string" && node.user_name.trim()) texts.push(`@${node.user_name.trim()}`);
      else if (["img", "image"].includes(node.tag || "") && typeof node.image_key === "string" && node.image_key && !imageKeys.has(node.image_key)) {
        imageKeys.add(node.image_key);
        attachments.push({ key: node.image_key, name: `${node.image_key}.jpg`, type: "image" });
      }
    }
    if (texts.length) lines.push(texts.join(" "));
  }
  return { text: lines.join("\n"), attachments };
}

function selectPostBody(content: Record<string, unknown>): PostBody | undefined {
  if (Array.isArray(content.content)) return content as PostBody;
  for (const locale of ["zh_cn", "en_us", "ja_jp"]) {
    const candidate = content[locale];
    if (isPostBody(candidate)) return candidate;
  }
  return Object.values(content).find(isPostBody);
}

function isPostBody(value: unknown): value is PostBody {
  return Boolean(value && typeof value === "object" && Array.isArray((value as PostBody).content));
}

export type FeishuResourceClient = {
  im: { messageResource: { get(payload: {
    params: { type: string };
    path: { message_id: string; file_key: string };
  }): Promise<{ getReadableStream(): AsyncIterable<Uint8Array | Buffer>; headers?: Record<string, unknown> }> } };
};

export function createFeishuResourceDownloader(client: FeishuResourceClient, maxBytes = MAX_FEISHU_FILE_BYTES) {
  return async (attachment: IncomingMessage["resources"][number], message: IncomingMessage): Promise<{ bytes: Uint8Array; mimeType: string }> => {
    const response = await client.im.messageResource.get({
      params: { type: attachment.type },
      path: { message_id: message.messageId, file_key: attachment.id }
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
