import { createLarkChannel, type LarkChannel, type NormalizedMessage, type SendInput } from "@larksuite/channel";
import type { ChannelAdapter, ChannelHistoryMessage, ChannelMessage, ChannelMessageLookup, ChannelOutbound, ChannelResource } from "./channel.ts";
import { createFeishuResourceDownloader, MAX_FEISHU_FILE_BYTES, type FeishuResourceClient } from "./feishu.ts";

type RawLarkMessage = {
  event_id?: string;
  tenant_key?: string;
  sender?: { tenant_key?: string };
};

export type LarkChannelPort = Pick<LarkChannel,
  "addReaction" | "connect" | "createCard" | "disconnect" | "downloadResource" | "on" | "removeReaction" | "send" | "stream"
> & { rawClient?: FeishuCardStreamClient };

type LarkHistoryItem = {
  message_id?: string;
  chat_id?: string;
  msg_type?: string;
  create_time?: string;
  update_time?: string;
  thread_id?: string;
  deleted?: boolean;
  sender?: { id?: string; sender_type?: string; sender_name?: string };
  body?: { content?: string };
  mentions?: Array<{ key?: string; name?: string }>;
};

type LarkMessageListResponse = {
  code?: number;
  msg?: string;
  data?: { has_more?: boolean; page_token?: string; items?: LarkHistoryItem[] };
};

type LarkMessageList = (payload: unknown) => Promise<LarkMessageListResponse>;

type FeishuCardStreamClient = FeishuResourceClient & {
  im: FeishuResourceClient["im"] & { message?: { list: LarkMessageList; get?: LarkMessageList };
    v1?: { messageReaction?: { create(payload: unknown): Promise<{ code?: number; data?: { reaction_id?: string } }>;
      delete(payload: unknown): Promise<{ code?: number }> } } };
  cardkit?: { v1?: {
    cardElement?: { content(payload: unknown): Promise<unknown> };
    card?: { settings(payload: unknown): Promise<unknown> };
  } };
};

type StreamingOptions = {
  intervalMs?: number;
  minChunkChars?: number;
  maxSteps?: number;
  printFrequencyMs?: number;
  printStep?: number;
  settlePaddingMs?: number;
};

const DEFAULT_STREAMING_OPTIONS: Required<StreamingOptions> = {
  intervalMs: 80,
  minChunkChars: 12,
  maxSteps: 10,
  printFrequencyMs: 40,
  printStep: 4,
  settlePaddingMs: 120
};
const STREAMING_PLACEHOLDER = "Thinking...";

export class LarkChannelAdapter implements ChannelAdapter {
  readonly channelType = "lark" as const;
  readonly installationId: string;
  readonly capabilities = Object.freeze({
    cards: true, files: true, markdown: true, reactions: true, streaming: true, threads: true
  });
  private readonly channel: LarkChannelPort;
  private readonly maxFileBytes: number;
  private readonly streaming: Required<StreamingOptions>;
  private readonly streamingDownloader?: ReturnType<typeof createFeishuResourceDownloader>;
  private readonly onSent?: (message: ChannelMessage, id: string) => void;

  constructor(options: { appId: string; appSecret: string; maxFileBytes?: number; channel?: LarkChannelPort; streaming?: StreamingOptions; onSent?: (message: ChannelMessage, id: string) => void }) {
    this.installationId = options.appId;
    this.maxFileBytes = options.maxFileBytes ?? MAX_FEISHU_FILE_BYTES;
    this.onSent = options.onSent;
    this.streaming = {
      intervalMs: positiveInteger(options.streaming?.intervalMs, DEFAULT_STREAMING_OPTIONS.intervalMs),
      minChunkChars: positiveInteger(options.streaming?.minChunkChars, DEFAULT_STREAMING_OPTIONS.minChunkChars),
      maxSteps: positiveInteger(options.streaming?.maxSteps, DEFAULT_STREAMING_OPTIONS.maxSteps),
      printFrequencyMs: positiveInteger(options.streaming?.printFrequencyMs, DEFAULT_STREAMING_OPTIONS.printFrequencyMs),
      printStep: positiveInteger(options.streaming?.printStep, DEFAULT_STREAMING_OPTIONS.printStep),
      settlePaddingMs: nonNegativeInteger(options.streaming?.settlePaddingMs, DEFAULT_STREAMING_OPTIONS.settlePaddingMs)
    };
    this.channel = options.channel ?? createLarkChannel({
      appId: options.appId,
      appSecret: options.appSecret,
      transport: "websocket",
      includeRawEvent: true,
      source: "arkagent",
      handshakeTimeoutMs: 30_000,
      httpTimeoutMs: 30_000,
      keepalive: { enabled: true },
      // 未 @ 消息只进入 Gateway 本地上下文缓存；执行条件和排队仍由 Gateway 控制。
      policy: { dmMode: "open", requireMention: false, respondToMentionAll: false },
      safety: { chatQueue: { enabled: false }, staleMessageWindowMs: 5 * 60_000 }
    });
    // Channel SDK 的 downloadResource 返回完整 Buffer。真实 SDK 同时公开 rawClient，
    // 用它流式读取可在下载过程中执行 20 MB 上限，避免超大附件先占满内存。
    if (this.channel.rawClient) this.streamingDownloader = createFeishuResourceDownloader(this.channel.rawClient, this.maxFileBytes);
  }

