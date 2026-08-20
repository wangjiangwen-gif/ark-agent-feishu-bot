import { createLarkChannel, type LarkChannel, type NormalizedMessage, type SendInput } from "@larksuite/channel";
import type { ChannelAdapter, ChannelMessage, ChannelOutbound, ChannelResource } from "./channel.ts";
import { createFeishuResourceDownloader, MAX_FEISHU_FILE_BYTES, type FeishuResourceClient } from "./feishu.ts";

type RawLarkMessage = {
  event_id?: string;
  tenant_key?: string;
  sender?: { tenant_key?: string };
};

export type LarkChannelPort = Pick<LarkChannel,
  "addReaction" | "connect" | "disconnect" | "downloadResource" | "on" | "removeReaction" | "send" | "stream"
> & { rawClient?: FeishuResourceClient };

type StreamingOptions = {
  intervalMs?: number;
  minChunkChars?: number;
  maxSteps?: number;
};

const DEFAULT_STREAMING_OPTIONS: Required<StreamingOptions> = {
  intervalMs: 80,
  minChunkChars: 12,
  maxSteps: 10
};

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

  constructor(options: { appId: string; appSecret: string; maxFileBytes?: number; channel?: LarkChannelPort; streaming?: StreamingOptions }) {
    this.installationId = options.appId;
    this.maxFileBytes = options.maxFileBytes ?? MAX_FEISHU_FILE_BYTES;
    this.streaming = {
      intervalMs: positiveInteger(options.streaming?.intervalMs, DEFAULT_STREAMING_OPTIONS.intervalMs),
      minChunkChars: positiveInteger(options.streaming?.minChunkChars, DEFAULT_STREAMING_OPTIONS.minChunkChars),
      maxSteps: positiveInteger(options.streaming?.maxSteps, DEFAULT_STREAMING_OPTIONS.maxSteps)
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
      policy: { dmMode: "open", requireMention: true, respondToMentionAll: false },
      // Gateway 已经提供持久去重和按“会话”粒度的队列。SDK 只保留内存去重，
      // 关闭 chatQueue，避免群聊内不同用户被二次串行化。
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
    await this.channel.send(message.conversationId, input, replyOptions(message));
  }

  async send(conversationId: string, outbound: ChannelOutbound): Promise<void> {
    await this.channel.send(conversationId, toLarkSendInput(outbound));
  }

  async streamReply(
    message: ChannelMessage,
    producer: (update: (snapshot: string) => Promise<void>) => Promise<void>
  ): Promise<void> {
    await this.channel.stream(message.conversationId, {
      markdown: async controller => progressivelyWriteMarkdown({
        append: typeof controller.append === "function" ? controller.append.bind(controller) : undefined,
        setContent: controller.setContent.bind(controller)
      }, producer, this.streaming)
    }, replyOptions(message));
  }

  addReaction(message: ChannelMessage, emojiType: string): Promise<string> {
    return this.channel.addReaction(message.messageId, emojiType);
  }

  removeReaction(message: ChannelMessage, reactionId: string): Promise<void> {
    return this.channel.removeReaction(message.messageId, reactionId);
  }

  async download(resource: ChannelResource, message: ChannelMessage): Promise<{ bytes: Uint8Array; mimeType: string }> {
    if (this.streamingDownloader) return this.streamingDownloader(resource, message);
    const bytes = await this.channel.downloadResource(message.messageId, resource.id, resource.type);
    if (bytes.byteLength > this.maxFileBytes) throw new Error(`文件 ${resource.name} 超过 ${formatBytes(this.maxFileBytes)} 限制`);
    return { bytes: new Uint8Array(bytes), mimeType: resource.mimeType || inferMimeType(resource.name, resource.type) };
  }
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
    threadId: message.threadId || message.rootId || "",
    senderId: message.senderId,
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
