import test from "node:test";
import assert from "node:assert/strict";
import { getConnectedIdentities } from "../src/identities.ts";
import type { EmployeeConfig } from "../src/config.ts";

test("connected identities exposes the Feishu Bot without leaking credentials", () => {
  const config: EmployeeConfig = {
    arkApiKey: "ark-secret", arkAgentId: "agent", arkEnvironmentId: "env", arkBaseUrl: "https://example.com",
    arkVaultId: "vault-12345678", arkCredentialId: "credential-12345678", feishuAppId: "cli_app_id",
    feishuAppSecret: "app-secret", feishuBotName: "财务数字员工", databasePath: ":memory:", sessionTimeoutMs: 5_000,
    webHost: "127.0.0.1", webPort: 0, webToken: "web-secret"
  };

  const identities = getConnectedIdentities(config);
  assert.equal(identities.length, 1);
  assert.equal(identities[0]?.provider, "feishu");
  assert.equal(identities[0]?.identityType, "bot");
  assert.equal(identities[0]?.identifier, "cli_app_id");
  assert.equal(identities[0]?.credentialRef, "cred••••5678");
  assert.ok(identities[0]?.scopes.includes("im:message:send_as_bot"));
  const serialized = JSON.stringify(identities);
  assert.doesNotMatch(serialized, /ark-secret|app-secret|web-secret/);
});
