import type { ChannelMessage } from "./channel.ts";
import type { CredentialIdentity } from "./credential-state.ts";

// 仅保存绑定证据，不能包含Token、授权链接或用户请求正文。
export type PreparedAuthorization = {
  version: 1; identity: CredentialIdentity; generation: string;
  vaultId: string; credentialId: string; flowId: string | null;
};
export type UserCredentialLifecycle = {
  revision: string;
  prepare: (message: ChannelMessage) => Promise<PreparedAuthorization>;
  refresh: (message: ChannelMessage, expected: PreparedAuthorization) => Promise<void>;
  matches: (message: ChannelMessage, expected: PreparedAuthorization, forDispatch?: boolean) => boolean;
};

export function validatePreparedAuthorization(value: unknown): asserts value is PreparedAuthorization {
  const exact = (item: unknown, keys: string[]): item is Record<string, unknown> => Boolean(item && typeof item === "object"
    && !Array.isArray(item) && Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key)));
  const id = (item: unknown) => typeof item === "string" && item.length > 0 && Buffer.byteLength(item) <= 256 && !/[\s\x00-\x1f\x7f]/.test(item);
  const uuid = (item: unknown) => typeof item === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(item);
  if (!exact(value, ["version", "identity", "generation", "vaultId", "credentialId", "flowId"]) || value.version !== 1
    || !exact(value.identity, ["channelType", "installationId", "tenantId", "openId"])
    || !Object.values(value.identity).every(id) || !id(value.vaultId) || !id(value.credentialId)
    || !uuid(value.generation) || !(value.flowId === null || uuid(value.flowId))) {
    throw new Error("用户授权准备证明无效，未继续执行");
  }
}
