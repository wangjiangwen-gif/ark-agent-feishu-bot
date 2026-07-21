import test from "node:test";
import assert from "node:assert/strict";
import { resolveLarkUserScopes } from "../src/scopes.ts";

test("docs and drive domains expand to OAuth and business scopes", () => {
  const scopes = resolveLarkUserScopes("docs, drive");
  assert.deepEqual(scopes, [
    "offline_access", "auth:user.id:read",
    "docx:document", "docx:document:create", "docx:document:readonly", "docx:document:write_only",
    "drive:drive", "drive:file"
  ]);
});

test("scope domains are deduplicated and unknown domains fail clearly", () => {
  assert.deepEqual(resolveLarkUserScopes("docs docs"), [
    "offline_access", "auth:user.id:read", "docx:document", "docx:document:create",
    "docx:document:readonly", "docx:document:write_only"
  ]);
  assert.throws(() => resolveLarkUserScopes("calendar"), /暂不支持.*calendar.*docs, drive/);
});