  async start(handler: (message: ChannelMessage) => void): Promise<void> {
    this.channel.on("message", message => handler(normalizeLarkChannelMessage(message, this.installationId)));
    this.channel.on("error", error => console.error("飞书 Channel SDK 错误：", error));
    this.channel.on("reconnecting", () => console.warn("飞书 Channel SDK 正在重连…"));
    this.channel.on("reconnected", () => console.log("飞书 Channel SDK 已恢复连接。"));
    await this.channel.connect();
  }

  stop(): Promise<void> {
    return this.channel.disconnect();
  }

  async reply(message: ChannelMessage, outbound: ChannelOutbound): Promise<void> {
    const input = toLarkSendInput(outbound);
    const sent = await this.channel.send(message.conversationId, input, replyOptions(message));
    for (const id of [sent.messageId, ...(sent.chunkIds || [])]) if (id) this.onSent?.(message, id);
  }

  async send(conversationId: string, outbound: ChannelOutbound): Promise<void> {
    await this.channel.send(conversationId, toLarkSendInput(outbound));
  }

  async streamReply(
    message: ChannelMessage,
    producer: (update: (snapshot: string) => Promise<void>) => Promise<void>
  ): Promise<void> {
    const cardkit = this.channel.rawClient?.cardkit?.v1;
    if (cardkit?.cardElement?.content && cardkit.card?.settings && typeof this.channel.createCard === "function") {
      await this.streamNativeCardKit(message, producer, cardkit as Required<NonNullable<FeishuCardStreamClient["cardkit"]>["v1"]>);
      return;
    }
    const sent = await this.channel.stream(message.conversationId, {
      markdown: async controller => progressivelyWriteMarkdown({
        append: typeof controller.append === "function" ? controller.append.bind(controller) : undefined,
        setContent: controller.setContent.bind(controller)
      }, producer, this.streaming)
    }, replyOptions(message));
    if (sent.messageId) this.onSent?.(message, sent.messageId);
  }

  private async streamNativeCardKit(
    message: ChannelMessage,
    producer: (update: (snapshot: string) => Promise<void>) => Promise<void>,
    cardkit: Required<NonNullable<FeishuCardStreamClient["cardkit"]>["v1"]>
  ): Promise<void> {
    const elementId = "arkagent_stream_md";
    const { cardId } = await this.channel.createCard(buildNativeStreamingCard(elementId, this.streaming));
    const sent = await this.channel.send(message.conversationId, { cardId }, replyOptions(message));
    if (sent.messageId) this.onSent?.(message, sent.messageId);
    let sequence = 0;
    let content = "";
    let lastChunkChars = 0;
    const push = async (): Promise<void> => {
      const response = await cardkit.cardElement.content({
        path: { card_id: cardId, element_id: elementId },
        data: { content: content || STREAMING_PLACEHOLDER, sequence: ++sequence, uuid: `c_${cardId}_${sequence}` }
      });
      assertCardKitSuccess(response, "content");
    };

    try {
      await progressivelyWriteMarkdown({
        append: async chunk => {
          content += chunk;
          lastChunkChars = Array.from(chunk).length;
          await push();
        },
        setContent: async value => {
          content = value;
          lastChunkChars = Array.from(value).length;
          await push();
        }
      }, producer, this.streaming);
    } finally {
      if (lastChunkChars) {
        const settleMs = Math.ceil(lastChunkChars / this.streaming.printStep) * this.streaming.printFrequencyMs
          + this.streaming.settlePaddingMs;
        await wait(settleMs);
      }
      const response = await cardkit.card.settings({
        path: { card_id: cardId },
        data: {
          settings: JSON.stringify({ config: {
            streaming_mode: false,
            summary: { content: summarizeCard(content) }
          } }),
          sequence: ++sequence,
          uuid: `s_${cardId}_${sequence}`
        }
      });
      assertCardKitSuccess(response, "settings");
    }
  }

