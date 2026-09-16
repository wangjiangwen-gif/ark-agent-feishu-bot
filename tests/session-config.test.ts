import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSessionConfiguration, mergeSessionRequest, selectSessionRequest, finalizeSessionRequest, configFingerprint } from "../src/session-config.ts";

test("session config resolves relative to config.env, not cwd", t => {
  const dir = mkdtempSync(join(tmpdir(), "session-config-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "sessions.json"), JSON.stringify({ schemaVersion: 1, defaults: { request: { title: "测试" } } }));
  const loaded = loadSessionConfiguration("sessions.json", join(dir, "config.env"));
  assert.equal(loaded.path, join(dir, "sessions.json"));
  assert.equal(selectSessionRequest(loaded.config, "direct").title, "测试");
});

test("no config is compatible and schema or typo errors fail at load", t => {
  assert.deepEqual(selectSessionRequest(loadSessionConfiguration(undefined, "/tmp/config.env").config, "group"), {});
  const dir = mkdtempSync(join(tmpdir(), "session-config-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const value of [{ schemaVersion: 2 }, { schemaVersion: 1, defualts: {} }, { schemaVersion: 1, group: { request: { vault_ids: "bad" } } }]) {
    writeFileSync(join(dir, "x.json"), JSON.stringify(value));
    assert.throws(() => loadSessionConfiguration("x.json", join(dir, "config.env")));
  }
});

test("thread inherits group but not direct and retains native unknown fields", () => {
  const config = { schemaVersion: 1 as const,
    defaults: { request: { title: "base", metadata: { a: 1 }, resources: [{ type: "future", id: "base" }] } },
    direct: { request: { title: "direct", private: true } },
    group: { request: { metadata: { b: 2 }, resources: [{ type: "future", id: "group" }] } },
    thread: { request: { title: "thread", metadata: { a: 3 }, future_field: { nested: [1, 2] } } }
  };
  assert.deepEqual(selectSessionRequest(config, "thread"), { title: "thread", metadata: { a: 3, b: 2 }, resources: [{ type: "future", id: "group" }], future_field: { nested: [1, 2] } });
});

test("environment aliases normalize without mixing configs from different resources", () => {
  assert.deepEqual(mergeSessionRequest({ environment: { id: "old", type: "environment_with_overrides", config: { type: "cloud", env: { OLD: "1" } } } }, { environment_id: "new" }), { environment_id: "new" });
  assert.throws(() => mergeSessionRequest({}, { environment_id: "x", environment: { id: "y", type: "environment_with_overrides" } }), /environment/);
});

test("explicit empty objects retain native clearing semantics", () => {
  const output = mergeSessionRequest({ environment: { id: "env", type: "environment_with_overrides", config: { type: "cloud", tos: { bucket: "old", prefix: "old/" } } } },
    { environment: { config: { tos: {} } } });
  assert.deepEqual((output.environment as any).config.tos, {});
});

const policy = { agentId: "agent", requiredVaultIds: ["bot"], mandatoryEnv: { FEISHU_IDENTITY_MODE: "bot_only" }, sharedGroup: true, applicationVaultIds: ["extra"], knownUserVaultIds: ["user"], appId: "app" };
const request = () => ({ agent: "agent", environment: { id: "env", type: "environment_with_overrides", config: { type: "cloud", env: {} } } });

test("mandatory resources and vaults survive developer replacement and deduplicate", () => {
  const file = { type: "file", file_id: "file", mount_path: "/mnt/data/a" };
  const output = finalizeSessionRequest({ ...request(), vault_ids: ["extra"], resources: [file], future_flag: true }, { ...policy, resources: [file] });
  assert.deepEqual(output.vault_ids, ["bot", "extra"]);
  assert.deepEqual(output.resources, [file]);
  assert.equal(output.future_flag, true);
  assert.equal(output.environment?.config?.env?.LARKSUITE_CLI_APP_ID, "app");
});

test("group refuses user vaults even when falsely classified as application", () => {
  for (const id of ["user", "unknown"]) assert.throws(() => finalizeSessionRequest({ ...request(), vault_ids: [id] }, { ...policy, applicationVaultIds: ["extra", "user"] }), /Vault/);
});

test("protected identity, app and agent conflicts fail instead of being overwritten", () => {
  assert.throws(() => finalizeSessionRequest({ ...request(), agent: "other" }, policy), /Agent/);
  for (const env of [{ LARKSUITE_CLI_APP_ID: "other" }, { FEISHU_IDENTITY_MODE: "user" }, { LARKSUITE_CLI_STRICT_MODE: "off" }, { LARKSUITE_CLI_USER_ACCESS_TOKEN: "secret" }, { FEISHU_USER_OPEN_ID: "first-user" }]) {
    assert.throws(() => finalizeSessionRequest({ ...request(), environment: { ...request().environment, config: { type: "cloud", env } } }, policy));
  }
});

test("same Agent native version and overrides are retained, not overwritten", () => {
  const agent = { type: "agent_with_overrides", id: "agent", version: 3, system: "developer prompt", skills: [], future: { x: true } };
  assert.deepEqual(finalizeSessionRequest({ ...request(), agent }, policy).agent, agent);
});

test("different resources at a normalized mount path fail", () => {
  assert.throws(() => finalizeSessionRequest({ ...request(), resources: [{ type: "file", file_id: "a", mount_path: "/mnt/data/a" }, { type: "file", file_id: "b", mount_path: "/mnt/data/./a" }] }, policy), /挂载路径/);
});

test("prototype keys are rejected at any depth and fingerprint is order independent", () => {
  assert.throws(() => mergeSessionRequest({}, JSON.parse('{"metadata":{"__proto__":{"x":1}}}')), /不允许/);
  assert.equal(configFingerprint({ b: 2, a: { d: 4, c: 3 } }), configFingerprint({ a: { c: 3, d: 4 }, b: 2 }));
});
