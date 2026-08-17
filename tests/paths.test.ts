import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { getArkagentPaths, getEmployeePaths } from "../src/paths.ts";

test("arkagent paths use a stable user-level directory override", () => {
  const paths = getArkagentPaths({ ARKAGENT_HOME: "./tmp/arkagent-home" });
  assert.equal(paths.stateDir, resolve("./tmp/arkagent-home"));
  assert.equal(paths.configPath, resolve("./tmp/arkagent-home/config.env"));
  assert.equal(paths.databasePath, resolve("./tmp/arkagent-home/gateway.db"));
});

test("employee mode uses an isolated state directory", () => {
  const paths = getEmployeePaths({ ARKAGENT_HOME: "./tmp/arkagent-home" });
  assert.equal(paths.stateDir, resolve("./tmp/arkagent-home/employee"));
  assert.equal(paths.configPath, resolve("./tmp/arkagent-home/employee/config.env"));
});