  async addReaction(message: ChannelMessage, emojiType: string): Promise<string> {
    const api = this.channel.rawClient?.im.v1?.messageReaction;
    if (api?.create) {
      const response = await api.create({ path: { message_id: message.messageId }, data: { reaction_type: { emoji_type: emojiType } } });
      assertReactionSuccess(response);
      const id = response.data?.reaction_id;
      if (typeof id !== "string" || !id.trim() || id.length > 1024) throw new Error("飞书表情响应缺少有效ID");
      return id;
    }
    return this.channel.addReaction(message.messageId, emojiType);
  }

  async removeReaction(message: ChannelMessage, reactionId: string): Promise<void> {
    const api = this.channel.rawClient?.im.v1?.messageReaction;
    if (api?.delete) {
      assertReactionSuccess(await api.delete({ path: { message_id: message.messageId, reaction_id: reactionId } }));
      return;
    }
    return this.channel.removeReaction(message.messageId, reactionId);
  }

  loadRecentHistory(message: ChannelMessage): Promise<ChannelHistoryMessage[]> {
    const client = this.channel.rawClient;
    if (!client?.im.message?.list) throw new Error("当前飞书 Channel 未提供群消息历史接口");
    return loadLarkRecentHistory(client, message);
  }

  async readMessage(message: ChannelMessage, messageId: string, signal: AbortSignal): Promise<ChannelMessageLookup> {
    const client = this.channel.rawClient;
    if (!client) return { status: "unavailable" };
    return readLarkMessage(client, message, messageId, signal);
  }

  async download(resource: ChannelResource, message: ChannelMessage, remainingBytes = this.maxFileBytes): Promise<{ bytes: Uint8Array; mimeType: string }> {
    if (this.streamingDownloader) return this.streamingDownloader(resource, message, remainingBytes);
    const bytes = await this.channel.downloadResource(message.messageId, resource.id, resource.type);
    const limit = Math.min(this.maxFileBytes, remainingBytes);
    if (bytes.byteLength > limit) throw new Error(`文件 ${resource.name} 超过 ${formatBytes(limit)} 限制`);
    return { bytes: new Uint8Array(bytes), mimeType: resource.mimeType || inferMimeType(resource.name, resource.type) };
  }
}

function assertReactionSuccess(response: { code?: number } | undefined): void {
  // Channel SDK的删除封装返回void且不检查业务码，不能直接作为恢复清理的确认。
  if (response?.code !== 0) throw new Error(`飞书表情操作未确认成功（${typeof response?.code === "number" ? response.code : "invalid_response"}）`);
}

function assertCardKitSuccess(response: unknown, operation: "content" | "settings"): void {
  const code = response && typeof response === "object" ? (response as { code?: unknown }).code : undefined;
  // 原生SDK返回业务信封，HTTP 200并不保证更新成功；错误正文可能含敏感内容。
  if (code !== 0) throw new Error(`飞书CardKit ${operation} 未确认成功（${typeof code === "number" && Number.isFinite(code) ? code : "invalid_response"}）`);
}

function buildNativeStreamingCard(elementId: string, options: Required<StreamingOptions>): object {
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      summary: { content: "生成中…" },
      streaming_config: {
        print_frequency_ms: { default: options.printFrequencyMs },
        print_step: { default: options.printStep },
        print_strategy: "fast"
      }
    },
    body: { elements: [{ tag: "markdown", element_id: elementId, content: STREAMING_PLACEHOLDER }] }
  };
}

function summarizeCard(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 50) || "已完成";
}

