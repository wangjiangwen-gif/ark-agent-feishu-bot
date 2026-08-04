import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoginFlow } from "../src/login.ts";

test("login reuses the current app and updates Vault plus local OAuth state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arkagent-login-"));
  const configPath = join(dir, "config.env");
  const credentialUpdates: Array<{ vaultId: string; credentialId: string; accessToken: string }> = [];
  let shownUrl = "";
  let invalidations = 0;
  try {
    await writeFile(configPath, [
      'FEISHU_APP_ID="cli-current"',
      'FEISHU_APP_SECRET="secret-current"',
      'FEISHU_USER_OPEN_ID="ou-old"',
      'FEISHU_REFRESH_TOKEN="refresh-old"',
      'FEISHU_ACCESS_TOKEN_EXPIRES_AT="1"'
    ].join("\n") + "\n", { mode: 0o600 });
    const result = await runLoginFlow({
      oauth: {
        begin: async scopes => {
          assert.ok(scopes.includes("offline_access"));
          return { deviceCode: "device-1", verificationUrl: "https://example.com/login", expiresAt: Date.now() + 60_000, intervalMs: 1_000 };
        },
        poll: async () => ({ accessToken: "access-new", refreshToken: "refresh-new", expiresAt: 2_000_000_000_000 }),
        getUserOpenId: async token => { assert.equal(token, "access-new"); return "ou-new"; }
      },
      ark: {
        updateEnvironmentCredential: async (vaultId, credentialId, accessToken) => {
          credentialUpdates.push({ vaultId, credentialId, accessToken });
        }
      },
      vaultId: "vlt-current",
      credentialId: "vcrd-current",
      configPath,
      scopes: ["offline_access", "auth:user.id:read"],
      onAuthorizationReady: device => { shownUrl = device.verificationUrl; },
      invalidateSessions: () => { invalidations++; return 3; }
    });
    assert.equal(shownUrl, "https://example.com/login");
    assert.equal(result.userOpenId, "ou-new");
    assert.equal(result.invalidatedSessions, 3);
    assert.equal(invalidations, 1);
    assert.deepEqual(credentialUpdates, [{ vaultId: "vlt-current", credentialId: "vcrd-current", accessToken: "access-new" }]);
    const content = await readFile(configPath, "utf8");
    assert.match(content, /FEISHU_APP_ID="cli-current"/);
    assert.match(content, /FEISHU_USER_OPEN_ID="ou-new"/);
    assert.match(content, /FEISHU_REFRESH_TOKEN="refresh-new"/);
    assert.match(content, /FEISHU_ACCESS_TOKEN_EXPIRES_AT="2000000000000"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
