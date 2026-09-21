import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { collectEmployeeDiagnostics, readLocalSessionEvidence } from "../src/doctor.ts";
import { GatewayStore } from "../src/store.ts";
import { ArkClient } from "../src/ark.ts";

function config(databasePath: string) {
  return { arkApiKey: "API_SECRET", arkAgentId: "agent", arkEnvironmentId: "env", arkBaseUrl: "https://example.invalid", arkVaultId: "vault", arkCredentialId: "credential",
    feishuAppId: "app", feishuAppSecret: "APP_SECRET", feishuBotName: "bot", databasePath, sessionTimeoutMs: 1000, webHost: "127.0.0.1", webPort: 8787, webToken: "WEB_SECRET" };
}

test("doctor reports actual Session metadata without exposing prompt or credentials", async t => {
  const dir = mkdtempSync(join(tmpdir(), "arkagent-doctor-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "gateway.db");
  const store = new GatewayStore(db);
  store.saveSessionConfiguration("session", "old-fingerprint", { requestFingerprint: "hash", environmentId: "old-env", vaultIds: ["vault"], hasSystemOverride: false }); store.close();
  const before = readFileSync(db);
  const calls: string[] = [];
  const report = await collectEmployeeDiagnostics({ config: config(db), configPath: join(dir, "config.env"), sessionConfiguration: { schemaVersion: 1 }, sessionId: "session", version: "0.2.9", executablePath: "/test/cli.js",
    ark: {
      getAgent: async () => { calls.push("agent"); return { id: "agent", version: "9" }; },
      getEnvironmentConfig: async () => { calls.push("environment"); return { type: "cloud", env: { LARKSUITE_CLI_APP_ID: "app", SECRET: "ENV_SECRET" } }; },
      getSessionInfo: async () => { calls.push("session"); return { id: "session", status: "idle", agentId: "agent", agentVersion: "4", environmentId: "old-env", appId: "app", vaultIds: ["vault"], systemFingerprint: "safe-hash" }; }
    }
  });
  assert.equal(report.session?.agentVersion, "4");
  assert.equal(report.agent?.version, "9");
  assert.equal(report.session?.configStatus, "changed_not_applied");
  assert.deepEqual(calls.sort(), ["agent", "environment", "session"]);
  assert.doesNotMatch(JSON.stringify(report), /API_SECRET|APP_SECRET|WEB_SECRET|ENV_SECRET/);
  assert.deepEqual(readFileSync(db), before);
});

test("readonly evidence lookup never creates or migrates a database", t => {
  const dir = mkdtempSync(join(tmpdir(), "arkagent-doctor-missing-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readLocalSessionEvidence(join(dir, "missing.db"), "session"), {});
});

test("doctor fails when group configuration would introduce an unclassified Vault", async () => {
  const report = await collectEmployeeDiagnostics({ config: config(":memory:"), configPath: "/tmp/config.env", sessionConfiguration: { schemaVersion: 1, group: { request: { vault_ids: ["unknown"] } } }, version: "0.2.9", executablePath: "/test/cli.js",
    ark: { getAgent: async () => ({ id: "agent" }), getEnvironmentConfig: async () => ({ type: "cloud", env: { LARKSUITE_CLI_APP_ID: "app" } }), getSessionInfo: async () => { throw new Error("must not be called"); } }
  });
  assert.equal(report.ok, false);
  assert.match(report.warnings.join(" "), /Vault/);
});

test("Ark diagnostic Session reader whitelists metadata and hashes system prompt", async () => {
  const client = new ArkClient("key", "https://example.invalid", async () => new Response(JSON.stringify({ id: "session", status: "idle", agent: { id: "agent", version: 4, system: "PRIVATE_PROMPT" }, environment_id: "env", environment: { config: { env: { LARKSUITE_CLI_APP_ID: "app", ACCESS_TOKEN: "SECRET_TOKEN" } } }, vault_ids: ["vault"] })));
  const result = await client.getSessionInfo("session");
  assert.equal(result.agentVersion, "4");
  assert.equal(result.systemFingerprint?.length, 64);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT|SECRET_TOKEN/);
});

test("version flags work without loading credentials", () => {
  for (const flag of ["-v", "--version"]) {
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "src/cli.ts", flag], { encoding: "utf8" });
    assert.equal(output.trim(), JSON.parse(readFileSync("package.json", "utf8")).version);
  }
});
