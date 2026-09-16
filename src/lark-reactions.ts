import type { ChannelMessage, ReactionObservation, ReactionQuery } from "./channel.ts";

type ReactionItem = { reaction_id?: string; operator?: { operator_type: "app" | "user"; operator_id: string };
  reaction_type?: { emoji_type: string }; action_time?: string };
export type ReactionListClient = { im: { v1?: { messageReaction?: { list?(payload: unknown): Promise<{
  code?: number; data?: { items: ReactionItem[]; has_more: boolean; page_token?: string }
}> } } } };

// 查询必须完整才能证明不存在；仅operator_type=app不足以证明是本应用。
export async function inspectLarkReaction(client: ReactionListClient, appId: string, message: ChannelMessage,
  query: ReactionQuery, signal: AbortSignal): Promise<ReactionObservation> {
  const api = client.im.v1?.messageReaction;
  if (!api?.list || message.channelType !== "lark" || message.installationId !== appId || !message.messageId
    || !["Get", "OnIt"].includes(query.emoji) || (query.reactionId !== undefined && (typeof query.reactionId !== "string"
      || !query.reactionId.trim() || query.reactionId.length > 1024)) || signal.aborted) return { status: "unknown" };
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const seen = new Map<string, ReactionItem>(), cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    for (let page = 0; page < 20; page++) {
      if (bounded.aborted) return { status: "unknown" };
      const response = await untilAbort(api.list({ path: { message_id: message.messageId }, params: {
        reaction_type: query.emoji, page_size: 50, user_id_type: "open_id", ...(cursor ? { page_token: cursor } : {})
      } }), bounded);
      if (bounded.aborted || response?.code !== 0 || !Array.isArray(response.data?.items)
        || response.data.items.length > 50 || typeof response.data.has_more !== "boolean") return { status: "unknown" };
      for (const item of response.data.items) {
        if (!item || typeof item.reaction_id !== "string" || !item.reaction_id.trim() || item.reaction_id.length > 1024
          || !["app", "user"].includes(item.operator?.operator_type || "") || typeof item.operator?.operator_id !== "string" || !item.operator.operator_id
          || item.reaction_type?.emoji_type !== query.emoji) return { status: "unknown" };
        const old = seen.get(item.reaction_id);
        if (old && (old.operator!.operator_id !== item.operator.operator_id || old.operator!.operator_type !== item.operator.operator_type
          || old.action_time !== item.action_time)) return { status: "unknown" };
        seen.set(item.reaction_id, item);
      }
      if (!response.data.has_more) return selectReaction([...seen.values()], appId, query);
      cursor = response.data.page_token;
      if (typeof cursor !== "string" || !cursor || cursor.length > 4096 || cursors.has(cursor)) return { status: "unknown" };
      cursors.add(cursor);
    }
  } catch { /* 上游异常可能含凭证，统一返回未知，不把失败当作空列表。 */ }
  return { status: "unknown" };
}

function selectReaction(items: ReactionItem[], appId: string, query: ReactionQuery): ReactionObservation {
  if (query.reactionId) {
    const match = items.find(item => item.reaction_id === query.reactionId);
    if (!match) return { status: "absent" };
    return match.operator!.operator_type === "app" && match.operator!.operator_id === appId
      ? { status: "present", reactionId: match.reaction_id! } : { status: "unknown" };
  }
  const mine = items.filter(item => item.operator!.operator_type === "app" && item.operator!.operator_id === appId);
  if (!mine.length) return { status: "absent" };
  if (mine.length !== 1 || !Number.isSafeInteger(query.createdAt) || query.createdAt! <= 0) return { status: "unknown" };
  const match = mine[0], at = typeof match.action_time === "string" && /^\d+$/.test(match.action_time) ? Number(match.action_time) : NaN;
  // 无ID的旧记录或时钟偏差无法证明归属，不采用“第一条应用表情”兜底。
  if (!Number.isSafeInteger(at) || at < query.createdAt! || at > query.createdAt! + 30_000) return { status: "unknown" };
  return { status: "present", reactionId: match.reaction_id! };
}

async function untilAbort<T>(request: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  let abort!: () => void;
  const cancelled = new Promise<undefined>(resolve => { abort = () => resolve(undefined); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); });
  // node-sdk底层HTTP不能由此取消；只限制Gateway等待，迟到结果不更新检查点。
  try { return await Promise.race([request, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
