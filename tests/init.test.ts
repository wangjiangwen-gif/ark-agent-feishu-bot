import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFICE_AGENT_NAME, runGuidedInit, serializeEnv } from "../src/init.ts";

test("guided init reuses an environment with the stable name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ark-feishu-init-"));
  const envPath = join(dir, ".env");
    const answers = ["ark-feishu-agent-1"];
  let creates = 0;
  let agentCreates = 0;
  try {
    const result = await runGuidedInit({
      ask: async () => answers.shift() || "",
      askSecret: async label => label.includes("方舟") ? "ark-secret" : "feishu-secret",
      createFeishuApp: async () => ({ appId: "cli-1", appSecret: "feishu-secret" }),
      authorizeUser: async () => ({ tokens: { accessToken: "uat", refreshToken: "refresh", expiresAt: 2_000_000_000_000 }, userOpenId: "ou-user" }),
      createArk: () => ({
        createAgent: async config => { agentCreates++; assert.equal(config.name, OFFICE_AGENT_NAME); return { id: "agent-1", name: config.name, version: "1" }; },
        listEnvironments: async () => [{ id: "env-existing", name: "ark-feishu-agent-1" }],
        createEnvironment: async name => { creates++; return { id: "env-new", name }; },
        listVaults: async () => [{ id: "vlt-1", displayName: "ark-feishu-agent-1-ou-user" }],
        createVault: async () => "vlt-new",
        listCredentials: async () => [{ id: "vcrd-1", displayName: "lark-cli-user-access-token", authType: "environment_variable" }],
        createEnvironmentCredential: async () => "vcrd-new",
        updateEnvironmentCredential: async () => undefined
      }),
      envPath
    });
    assert.equal(result.environmentId, "env-existing");
    assert.equal(result.agentId, "agent-1");
    assert.equal(result.environmentCreated, false);
    assert.equal(creates, 0);
    assert.equal(agentCreates, 1);
    const content = await readFile(envPath, "utf8");
    assert.match(content, /ARK_ENVIRONMENT_ID="env-existing"/);
    assert.match(content, /FEISHU_APP_SECRET="feishu-secret"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("guided init creates an environment when no stable match exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ark-feishu-init-"));
  const envPath = join(dir, ".env");
    const answers = ["ark-feishu-agent-2-cli-2"];
  try {
    const result = await runGuidedInit({
      ask: async () => answers.shift() || "",
      askSecret: async label => label.includes("方舟") ? "ark-secret" : "feishu-secret",
      createFeishuApp: async () => ({ appId: "cli-2", appSecret: "feishu-secret" }),
      authorizeUser: async () => ({ tokens: { accessToken: "uat", refreshToken: "refresh", expiresAt: 2_000_000_000_000 }, userOpenId: "ou-user" }),
      createArk: () => ({
        createAgent: async config => ({ id: "agent-2", name: config.name, version: "1" }),
        listEnvironments: async () => [],
        createEnvironment: async name => ({ id: "env-new", name }),
        listVaults: async () => [],
        createVault: async () => "vlt-new",
        listCredentials: async () => [],
        createEnvironmentCredential: async () => "vcrd-new",
        updateEnvironmentCredential: async () => undefined
      }),
      envPath
    });
    assert.equal(result.environmentId, "env-new");
    assert.equal(result.agentId, "agent-2");
    assert.equal(result.environmentCreated, true);
    const content = await readFile(envPath, "utf8");
    assert.match(content, /LARK_CLI_DOMAINS="docs,drive"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("serializeEnv quotes values instead of emitting executable shell syntax", () => {
  assert.equal(serializeEnv({ TOKEN: "a b#c" }), 'TOKEN="a b#c"\n');
});
