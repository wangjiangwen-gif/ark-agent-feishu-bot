import test from "node:test";
import assert from "node:assert/strict";
import { FeishuOAuth, type OAuthTokens } from "../src/oauth.ts";

test("refresh exchanges and rotates the refresh token", async () => {
  let body: Record<string, unknown> = {};
  const oauth = new FeishuOAuth("cli-1", "secret", async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 7200 }), { status: 200 });
  });
  const tokens = await oauth.refresh("refresh-1");
  assert.equal(body.grant_type, "refresh_token");
  assert.equal(body.refresh_token, "refresh-1");
  assert.equal(tokens.refreshToken, "refresh-2");
});

test("ensureFresh updates the credential only when token is near expiry", async () => {
  const base: OAuthTokens = { accessToken: "a1", refreshToken: "r1", expiresAt: Date.now() + 60_000 };
  const oauth = new FeishuOAuth("cli-1", "secret", async () => new Response(JSON.stringify({ access_token: "a2", refresh_token: "r2", expires_in: 7200 }), { status: 200 }));
  const updates: string[] = [];
  const fresh = await oauth.ensureFresh(base, async token => { updates.push(token); });
  assert.equal(fresh.accessToken, "a2");
  assert.deepEqual(updates, ["a2"]);
  const unchanged = await oauth.ensureFresh({ ...fresh, expiresAt: Date.now() + 600_000 }, async token => { updates.push(token); });
  assert.equal(unchanged.accessToken, "a2");
  assert.deepEqual(updates, ["a2"]);
});
