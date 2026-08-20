import test from "node:test";
import assert from "node:assert/strict";
import { resolveLarkBotScopes, resolveLarkUserScopes } from "../src/scopes.ts";

test("docs and drive domains expand to OAuth and business scopes", () => {
  const scopes = resolveLarkUserScopes("docs, drive");
  assert.deepEqual(scopes, [
    "offline_access", "auth:user.id:read",
    "docx:document", "docx:document:create", "docx:document:readonly", "docx:document:write_only",
    "drive:drive", "drive:file"
  ]);
});

test("bot scopes include message permissions without user OAuth scopes", () => {
  const scopes = resolveLarkBotScopes("docs,drive");
  assert.ok(scopes.includes("im:message:send_as_bot"));
  assert.ok(scopes.includes("im:message.p2p_msg:readonly"));
  assert.ok(scopes.includes("im:message.group_at_msg:readonly"));
  assert.ok(scopes.includes("im:message.group_msg"));
  assert.ok(scopes.includes("im:message.reactions:write_only"));
  assert.ok(scopes.includes("im:message:update"));
  assert.ok(scopes.includes("cardkit:card:write"));
  assert.ok(scopes.includes("cardkit:card:read"));
  assert.ok(scopes.includes("docx:document"));
  assert.equal(scopes.includes("offline_access"), false);
  assert.equal(scopes.includes("auth:user.id:read"), false);
});

test("scope domains are deduplicated and unknown domains fail clearly", () => {
  assert.deepEqual(resolveLarkUserScopes("docs docs"), [
    "offline_access", "auth:user.id:read", "docx:document", "docx:document:create",
    "docx:document:readonly", "docx:document:write_only"
  ]);
  assert.throws(() => resolveLarkUserScopes("calendar"), /暂不支持.*calendar.*docs, drive/);
});
