import type { EmployeeConfig } from "./config.ts";
import { resolveLarkBotScopes } from "./scopes.ts";

export type ConnectedIdentity = {
  id: string;
  provider: string;
  providerName: string;
  displayName: string;
  identityType: string;
  identityTypeLabel: string;
  status: "configured";
  identifierLabel: string;
  identifier: string;
  authMode: string;
  credentialSource: string;
  credentialRef: string;
  capabilities: string[];
  scopes: string[];
};

export function getConnectedIdentities(config: EmployeeConfig): ConnectedIdentity[] {
  return [{
    id: `feishu-bot:${config.feishuAppId}`,
    provider: "feishu",
    providerName: "飞书",
    displayName: config.feishuBotName,
    identityType: "bot",
    identityTypeLabel: "Bot 身份",
    status: "configured",
    identifierLabel: "App ID",
    identifier: config.feishuAppId,
    authMode: "应用身份（tenant_access_token）",
    credentialSource: "方舟 Vault Credential",
    credentialRef: maskResourceId(config.arkCredentialId),
    capabilities: ["收发消息", "飞书文档", "云空间"],
    scopes: resolveLarkBotScopes("docs,drive")
  }];
}

function maskResourceId(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
