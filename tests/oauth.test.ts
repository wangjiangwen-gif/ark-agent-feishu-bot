import test from "node:test";
import assert from "node:assert/strict";
import { FeishuOAuth, OAuthError, type OAuthTokens } from "../src/oauth.ts";
import { setImmediate as flush } from "node:timers/promises";

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

test("OAuth errors retain safe structured categories instead of arbitrary upstream descriptions", async () => {
  for (const [payload, status, kind] of [
    [{ error: "invalid_grant", error_description: "secret-should-not-appear" }, 400, "reauth_required"],
    [{ error: "invalid_client", msg: "secret-should-not-appear" }, 401, "configuration"],
    [{ error: "invalid_scope" }, 400, "permission"],
    [{ error: "something_unrecognized", msg: "secret-should-not-appear" }, 403, "unknown"],
    [{}, 429, "rate_limit"], [{}, 503, "upstream"]
  ] as const) {
    const oauth = new FeishuOAuth("cli", "secret", async () => new Response(JSON.stringify(payload), { status }));
    await assert.rejects(oauth.refresh("r"), error => {
      assert.ok(error instanceof OAuthError);
      assert.equal(error.kind, kind);
      assert.equal(error.message.includes("secret-should-not-appear"), false);
      assert.equal(JSON.stringify(error).includes("secret-should-not-appear"), false);
      return true;
    });
  }
});

test("refresh network failure is uncertain and is not silently retried", async () => {
  let calls = 0;
  const oauth = new FeishuOAuth("cli", "secret", async () => { calls++; throw new Error("secret-network-request"); });
  await assert.rejects(oauth.refresh("r"), error => error instanceof OAuthError && error.kind === "network" && error.outcome === "unknown");
  assert.equal(calls, 1);
});

test("malformed successful refresh response is uncertain rather than missing authorization", async () => {
  const oauth = new FeishuOAuth("cli", "secret", async () => new Response("not-json", { status: 200 }));
  await assert.rejects(oauth.refresh("r"), error => error instanceof OAuthError && error.kind === "invalid_response" && error.outcome === "unknown");
});

test("official refresh errors distinguish client mismatch, revoked token and application availability", async () => {
  for (const [code, kind] of [[20024, "configuration"], [20026, "reauth_required"], [20037, "reauth_required"],
    [20064, "reauth_required"], [20073, "reauth_required"], [20010, "permission"], [20074, "configuration"], [20068, "permission"]] as const) {
    const oauth = new FeishuOAuth("cli", "secret", async () => new Response(JSON.stringify({ code, error: "invalid_grant" }), { status: 400 }));
    await assert.rejects(oauth.refresh("r"), error => error instanceof OAuthError && error.kind === kind && error.code === code);
  }
});

test("rotated refresh token and actual expiry are required instead of reusing stale defaults", async () => {
  for (const payload of [{ access_token: "a", expires_in: 7200 }, { access_token: "a", refresh_token: "r" },
    { access_token: "a", refresh_token: "r", expires_in: 0 }]) {
    const oauth = new FeishuOAuth("cli", "secret", async () => new Response(JSON.stringify(payload)));
    await assert.rejects(oauth.refresh("old"), error => error instanceof OAuthError && error.kind === "invalid_response");
  }
});

test("slow_down retains its safe OAuth symbol alongside a numeric error code", async () => {
  const oauth = new FeishuOAuth("cli", "secret", async () => new Response(JSON.stringify({ code: 999999, error: "slow_down" }), { status: 400 }));
  await assert.rejects(oauth.refresh("test"), error => error instanceof OAuthError && error.kind === "pending"
    && error.code === 999999 && error.oauthType === "slow_down");
});

test("device polling respects slow_down even when the server also supplies a numeric code", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const calls: number[] = [];
  const oauth = new FeishuOAuth("cli", "secret", async () => {
    calls.push(Date.now());
    return calls.length === 1
      ? new Response(JSON.stringify({ code: 999999, error: "slow_down" }), { status: 400 })
      : new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 7200 }));
  });
  const pending = oauth.poll({ deviceCode: "test", verificationUrl: "https://example.test", expiresAt: 30_000, intervalMs: 1_000 });
  await flush();
  t.mock.timers.tick(5_999); await flush();
  assert.deepEqual(calls, [10_000]);
  t.mock.timers.tick(1); await pending;
  assert.deepEqual(calls, [10_000, 16_000]);
});
