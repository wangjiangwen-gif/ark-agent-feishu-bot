import { createHash } from "node:crypto";
import type { ReplyDeliveryEvent, ReplyInspectionQuery } from "./channel.ts";

export type ReplyDeliveryState = {
  mode: "native_card" | "message" | "sdk_stream";
  phase: "creating" | "created" | "ready" | "sending" | "sent" | "updating" | "updated" | "finalizing" | "finalized" | "completed";
  sequence: number; cardId?: string; elementId?: string; messageIds?: string[];
  contentFingerprint?: string; pendingContentFingerprint?: string;
};
export const replyContentFingerprint = (text: string): string => createHash("sha256").update(text).digest("hex");
const validId = (id: unknown): id is string => typeof id === "string" && Boolean(id.trim()) && id.length <= 1024;
export const validReplyFingerprint = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function replyInspectionQuery(state: ReplyDeliveryState | undefined, fingerprint: string | undefined): ReplyInspectionQuery | undefined {
  if (!state || state.mode !== "native_card" || !["updating", "updated", "finalizing", "finalized"].includes(state.phase)
    || state.messageIds?.length !== 1 || !validId(state.messageIds[0]) || !validId(state.elementId) || !validId(state.cardId)
    || !validReplyFingerprint(fingerprint) || (state.pendingContentFingerprint || state.contentFingerprint) !== fingerprint) return undefined;
  return { mode: "native_card", messageId: state.messageIds[0], elementId: state.elementId, contentFingerprint: fingerprint };
}

export function advanceReplyDelivery(previous: ReplyDeliveryState | undefined, event: ReplyDeliveryEvent): ReplyDeliveryState {
  if (event.type === "begin") {
    if (previous || !["native_card", "message", "sdk_stream"].includes(event.mode)) throw new Error("回复投递不能重复开始");
    return { mode: event.mode, phase: event.mode === "native_card" ? "creating" : "ready", sequence: 0 };
  }
  if (!previous || previous.phase === "completed") throw new Error("回复投递状态不允许更新");
  const state = structuredClone(previous);
  const requirePhase = (...phases: ReplyDeliveryState["phase"][]) => {
    if (!phases.includes(state.phase)) throw new Error("回复投递阶段不匹配");
  };
  const requireSequence = (sequence: number, next: boolean) => {
    if (!Number.isSafeInteger(sequence) || sequence !== state.sequence + (next ? 1 : 0) || sequence < 1) throw new Error("回复投递序号不匹配");
  };
  switch (event.type) {
    case "card_created":
      requirePhase("creating");
      if (!validId(event.cardId) || !validId(event.elementId)) throw new Error("回复卡片ID无效");
      return { ...state, phase: "created", cardId: event.cardId, elementId: event.elementId };
    case "sending": requirePhase("created", "ready"); return { ...state, phase: "sending" };
    case "sent":
      requirePhase("sending");
      if (!Array.isArray(event.messageIds) || !event.messageIds.length || event.messageIds.length > 1000 || !event.messageIds.every(validId)) throw new Error("回复消息ID无效");
      return { ...state, phase: "sent", messageIds: [...new Set(event.messageIds)] };
    case "content_pending":
      requirePhase("sent", "updated"); requireSequence(event.sequence, true);
      if (state.mode !== "native_card" || !validReplyFingerprint(event.contentFingerprint)) throw new Error("回复正文检查点无效");
      return { ...state, phase: "updating", sequence: event.sequence, pendingContentFingerprint: event.contentFingerprint };
    case "content_confirmed":
      requirePhase("updating"); requireSequence(event.sequence, false);
      if (state.pendingContentFingerprint !== event.contentFingerprint) throw new Error("回复正文确认不一致");
      return { ...state, phase: "updated", contentFingerprint: event.contentFingerprint, pendingContentFingerprint: undefined };
    case "finalizing":
      requirePhase("sent", "updating", "updated"); requireSequence(event.sequence, true);
      if (state.mode !== "native_card") throw new Error("回复投递模式不能关闭卡片");
      return { ...state, phase: "finalizing", sequence: event.sequence };
    case "finalized":
      requirePhase("finalizing"); requireSequence(event.sequence, false);
      return { ...state, phase: "finalized" };
    case "completed":
      if (state.mode === "sdk_stream") throw new Error("SDK流式回退不提供可验证的最终投递确认");
      requirePhase(state.mode === "native_card" ? "finalized" : "sent");
      if (!state.messageIds?.length || !validReplyFingerprint(event.contentFingerprint) || state.pendingContentFingerprint
        || (state.mode === "native_card" && state.contentFingerprint && state.contentFingerprint !== event.contentFingerprint)) throw new Error("回复投递正文缺少确认");
      return { ...state, phase: "completed", contentFingerprint: event.contentFingerprint };
    default: throw new Error("未知回复投递事件");
  }
}

export function validateReplyDelivery(value: ReplyDeliveryState): void {
  if (!value || !["native_card", "message", "sdk_stream"].includes(value.mode)
    || !["creating", "created", "ready", "sending", "sent", "updating", "updated", "finalizing", "finalized", "completed"].includes(value.phase)
    || !Number.isSafeInteger(value.sequence) || value.sequence < 0
    || [value.cardId, value.elementId].some(id => id !== undefined && !validId(id))
    || (value.messageIds !== undefined && (!Array.isArray(value.messageIds) || !value.messageIds.length || value.messageIds.length > 1000 || !value.messageIds.every(validId)))
    || [value.contentFingerprint, value.pendingContentFingerprint].some(hash => hash !== undefined && !validReplyFingerprint(hash))
    || (value.phase === "completed" && (!value.messageIds?.length || !value.contentFingerprint || value.pendingContentFingerprint))) throw new Error("回复投递检查点损坏");
}
