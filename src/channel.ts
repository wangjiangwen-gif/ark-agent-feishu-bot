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
  senderId: string;
  text: string;
  resources: ChannelResource[];
  mentionedBot: boolean;
};

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
  download(resource: ChannelResource, message: ChannelMessage): Promise<{ bytes: Uint8Array; mimeType: string }>;
}
