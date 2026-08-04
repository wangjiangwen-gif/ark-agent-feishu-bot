import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadConfigFile } from "../src/config.ts";

test("loadConfig reports all missing required values", () => {
  assert.throws(() => loadConfig({}), /ARK_API_KEY.*FEISHU_APP_SECRET/);
});

test("loadConfig applies safe defaults", () => {
  const config = loadConfig({
    ARK_API_KEY: "ark-secret",
    ARK_AGENT_ID: "agent-1",
    ARK_ENVIRONMENT_ID: "env-1",
    ARK_VAULT_ID: "vlt-1",
    ARK_CREDENTIAL_ID: "vcrd-1",
    FEISHU_APP_ID: "cli-1",
    FEISHU_APP_SECRET: "lark-secret",
    FEISHU_USER_OPEN_ID: "ou-1",
    FEISHU_REFRESH_TOKEN: "refresh",
    FEISHU_ACCESS_TOKEN_EXPIRES_AT: "2000000000000"
  });
  assert.equal(config.arkBaseUrl, "https://ark.cn-beijing.volces.com/api/v3");
  assert.equal(config.sessionTimeoutMs, 600_000);
});

test("saved config overrides stale environment values after login", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arkagent-config-"));
  const path = join(dir, "config.env");
  const env: NodeJS.ProcessEnv = { FEISHU_REFRESH_TOKEN: "stale-refresh", FEISHU_ACCESS_TOKEN_EXPIRES_AT: "1" };
  try {
    await writeFile(path, 'FEISHU_REFRESH_TOKEN="fresh-refresh"\nFEISHU_ACCESS_TOKEN_EXPIRES_AT="2000000000000"\n');
    loadConfigFile(path, env);
    assert.equal(env.FEISHU_REFRESH_TOKEN, "fresh-refresh");
    assert.equal(env.FEISHU_ACCESS_TOKEN_EXPIRES_AT, "2000000000000");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