async function progressivelyWriteMarkdown(
  writer: { append?: (value: string) => Promise<void>; setContent: (value: string) => Promise<void> },
  producer: (update: (snapshot: string) => Promise<void>) => Promise<void>,
  options: Required<StreamingOptions>
): Promise<void> {
  let target = "";
  let rendered = "";
  let producerFinished = false;

  let writerError: unknown;
  const writerTask = (async () => {
    while (!producerFinished || rendered !== target) {
      if (rendered === target) {
        await wait(options.intervalMs);
        continue;
      }
      const extendsCurrent = target.startsWith(rendered);
      const next = nextProgressiveSnapshot(rendered, target, options);
      if (extendsCurrent && writer.append) await writer.append(next.slice(rendered.length));
      else await writer.setContent(next);
      rendered = next;
      if (rendered !== target) await wait(options.intervalMs);
    }
  })().catch(error => { writerError = error; });

  let producerError: unknown;
  try {
    await producer(async snapshot => {
      if (snapshot && snapshot !== target) target = snapshot;
    });
  } catch (error) {
    producerError = error;
  } finally {
    producerFinished = true;
  }

  await writerTask;
  if (writerError) throw writerError;
  if (producerError) throw producerError;
}

function nextProgressiveSnapshot(current: string, target: string, options: Required<StreamingOptions>): string {
  const targetChars = Array.from(target);
  // 一个 run 可能先产生过程性的 agent.message，再产生最终答案。后一条不是前一条
  // 的前缀时，从最终答案的首批字符重新渐进展示，不能整段瞬间替换。
  const currentLength = target.startsWith(current) ? Array.from(current).length : 0;
  const chunkSize = Math.max(options.minChunkChars, Math.ceil(targetChars.length / options.maxSteps));
  return targetChars.slice(0, Math.min(targetChars.length, currentLength + chunkSize)).join("");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function replyOptions(message: ChannelMessage): { replyTo: string; replyInThread: true } | undefined {
  return message.conversationType === "group" && message.threadId
    ? { replyTo: message.messageId, replyInThread: true }
    : undefined;
}

export function normalizeLarkChannelMessage(message: NormalizedMessage, installationId: string): ChannelMessage {
  const raw = (message.raw || {}) as RawLarkMessage;
  return {
    channelType: "lark",
    installationId,
    eventId: raw.event_id || message.messageId,
    messageId: message.messageId,
    tenantId: raw.sender?.tenant_key || raw.tenant_key || "default",
    conversationId: message.chatId,
    conversationType: message.chatType === "p2p" ? "direct" : "group",
    threadId: message.threadId || "",
    rootMessageId: message.rootId || "",
    parentMessageId: message.replyToMessageId || "",
    createTime: Number(message.createTime || Date.now()),
    senderId: message.senderId,
    ...(message.senderType ? { senderType: message.senderType } : {}),
    text: message.content.trim(),
    resources: message.resources
      .filter(resource => resource.type === "file" || resource.type === "image")
      .map(resource => ({
        id: resource.fileKey,
        name: resource.fileName || (resource.type === "image" ? `${resource.fileKey}.jpg` : resource.fileKey),
        type: resource.type as "file" | "image"
      })),
    mentionedBot: message.mentionedBot
  };
}

export async function readLarkMessage(
  client: Pick<FeishuCardStreamClient, "im">,
  message: ChannelMessage,
  messageId: string,
  signal: AbortSignal
): Promise<ChannelMessageLookup> {
  const get = client.im.message?.get;
  if (!get) return { status: "unavailable" };
  if (signal.aborted) return { status: "timeout" };
  try {
    // node-sdk 的单次调用不暴露 AbortSignal；Gateway 限制等待时间，底层受 HTTP 超时约束。
    const response = await get.call(client.im.message, { path: { message_id: messageId }, params: { user_id_type: "open_id", with_sender_name: true } });
    if (signal.aborted) return { status: "timeout" };
    if (response.code !== 0) return { status: "unavailable" };
    const item = response.data?.items?.find(item => item.message_id === messageId);
    if (!item) return { status: "not_found" };
    if (item.chat_id !== message.conversationId || (item.thread_id && item.thread_id !== message.threadId)) return { status: "unavailable" };
    if (!isEligibleHistoryItem(item, message)) return { status: "unavailable" };
    if (item.deleted) return { status: "deleted" };
    const normalized = normalizeHistoryItem(item, item.thread_id ? "thread" : "chat");
    return normalized ? { status: "available", message: normalized } : { status: "unavailable" };
  } catch {
    return { status: signal.aborted ? "timeout" : "failed" };
  }
}

export async function loadLarkRecentHistory(
  client: Pick<FeishuCardStreamClient, "im">,
  message: ChannelMessage,
  options: { maxMessages?: number; maxChars?: number; maxPages?: number } = {}
): Promise<ChannelHistoryMessage[]> {
  const list = client.im.message?.list;
  if (!list) throw new Error("飞书 OpenAPI Client 缺少 im.message.list");
  const maxMessages = positiveInteger(options.maxMessages, 20);
  const maxChars = positiveInteger(options.maxChars, 8_000);
  const maxPages = positiveInteger(options.maxPages, 3);
  const sources: Array<"chat" | "thread"> = message.threadId ? ["chat", "thread"] : ["chat"];
  const settled = await Promise.allSettled(sources.map(source => loadHistoryContainer(
    list.bind(client.im.message), message, source, maxMessages, maxPages
  )));
  if (settled.every(result => result.status === "rejected")) {
    const firstFailure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    throw firstFailure?.reason || new Error("读取飞书会话历史失败");
  }
  const resultSets = settled.map(result => result.status === "fulfilled" ? result.value : []);
  const unique = new Map<string, { item: LarkHistoryItem; source: "chat" | "thread" }>();
  for (const [index, items] of resultSets.entries()) {
    const source = sources[index];
    for (const item of items) if (item.message_id) unique.set(item.message_id, { item, source });
  }
  const allNormalized = [...unique.values()]
    .map(({ item, source }) => normalizeHistoryItem(item, source))
    .filter((item): item is ChannelHistoryMessage => Boolean(item))
    .sort((left, right) => left.createTime - right.createTime);
  const normalized = allNormalized.slice(-maxMessages);
  const trimmed = trimHistoryToChars(normalized, maxChars) as ChannelHistoryMessage[] & { notices?: string[] };
  const notices: string[] = [];
  if (settled.some(result => result.status === "rejected")) notices.push("部分群聊或话题历史读取失败，当前上下文可能不完整。");
  if (allNormalized.length >= maxMessages || JSON.stringify(trimmed) !== JSON.stringify(normalized)) notices.push(`仅加载近期 ${maxMessages} 条、最多 ${maxChars} 字的会话片段；更早消息需主动查询。`);
  if (notices.length) trimmed.notices = notices;
  return trimmed;
}

async function loadHistoryContainer(
  list: LarkMessageList,
  message: ChannelMessage,
  source: "chat" | "thread",
  maxMessages: number,
  maxPages: number
): Promise<LarkHistoryItem[]> {
  const items: LarkHistoryItem[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, string | number | boolean> = {
      container_id_type: source,
      container_id: source === "thread" ? message.threadId : message.conversationId,
      sort_type: "ByCreateTimeDesc",
      page_size: 50,
      with_sender_name: true
    };
    if (source === "chat") params.end_time = String(Math.ceil(message.createTime / 1000));
    if (pageToken) params.page_token = pageToken;
    const response = await list({ params });
    if (response.code && response.code !== 0) throw new Error(`读取飞书会话历史失败：${response.msg || `code ${response.code}`}`);
    items.push(...(response.data?.items || []));
    const eligibleCount = items.filter(item => isEligibleHistoryItem(item, message)).length;
    if (eligibleCount >= maxMessages || !response.data?.has_more || !response.data.page_token) break;
    pageToken = response.data.page_token;
  }
  return items.filter(item => isEligibleHistoryItem(item, message));
}

function isEligibleHistoryItem(item: LarkHistoryItem, trigger: ChannelMessage): boolean {
  const createTime = Number(item.create_time || 0);
  return Boolean(item.message_id && item.message_id !== trigger.messageId && createTime > 0 && createTime <= trigger.createTime);
}

function normalizeHistoryItem(item: LarkHistoryItem, source: "chat" | "thread"): ChannelHistoryMessage | undefined {
  const messageId = String(item.message_id || "");
  const resources = item.deleted ? [] : historyItemResources(item);
  const text = item.deleted ? "[该消息已撤回，原内容不应继续作为有效依据]" : historyItemText(item) || (resources.length ? "[富文本附件]" : "");
  if (!messageId || !text) return undefined;
  return {
    messageId,
    senderId: String(item.sender?.id || "unknown"),
    senderName: item.sender?.sender_name || undefined,
    senderType: String(item.sender?.sender_type || "unknown"),
    source,
    text,
    ...(resources.length ? { resources } : {}),
    createTime: Number(item.create_time || 0),
    ...(item.update_time ? { updateTime: Number(item.update_time) } : {}),
    ...(item.thread_id ? { threadId: item.thread_id } : {}),
    ...(item.deleted ? { deleted: true } : {})
  };
}

function historyItemResources(item: LarkHistoryItem): ChannelResource[] {
  let value: Record<string, unknown>;
  try { value = JSON.parse(item.body?.content || "{}") as Record<string, unknown>; }
  catch { return []; }
  if (item.msg_type === "file" && typeof value.file_key === "string" && value.file_key) {
    return [{
      id: value.file_key,
      name: typeof value.file_name === "string" && value.file_name ? value.file_name : value.file_key,
      type: "file"
    }];
  }
  if (item.msg_type === "image" && typeof value.image_key === "string" && value.image_key) {
    return [{ id: value.image_key, name: `${value.image_key}.jpg`, type: "image" }];
  }
  if (item.msg_type === "post") {
    const resources = new Map<string, ChannelResource>();
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (typeof record.image_key === "string" && record.image_key) resources.set(record.image_key, { id: record.image_key, name: `${record.image_key}.jpg`, type: "image" });
      if (typeof record.file_key === "string" && record.file_key) resources.set(record.file_key, { id: record.file_key, name: String(record.file_name || record.file_key), type: "file" });
      for (const child of Object.values(record)) if (typeof child === "object") visit(child);
    };
    visit(value);
    return [...resources.values()];
  }
  return [];
}

