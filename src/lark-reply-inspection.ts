import type { ChannelMessage, ReplyInspectionQuery, ReplyObservation } from "./channel.ts";
import { replyContentFingerprint, validReplyFingerprint } from "./reply-delivery.ts";

export type ReplyInspectionClient = { im: { message?: { get?(payload: unknown): Promise<unknown> } } };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= 1024;

// 只读取持久化的消息ID，不用相似文本/时间窗口猜回复归属；消息可读不代表用户已读。
export async function inspectLarkReply(client: ReplyInspectionClient, appId: string, message: ChannelMessage,
  query: ReplyInspectionQuery, signal: AbortSignal): Promise<ReplyObservation> {
  const unknown = (reason: Extract<ReplyObservation, { status: "unknown" }>["reason"]): ReplyObservation => ({ status: "unknown", reason });
  const api = client.im.message;
  if (signal.aborted) return unknown("cancelled");
  if (!api?.get || message.channelType !== "lark" || message.installationId !== appId || !id(appId)
    || !id(message.tenantId) || !id(message.conversationId) || typeof message.threadId !== "string"
    || !query || query.mode !== "native_card" || !id(query.messageId) || !id(query.elementId)
    || !validReplyFingerprint(query.contentFingerprint)) return unknown("unsupported");
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  let abort!: () => void;
  const cancelled = new Promise<undefined>(resolve => { abort = () => resolve(undefined); bounded.addEventListener("abort", abort, { once: true }); });
  try {
    const response = await Promise.race([api.get({ path: { message_id: query.messageId },
      params: { user_id_type: "open_id", card_msg_content_type: "user_card_content" } }), cancelled]);
    if (bounded.aborted) return unknown("cancelled");
    if (!object(response) || response.code !== 0) return unknown("unavailable");
    if (!object(response.data) || !Array.isArray(response.data.items) || response.data.items.length !== 1) return unknown("invalid_response");
    const item = response.data.items[0];
    if (!object(item) || item.message_id !== query.messageId || item.chat_id !== message.conversationId
      || (item.thread_id ?? "") !== message.threadId || !object(item.sender) || item.sender.id !== appId
      || item.sender.id_type !== "app_id" || item.sender.sender_type !== "app" || item.sender.tenant_key !== message.tenantId) return unknown("identity_mismatch");
    if (item.deleted !== false || item.msg_type !== "interactive" || !object(item.body) || typeof item.body.content !== "string") return unknown("invalid_response");
    if (Buffer.byteLength(item.body.content, "utf8") > 1024 * 1024) return unknown("invalid_response");
    const card: unknown = JSON.parse(item.body.content);
    if (!object(card) || card.schema !== "2.0" || !object(card.config) || !object(card.body)
      || !Array.isArray(card.body.elements) || card.body.elements.length !== 1) return unknown("invalid_response");
    if (card.config.streaming_mode !== false) return unknown("streaming");
    const element = card.body.elements[0];
    if (!object(element) || element.tag !== "markdown" || element.element_id !== query.elementId
      || typeof element.content !== "string") return unknown("invalid_response");
    const contentFingerprint = replyContentFingerprint(element.content);
    if (contentFingerprint !== query.contentFingerprint) return unknown("content_mismatch");
    return { status: "confirmed", messageId: query.messageId, elementId: query.elementId, contentFingerprint, observedAt: Date.now() };
  } catch { return unknown("unavailable"); }
  finally {
    // SDK底层HTTP仍依赖自身超时；这里只限制等待并丢弃迟到结果，不伪称物理取消。
    bounded.removeEventListener("abort", abort);
  }
}
