import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPLOYEE_AGENT_NAME, runEmployeeInit } from "../src/employee-init.ts";

test("employee runtime never mutates the configured user Agent", async () => {
  const source = await readFile(join(process.cwd(), "src/cli.ts"), "utf8");
  const runtime = source.slice(source.indexOf("async function runEmployee"), source.indexOf("async function employeeDoctor"));
  assert.doesNotMatch(runtime, /\.updateAgent\s*\(/);
});

test("employee init creates bot credential without user OAuth", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arkagent-employee-init-"));
  const envPath = join(dir, "config.env");
  let credentialSecretName = "";
  let scopes: string[] = [];
  try {
    const result = await runEmployeeInit({
      askSecret: async () => "ark-secret",
      createArk: () => ({
        createAgent: async config => { assert.equal(config.name, EMPLOYEE_AGENT_NAME); return { id: "agent-employee", name: config.name }; },
        listEnvironments: async () => [], createEnvironment: async name => ({ id: "env-employee", name }),
        listVaults: async () => [], createVault: async () => "vlt-employee", listCredentials: async () => [],
        createEnvironmentVariableCredential: async (_vault, _name, secretName) => { credentialSecretName = secretName; return "vcrd-employee"; },
        updateEnvironmentCredential: async () => undefined
      }),
      createFeishuApp: async inputScopes => { scopes = inputScopes; return { appId: "cli-employee", appSecret: "app-secret" }; },
      envPath, gatewayDatabasePath: join(dir, "gateway.db")
    });
    assert.equal(credentialSecretName, "LARKSUITE_CLI_APP_SECRET");
    assert.ok(scopes.includes("im:message:send_as_bot"));
    assert.ok(scopes.includes("im:message.p2p_msg:readonly"));
    assert.ok(scopes.includes("im:message.group_at_msg:readonly"));
    assert.equal(scopes.includes("offline_access"), false);
    const config = await readFile(envPath, "utf8");
    assert.match(config, /ARKAGENT_MODE="employee"/);
    assert.doesNotMatch(config, /FEISHU_ADMIN_OPEN_ID/);
    assert.doesNotMatch(config, /FEISHU_REFRESH_TOKEN/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