function historyItemText(item: LarkHistoryItem): string {
  const content = item.body?.content || "";
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { return content.trim().slice(0, 2_000); }
  let text = "";
  if (item.msg_type === "text") text = String((value as { text?: unknown })?.text || "");
  else if (item.msg_type === "post") text = collectText(value).join("\n");
  else if (item.msg_type === "file") text = `[文件：${String((value as { file_name?: unknown })?.file_name || "未命名文件")}]`;
  else if (item.msg_type === "image") text = "[图片]";
  else if (item.msg_type) text = `[${item.msg_type} 消息]`;
  for (const mention of item.mentions || []) if (mention.key) text = text.replaceAll(mention.key, mention.name ? `@${mention.name}` : "");
  return text.replace(/\s+/g, " ").trim().slice(0, 2_000);
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") return [];
  if (Array.isArray(value)) return value.flatMap(collectText);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own = typeof record.text === "string" ? [record.text] : [];
  return own.concat(Object.entries(record).filter(([key]) => key !== "text").flatMap(([, child]) => collectText(child)));
}

function trimHistoryToChars(messages: ChannelHistoryMessage[], maxChars: number): ChannelHistoryMessage[] {
  const selected: ChannelHistoryMessage[] = [];
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const size = Array.from(message.text).length;
    if (selected.length && total + size > maxChars) break;
    selected.unshift(size <= maxChars ? message : { ...message, text: Array.from(message.text).slice(-maxChars).join("") });
    total += Math.min(size, maxChars);
  }
  return selected;
}

export function toLarkSendInput(outbound: ChannelOutbound): SendInput {
  if (outbound.type === "card") return { card: outbound.card };
  if (outbound.type === "markdown") return { markdown: outbound.markdown };
  return { text: outbound.text };
}

function inferMimeType(name: string, type: "file" | "image"): string {
  if (type === "image") return "image/jpeg";
  if (/\.pdf$/i.test(name)) return "application/pdf";
  if (/\.(?:md|markdown)$/i.test(name)) return "text/markdown";
  if (/\.txt$/i.test(name)) return "text/plain";
  return "application/octet-stream";
}

function formatBytes(value: number): string {
  return value >= 1024 * 1024 ? `${Math.round(value / 1024 / 1024)} MB` : `${Math.round(value / 1024)} KB`;
}
