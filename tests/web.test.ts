import test from "node:test";
import assert from "node:assert/strict";
import { startEmployeeWeb } from "../src/web.ts";
import { GatewayStore } from "../src/store.ts";
import type { EmployeeConfig } from "../src/config.ts";

test("employee WebUI lists employees and exposes detail tabs by employee id", async () => {
  const store = new GatewayStore(":memory:");
  store.observeEmployeeUser("tenant", "user-1");
  const config: EmployeeConfig = {
    arkApiKey: "secret", arkAgentId: "agent", arkEnvironmentId: "env", arkBaseUrl: "https://example.com",
    arkVaultId: "vault", arkCredentialId: "credential", feishuAppId: "app", feishuAppSecret: "app-secret", feishuBotName: "测试数字员工",
    databasePath: ":memory:", sessionTimeoutMs: 5_000,
    webHost: "127.0.0.1", webPort: 0, webToken: "web-secret"
  };
  const web = await startEmployeeWeb({ store, config, botName: "测试数字员工" });
  const base = web.url.split("/#")[0];
  try {
    assert.equal((await fetch(`${base}/api/employees`)).status, 401);
    const headers = { Authorization: "Bearer web-secret" };
    const employees = await (await fetch(`${base}/api/employees`, { headers })).json() as Array<Record<string, unknown>>;
    assert.equal(employees.length, 1);
    assert.equal(employees[0]?.botName, "测试数字员工");
    assert.equal(employees[0]?.userCount, 1);
    const detail = await (await fetch(`${base}/api/employees/agent`, { headers })).json() as Record<string, unknown>;
    assert.equal(detail.appId, "app");
    const identitiesResponse = await fetch(`${base}/api/employees/agent/identities`, { headers });
    const identitiesText = await identitiesResponse.text();
    const identities = JSON.parse(identitiesText) as Array<Record<string, unknown>>;
    assert.equal(identities[0]?.identityType, "bot");
    assert.equal(identities[0]?.identifier, "app");
    assert.doesNotMatch(identitiesText, /app-secret|web-secret|secret/);
    const users = await (await fetch(`${base}/api/employees/agent/users`, { headers })).json() as unknown[];
    assert.equal(users.length, 1);
    const audit = await (await fetch(`${base}/api/employees/agent/audit`, { headers })).json() as unknown[];
    assert.equal(audit.length, 0);
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /数字员工控制台/);
    assert.match(page, /返回数字员工列表/);
    assert.match(page, />身份</);
    assert.match(page, />行为日志</);
    assert.match(page, />访问过的用户</);
    assert.match(page, /权限由飞书应用可用范围管理/);
  } finally {
    await new Promise<void>(resolve => web.server.close(() => resolve()));
    store.close();
  }
});
