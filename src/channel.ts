export type ChannelType = "lark" | (string & {});

export type ChannelResource = {
  id: string;
  name: string;
  type: "file" | "image";
  mimeType?: string;
};

export type ChannelMessage = {
  channelType: ChannelType;
  installationId: string;
  eventId: string;
  messageId: string;
  tenantId: string;
  conversationId: string;
  conversationType: "direct" | "group";
  threadId: string;
  rootMessageId: string;
  parentMessageId: string;
  createTime: number;
  senderId: string;
  senderType?: string;
  text: string;
  resources: ChannelResource[];
  mentionedBot: boolean;
};

export type ChannelHistoryMessage = {
  messageId: string;
  senderId: string;
  senderName?: string;
  senderType: string;
  source: "chat" | "thread";
  text: string;
  resources?: ChannelResource[];
  createTime: number;
  updateTime?: number;
  threadId?: string;
  deleted?: boolean;
  attachmentPending?: boolean;
};

export type ChannelMessageLookup =
  | { status: "available"; message: ChannelHistoryMessage }
  | { status: "deleted" | "not_found" | "unavailable" | "failed" | "timeout" };

export type ChannelReadMessage = (message: ChannelMessage, messageId: string, signal: AbortSignal) => Promise<ChannelMessageLookup>;

export type ReactionQuery = { emoji: "Get" | "OnIt"; reactionId?: string; createdAt?: number };
export type ReactionObservation = { status: "present"; reactionId: string } | { status: "absent" } | { status: "unknown" };
export type ChannelInspectReaction = (message: ChannelMessage, query: ReactionQuery, signal: AbortSignal) => Promise<ReactionObservation>;

export type ChannelOutbound =
  | { type: "text"; text: string }
  | { type: "markdown"; markdown: string }
  | { type: "card"; card: Record<string, unknown> };

export type ChannelCapabilities = {
  cards: boolean;
  files: boolean;
  markdown: boolean;
  reactions: boolean;
  streaming: boolean;
  threads: boolean;
};

export interface ChannelAdapter {
  readonly channelType: ChannelType;
  readonly installationId: string;
  readonly capabilities: Readonly<ChannelCapabilities>;
  start(handler: (message: ChannelMessage) => void): Promise<void>;
  stop(): Promise<void>;
  reply(message: ChannelMessage, outbound: ChannelOutbound): Promise<void>;
  send(conversationId: string, outbound: ChannelOutbound): Promise<void>;
  streamReply?(message: ChannelMessage, producer: (update: (snapshot: string) => Promise<void>) => Promise<void>): Promise<void>;
  addReaction?(message: ChannelMessage, emojiType: string): Promise<string>;
  removeReaction?(message: ChannelMessage, reactionId: string): Promise<void>;
  inspectReaction?: ChannelInspectReaction;
  loadRecentHistory?(message: ChannelMessage): Promise<ChannelHistoryMessage[]>;
  readMessage?: ChannelReadMessage;
  download(resource: ChannelResource, message: ChannelMessage, maxBytes?: number): Promise<{ bytes: Uint8Array; mimeType: string }>;
}
