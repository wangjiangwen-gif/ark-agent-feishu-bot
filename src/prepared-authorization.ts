import type { ChannelMessage } from "./channel.ts";
import type { CredentialIdentity } from "./credential-state.ts";

// 仅保存绑定证据，不能包含Token、授权链接或用户请求正文。
export type PreparedAuthorization = {
  version: 1; identity: CredentialIdentity; generation: string;
  vaultId: string; credentialId: string; flowId: string | null;
};
export type UserCredentialPreparationIntent = {
  version: 1; identity: CredentialIdentity; flowId: string | null;
} & ({ kind: "bound"; authorization: PreparedAuthorization } | { kind: "provisioning"; operationId: string });
export type UserCredentialLifecycle = {
  revision: string;
  prepare: (message: ChannelMessage, intent?: UserCredentialPreparationIntent) => Promise<PreparedAuthorization>;
  capture?: (message: ChannelMessage) => UserCredentialPreparationIntent;
  recover?: (message: ChannelMessage, intent: UserCredentialPreparationIntent) => Promise<PreparedAuthorization>;
  matchesIntent?: (message: ChannelMessage, intent: UserCredentialPreparationIntent) => boolean;
  refresh: (message: ChannelMessage, expected: PreparedAuthorization) => Promise<void>;
  matches: (message: ChannelMessage, expected: PreparedAuthorization, forDispatch?: boolean) => boolean;
};

export function validatePreparedAuthorization(value: unknown): asserts value is PreparedAuthorization {
  if (!exact(value, ["version", "identity", "generation", "vaultId", "credentialId", "flowId"]) || value.version !== 1
    || !exact(value.identity, ["channelType", "installationId", "tenantId", "openId"])
    || !Object.values(value.identity).every(id) || !id(value.vaultId) || !id(value.credentialId)
    || !uuid(value.generation) || !(value.flowId === null || uuid(value.flowId))) {
    throw new Error("用户授权准备证明无效，未继续执行");
  }
}

export function validateUserCredentialPreparationIntent(value: unknown): asserts value is UserCredentialPreparationIntent {
  const common = ["version", "identity", "flowId", "kind"];
  if (!(exact(value, [...common, "authorization"]) && value.kind === "bound")
    && !(exact(value, [...common, "operationId"]) && value.kind === "provisioning")) throw invalidIntent();
  if (value.version !== 1 || !exact(value.identity, ["channelType", "installationId", "tenantId", "openId"])
    || !Object.values(value.identity).every(id) || !(value.flowId === null || uuid(value.flowId))) throw invalidIntent();
  if (value.kind === "bound") {
    validatePreparedAuthorization(value.authorization);
    if (!sameIdentity(value.identity as CredentialIdentity, value.authorization.identity)
      || value.flowId !== value.authorization.flowId) throw invalidIntent();
  } else if (!uuid(value.operationId)) throw invalidIntent();
}

export function validateUserCredentialPreparationResult(intent: UserCredentialPreparationIntent, value: unknown): asserts value is PreparedAuthorization {
  validateUserCredentialPreparationIntent(intent); validatePreparedAuthorization(value);
  if (!sameIdentity(intent.identity, value.identity) || intent.flowId !== value.flowId
    || (intent.kind === "bound" && (intent.authorization.generation !== value.generation
      || intent.authorization.vaultId !== value.vaultId || intent.authorization.credentialId !== value.credentialId))) throw invalidIntent();
}

function sameIdentity(left: CredentialIdentity, right: CredentialIdentity): boolean {
  return left.channelType === right.channelType && left.installationId === right.installationId
    && left.tenantId === right.tenantId && left.openId === right.openId;
}
function id(item: unknown): item is string {
  return typeof item === "string" && item.length > 0 && Buffer.byteLength(item) <= 256 && !/[\s\x00-\x1f\x7f]/.test(item);
}
function uuid(item: unknown): item is string {
  return typeof item === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(item);
}
function exact(item: unknown, keys: string[]): item is Record<string, unknown> {
  if (!item || typeof item !== "object" || Array.isArray(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
  const fields = Object.getOwnPropertyDescriptors(item);
  return Reflect.ownKeys(item).length === keys.length
    && keys.every(key => fields[key]?.enumerable && Object.hasOwn(fields[key], "value"));
}
function invalidIntent(): Error { return new Error("用户凭证准备意图或结果不一致，未继续执行"); }
