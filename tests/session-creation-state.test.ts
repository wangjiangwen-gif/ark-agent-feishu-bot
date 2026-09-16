import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import type { ChannelMessage } from "../src/channel.ts";
import { GatewayStore, type ConversationKey } from "../src/store.ts";
import { configFingerprint } from "../src/session-config.ts";

const source = (): ChannelMessage => ({ channelType: "lark", installationId: "app", tenantId: "tenant",
  conversationId: "chat", conversationType: "direct", senderId: "user", threadId: "", rootMessageId: "", parentMessageId: "",
  eventId: "event", messageId: "message", createTime: 100, text: "PRIVATE_SOURCE_TEXT", resources: [], mentionedBot: false });
function input() {
  const message = source();
  const key: ConversationKey = { channelType: message.channelType, installationId: message.installationId, tenantId: message.tenantId,
    conversationId: message.conversationId, threadId: message.threadId, senderId: message.senderId };
  return { message, key, agentId: "agent", configFingerprint: "config", reusable: true,
    request: { agent: { id: "agent", type: "agent_reference", version: "3" }, environment_id: "environment", vault_ids: ["vault"],
      tags: [{ key: "existing", value: "retained" }], environment_secret: "PRIVATE_REQUEST_SECRET",
      resources: [{ type: "file", file_id: "file", mount_path: "file.pdf" }] },
    mounts: [{ key: "a".repeat(64), details: { fileId: "file", name: "file.pdf", mountPath: "file.pdf", bytes: 4, sha256: "b".repeat(64) } },
      { key: "c".repeat(64), details: { inlineText: "PRIVATE_INLINE_TEXT", name: "text.md", mountPath: "text.md", bytes: 19 } }] };
}
function database(store: GatewayStore): DatabaseSync { return (store as unknown as { db: DatabaseSync }).db; }

test("creation intent adds immutable correlation tags without mutating the request or dispatching work", () => {
  const store = new GatewayStore(":memory:");
  try {
    const value = input(), original = structuredClone(value), started = store.beginSessionCreation(value);
    assert.deepEqual(value, original);
    assert.equal(started.requestFingerprint, configFingerprint(original.request));
    assert.deepEqual(started.request.tags, [...original.request.tags,
      { key: "arkagent_create_operation", value: started.operationId },
      { key: "arkagent_create_request", value: started.requestFingerprint }]);
    assert.equal(started.state, "pending"); assert.equal(started.revision, 1);
    assert.equal(store.getSession(value.key), undefined);
    assert.equal(store.attachmentTrace.list(value.message).items[0].status, "pending");
    assert.equal(started.mounts.filter(mount => mount.intentId).length, 1);
    started.request.environment_secret = "changed";
    assert.equal(store.sessionCreations.pending(store.conversationKey(value.key))!.request.environment_secret, "PRIVATE_REQUEST_SECRET");
  } finally { store.close(); }
});

test("pending creation survives restart encrypted and blocks duplicate or changed-config creation", () => {
  const directory = mkdtempSync(join(tmpdir(), "ark-create-state-")), path = join(directory, "gateway.db");
  let store = new GatewayStore(path);
  try {
    const original = store.beginSessionCreation(input()); store.close();
    for (const secret of ["PRIVATE_SOURCE_TEXT", "PRIVATE_REQUEST_SECRET", "PRIVATE_INLINE_TEXT"]) {
      assert.equal(readFileSync(path).includes(Buffer.from(secret)), false);
    }
    store = new GatewayStore(path);
    assert.deepEqual(store.sessionCreations.pending(original.scope), original);
    for (const changed of [{}, { agentId: "other", request: { ...input().request, agent: "other" } }, { configFingerprint: "changed" }]) {
      assert.throws(() => store.beginSessionCreation({ ...input(), ...changed }), /创建.*待核实|创建.*未确认/);
    }
    store.resetSession(input().key); store.resetAllSessions();
    assert.deepEqual(store.sessionCreations.pending(original.scope), original);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("confirmed Session, configuration, compaction and all mount receipts commit together", () => {
  const store = new GatewayStore(":memory:");
  try {
    const started = store.beginSessionCreation(input()), confirmed = store.confirmSessionCreation(started, "session");
    assert.equal(confirmed.state, "confirmed"); assert.equal(confirmed.sessionId, "session"); assert.equal(confirmed.revision, 2);
    assert.equal(store.sessionCreations.pending(started.scope), undefined);
    assert.deepEqual(store.sessionCreations.get(started.operationId), confirmed);
    assert.equal(store.getSession(input().key), "session");
    assert.equal(store.getSessionConfiguration("session")!.fingerprint, "config");
    assert.equal(store.getSessionConfiguration("session")!.metadata.requestFingerprint, configFingerprint(started.request));
    assert.equal(store.getCompactionCheckpoint("session")!.baselineEventCount, 0);
    assert.equal(store.attachmentTrace.list(input().message).items[0].status, "succeeded");
    for (const mount of started.mounts) assert.equal(store.isAttachmentMounted("session", mount.key), Boolean(mount.details.fileId));
    assert.deepEqual(store.confirmSessionCreation(started, "session"), confirmed);
    assert.deepEqual(store.confirmSessionCreation(confirmed, "session"), confirmed);
    assert.throws(() => store.confirmSessionCreation(started, "other"), /创建|Session/);
  } finally { store.close(); }
});

for (const failure of ["saveSessionConfiguration", "markAttachmentMounted"] as const)
test(`confirmation failure in ${failure} rolls back every local receipt and keeps creation frozen`, () => {
  const store = new GatewayStore(":memory:");
  try {
    const started = store.beginSessionCreation(input()), original = store[failure];
    store[failure] = (() => { throw new Error("injected local write failure"); }) as typeof original;
    assert.throws(() => store.confirmSessionCreation(started, "session"), /injected/);
    store[failure] = original;
    assert.deepEqual(store.sessionCreations.pending(started.scope), started);
    assert.equal(store.getSession(input().key), undefined);
    assert.equal(store.getSessionConfiguration("session"), undefined);
    assert.equal(store.getCompactionCheckpoint("session"), undefined);
    assert.equal(store.attachmentTrace.list(input().message).items[0].status, "pending");
    for (const mount of started.mounts) assert.equal(store.isAttachmentMounted("session", mount.key), false);
    assert.throws(() => store.beginSessionCreation(input()), /创建/);
    assert.equal(store.confirmSessionCreation(started, "session").state, "confirmed");
  } finally { store.close(); }
});

test("begin failure rolls back pending mounts and creation journal", () => {
  const store = new GatewayStore(":memory:");
  try {
    const original = store.attachmentTrace.begin;
    let started = 0;
    store.attachmentTrace.begin = (...args) => {
      if (++started === 2) throw new Error("injected mount intent failure");
      return original.apply(store.attachmentTrace, args);
    };
    const value = input();
    value.mounts.push({ key: "d".repeat(64), details: { fileId: "other-file", name: "other.pdf", mountPath: "other.pdf", bytes: 2 } });
    value.request.resources.push({ type: "file", file_id: "other-file", mount_path: "other.pdf" });
    assert.throws(() => store.beginSessionCreation(value), /injected/);
    store.attachmentTrace.begin = original;
    assert.equal(store.sessionCreations.pending(store.conversationKey(input().key)), undefined);
    assert.equal(store.attachmentTrace.list(input().message).items.length, 0);
    assert.equal(store.beginSessionCreation(input()).state, "pending");
  } finally { store.close(); }
});

for (const tags of [undefined, [], [{ key: "custom", value: "kept" }]])
test(`creation preserves the original fingerprint for ${tags === undefined ? "absent" : tags.length ? "existing" : "empty"} tags`, () => {
  const store = new GatewayStore(":memory:");
  try {
    const value = input();
    if (tags === undefined) delete (value.request as { tags?: unknown }).tags;
    else value.request.tags = tags;
    const started = store.beginSessionCreation(value);
    assert.equal(started.requestFingerprint, configFingerprint(value.request));
    assert.deepEqual(store.sessionCreations.get(started.operationId), started);
    assert.equal(store.confirmSessionCreation(started, "session").state, "confirmed");
  } finally { store.close(); }
});

test("separate stores coordinate pending creation without requiring the durable runtime lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "ark-create-stores-")), path = join(directory, "gateway.db");
  const first = new GatewayStore(path), second = new GatewayStore(path);
  try {
    const started = first.beginSessionCreation(input());
    assert.throws(() => second.beginSessionCreation(input()), /创建/);
    const observed = second.sessionCreations.pending(started.scope)!;
    const confirmed = second.confirmSessionCreation(observed, "session");
    assert.deepEqual(first.confirmSessionCreation(started, "session"), confirmed);
    assert.equal(first.attachmentTrace.list(input().message).items.length, 1);
  } finally { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("pending creation remains frozen after its process exits without closing the database", () => {
  const directory = mkdtempSync(join(tmpdir(), "ark-create-exit-")), path = join(directory, "gateway.db");
  try {
    execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
      `import { GatewayStore } from './src/store.ts'; const store = new GatewayStore(${JSON.stringify(path)}); store.beginSessionCreation(${JSON.stringify(input())}); process.exit(0);`],
    { stdio: "pipe" });
    const store = new GatewayStore(path);
    try {
      const pending = store.sessionCreations.pending(store.conversationKey(input().key))!;
      assert.equal(pending.state, "pending");
      assert.equal(store.attachmentTrace.list(input().message).items[0].status, "pending");
      assert.throws(() => store.beginSessionCreation(input()), /创建/);
      assert.equal(store.confirmSessionCreation(pending, "found-session").sessionId, "found-session");
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("altered plaintext mount evidence cannot be confirmed by an authenticated creation intent", () => {
  const store = new GatewayStore(":memory:");
  try {
    const started = store.beginSessionCreation(input());
    database(store).prepare("UPDATE attachment_stage_receipts SET attachment_key=? WHERE id=?")
      .run("d".repeat(64), started.mounts[0].intentId!);
    assert.throws(() => store.confirmSessionCreation(started, "session"), /附件意图/);
    assert.deepEqual(store.sessionCreations.pending(started.scope), started);
    assert.equal(store.getSession(input().key), undefined);
    assert.equal(store.getSessionConfiguration("session"), undefined);
  } finally { store.close(); }
});

test("confirmation rejects replacing an existing conversation without destroying the pending receipt", () => {
  const store = new GatewayStore(":memory:");
  try {
    const started = store.beginSessionCreation(input());
    store.saveSession(input().key, "existing", "agent");
    assert.throws(() => store.confirmSessionCreation(started, "session"), /会话|Session/);
    assert.equal(store.getSession(input().key), "existing");
    assert.deepEqual(store.sessionCreations.pending(started.scope), started);
  } finally { store.close(); }
});

test("isolated creation never replaces conversation mapping and confirmed history permits explicit new creation", () => {
  const store = new GatewayStore(":memory:");
  try {
    store.saveSession(input().key, "existing", "agent");
    const isolated = store.beginSessionCreation({ ...input(), reusable: false });
    store.confirmSessionCreation(isolated, "isolated");
    assert.equal(store.getSession(input().key), "existing");
    store.resetSession(input().key);
    const next = store.beginSessionCreation(input());
    assert.notEqual(next.operationId, isolated.operationId);
    store.confirmSessionCreation(next, "new-session");
    assert.equal(store.getSession(input().key), "new-session");
    store.resetSession(input().key);
    store.confirmSessionCreation(next, "new-session");
    assert.equal(store.getSession(input().key), undefined, "幂等确认不能把已显式重置的旧会话重新绑回");
  } finally { store.close(); }
});

test("isolated messages create independent pending scopes while a duplicate message remains frozen", () => {
  const store = new GatewayStore(":memory:");
  try {
    const firstInput = { ...input(), reusable: false }, first = store.beginSessionCreation(firstInput);
    const secondInput = { ...input(), reusable: false };
    secondInput.message.messageId = "other-message";
    const second = store.beginSessionCreation(secondInput);
    assert.notEqual(first.scope, second.scope);
    assert.equal(first.scope, store.sessionCreationScope(firstInput.key, false, firstInput.message.messageId));
    assert.deepEqual(store.sessionCreations.pending(first.scope), first);
    assert.deepEqual(store.sessionCreations.pending(second.scope), second);
    assert.throws(() => store.beginSessionCreation(firstInput), /创建/);
    assert.throws(() => store.beginSessionCreation({ ...firstInput, configFingerprint: "changed" }), /创建/);
    assert.equal(store.getSession(firstInput.key), undefined);
  } finally { store.close(); }
});

test("isolated confirmed receipt survives restart and remains reusable without rebinding the conversation", () => {
  const directory = mkdtempSync(join(tmpdir(), "ark-isolated-create-")), path = join(directory, "gateway.db");
  let store = new GatewayStore(path);
  try {
    const value = { ...input(), reusable: false }, started = store.beginSessionCreation(value);
    const confirmed = store.confirmSessionCreation(started, "isolated-session");
    store.close(); store = new GatewayStore(path);
    const scope = store.sessionCreationScope(value.key, false, value.message.messageId);
    assert.equal(store.sessionCreations.pending(scope), undefined);
    assert.deepEqual(store.sessionCreations.latest(scope), confirmed);
    assert.deepEqual(store.confirmSessionCreation(store.sessionCreations.latest(scope)!, "isolated-session"), confirmed);
    assert.equal(store.getSession(value.key), undefined);
    assert.equal(store.attachmentTrace.list(value.message).items.length, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("latest creation returns the newest shared-scope receipt and does not confuse similarly delimited message IDs", () => {
  const store = new GatewayStore(":memory:");
  try {
    const first = store.beginSessionCreation(input());
    assert.deepEqual(store.sessionCreations.latest(first.scope), first);
    store.confirmSessionCreation(first, "first-session"); store.resetSession(input().key);
    const next = store.beginSessionCreation(input());
    assert.deepEqual(store.sessionCreations.latest(first.scope), next);
    assert.equal(store.sessionCreationScope(input().key, true, "any-message"), store.conversationKey(input().key));
    assert.notEqual(store.sessionCreationScope(input().key, false, "a:b"), store.sessionCreationScope(input().key, false, "a%3Ab"));
    assert.notEqual(store.sessionCreationScope(input().key, false, "a\"],[\"b"), store.sessionCreationScope(input().key, true, "a\"],[\"b"));
  } finally { store.close(); }
});

for (const field of ["channelType", "installationId", "tenantId", "conversationId", "threadId", "senderId"] as const)
test(`pending creation isolation includes ${field}`, () => {
  const store = new GatewayStore(":memory:");
  try {
    const first = store.beginSessionCreation(input()), other = input();
    other.key[field] = "other"; other.message[field] = "other";
    const second = store.beginSessionCreation(other);
    assert.notEqual(first.scope, second.scope);
  } finally { store.close(); }
});

test("shared group sender scope still freezes creation from another group member", () => {
  const store = new GatewayStore(":memory:");
  try {
    const first = input(); first.message.conversationType = "group"; first.key.senderId = "";
    store.beginSessionCreation(first);
    const second = structuredClone(first); second.message.senderId = "other-user";
    assert.throws(() => store.beginSessionCreation(second), /创建/);
  } finally { store.close(); }
});

for (const tag of ["arkagent_create_operation", "arkagent_create_request"])
test(`reserved creation tag ${tag} is rejected rather than overwritten`, () => {
  const store = new GatewayStore(":memory:");
  try {
    const value = input(); value.request.tags.push({ key: tag, value: "existing" });
    assert.throws(() => store.beginSessionCreation(value), /标签|tag/);
    assert.equal(store.sessionCreations.pending(store.conversationKey(value.key)), undefined);
    assert.equal(store.attachmentTrace.list(value.message).items.length, 0);
  } finally { store.close(); }
});

test("expected creation snapshot is immutable and stale revision or modified bindings cannot confirm", () => {
  const store = new GatewayStore(":memory:");
  try {
    const started = store.beginSessionCreation(input());
    for (const patch of [{ revision: 0 }, { scope: "other" }, { agentId: "other" }, { configFingerprint: "other" },
      { requestFingerprint: "0".repeat(64) }, { reusable: false }, { mounts: [] },
      { message: { ...started.message, senderId: "other" } }, { request: { ...started.request, title: "changed" } }]) {
      assert.throws(() => store.confirmSessionCreation({ ...started, ...patch }, "session"), /创建|绑定|版本|结构/);
    }
    assert.deepEqual(store.sessionCreations.pending(started.scope), started);
  } finally { store.close(); }
});

test("plaintext journal metadata is authenticated and cannot be retargeted", () => {
  const store = new GatewayStore(":memory:");
  try {
    const started = store.beginSessionCreation(input());
    database(store).prepare("UPDATE gateway_session_creations SET config_fingerprint='other' WHERE operation_id=?").run(started.operationId);
    assert.throws(() => store.sessionCreations.get(started.operationId), /解密|创建/);
  } finally { store.close(); }
});

test("missing encryption key cannot be regenerated when only a creation journal exists", () => {
  const directory = mkdtempSync(join(tmpdir(), "ark-create-key-")), path = join(directory, "gateway.db");
  let store = new GatewayStore(path);
  try {
    const started = store.beginSessionCreation(input()); store.close(); unlinkSync(`${path}.credential-key`);
    store = new GatewayStore(path);
    assert.throws(() => store.sessionCreations.get(started.operationId), /密钥/);
    const other = input(); other.key.conversationId = "other"; other.message.conversationId = "other";
    assert.throws(() => store.beginSessionCreation(other), /密钥/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

const rejectedDiagnostic = { kind: "invalid_request" as const, status: 400, code: "InvalidParameter", requestId: "rejected-request" };

test("explicit InvalidParameter rejection atomically ends mounts, retains encrypted receipt and permits corrected creation", () => {
  const store = new GatewayStore(":memory:");
  try {
    const started = store.beginSessionCreation(input());
    const rejected = store.rejectSessionCreation(started, { ...rejectedDiagnostic, message: "PRIVATE_ERROR_TEXT" } as never);
    assert.equal(rejected.state, "rejected"); assert.equal(rejected.revision, 2); assert.equal(rejected.sessionId, undefined);
    assert.deepEqual(rejected.failure, rejectedDiagnostic);
    assert.equal(store.sessionCreations.pending(started.scope), undefined);
    assert.deepEqual(store.sessionCreations.latest(started.scope), rejected);
    assert.equal(store.getSession(started.key), undefined);
    const mount = store.attachmentTrace.list(started.message).items[0];
    assert.equal(mount.status, "error"); assert.equal(mount.rejected, true); assert.deepEqual(mount.failure, rejectedDiagnostic);
    assert.equal(store.isAttachmentMounted("session", started.mounts[0].key), false);
    assert.deepEqual(store.rejectSessionCreation(started, rejectedDiagnostic), rejected);
    assert.deepEqual(store.rejectSessionCreation(rejected, rejectedDiagnostic), rejected);
    assert.throws(() => store.rejectSessionCreation(started, { ...rejectedDiagnostic, requestId: "other" }), /创建|拒绝/);
    assert.throws(() => store.confirmSessionCreation(started, "session"), /创建|版本/);
    const next = store.beginSessionCreation({ ...input(), configFingerprint: "corrected" });
    assert.notEqual(next.operationId, started.operationId);
    assert.equal(store.sessionCreations.get(started.operationId)!.state, "rejected");
  } finally { store.close(); }
});

for (const diagnostic of [{ kind: "unknown" }, { ...rejectedDiagnostic, status: 500 }, { ...rejectedDiagnostic, code: "OtherError" },
  { kind: "invalid_request", status: 400 }, { ...rejectedDiagnostic, kind: "network" }])
test(`uncertain creation error cannot be marked rejected: ${JSON.stringify(diagnostic)}`, () => {
  const store = new GatewayStore(":memory:");
  try {
    const started = store.beginSessionCreation(input());
    assert.throws(() => store.rejectSessionCreation(started, diagnostic as never), /拒绝|InvalidParameter/);
    assert.deepEqual(store.sessionCreations.pending(started.scope), started);
    assert.equal(store.attachmentTrace.list(started.message).items[0].status, "pending");
  } finally { store.close(); }
});

test("rejection mount failure rolls back the entire local rejection and confirmed creations cannot be rejected", () => {
  const store = new GatewayStore(":memory:");
  try {
    const started = store.beginSessionCreation(input()), finish = store.attachmentTrace.finish;
    store.attachmentTrace.finish = () => { throw new Error("injected rejection receipt failure"); };
    assert.throws(() => store.rejectSessionCreation(started, rejectedDiagnostic), /injected/);
    store.attachmentTrace.finish = finish;
    assert.deepEqual(store.sessionCreations.pending(started.scope), started);
    assert.equal(store.attachmentTrace.list(started.message).items[0].status, "pending");
    store.confirmSessionCreation(started, "session");
    assert.throws(() => store.rejectSessionCreation(started, rejectedDiagnostic), /创建|拒绝/);
    assert.equal(store.sessionCreations.get(started.operationId)!.state, "confirmed");
  } finally { store.close(); }
});

test("old two-state journal schema migrates without changing encrypted pending or confirmed receipts", () => {
  const directory = mkdtempSync(join(tmpdir(), "ark-create-schema-")), path = join(directory, "gateway.db");
  let store = new GatewayStore(path);
  try {
    const pending = store.beginSessionCreation(input());
    const historyInput = input(); historyInput.key.conversationId = "history"; historyInput.message.conversationId = "history";
    const history = store.confirmSessionCreation(store.beginSessionCreation(historyInput), "historical-session");
    store.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(`BEGIN IMMEDIATE;
      ALTER TABLE gateway_session_creations RENAME TO migration_fixture;
      CREATE TABLE gateway_session_creations (
        operation_id TEXT PRIMARY KEY, scope TEXT NOT NULL, agent_id TEXT NOT NULL,
        config_fingerprint TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'confirmed')), revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL, session_id TEXT, secret TEXT NOT NULL
      );
      INSERT INTO gateway_session_creations SELECT * FROM migration_fixture;
      DROP TABLE migration_fixture; COMMIT;`);
    legacy.close();
    store = new GatewayStore(path);
    assert.deepEqual(store.sessionCreations.get(pending.operationId), pending);
    assert.deepEqual(store.sessionCreations.get(history.operationId), history);
    const rejected = store.rejectSessionCreation(pending, rejectedDiagnostic);
    assert.equal(rejected.state, "rejected");
    store.close(); store = new GatewayStore(path);
    assert.deepEqual(store.sessionCreations.get(pending.operationId), rejected);
    assert.equal(store.sessionCreations.pending(pending.scope), undefined);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const state of ["pending", "confirmed"] as const)
test(`legacy isolated ${state} receipt under the old shared scope fails closed without migrating or deleting it`, () => {
  const directory = mkdtempSync(join(tmpdir(), "ark-legacy-isolated-")), path = join(directory, "gateway.db");
  let store = new GatewayStore(path);
  try {
    const value = { ...input(), reusable: false }, started = store.beginSessionCreation(value);
    if (state === "confirmed") store.confirmSessionCreation(started, "isolated-session");
    const db = database(store), original = db.prepare("SELECT * FROM gateway_session_creations WHERE operation_id=?").get(started.operationId)!;
    const context = (row: Record<string, unknown>) => JSON.stringify(["session-creation", row.operation_id, row.scope, row.agent_id,
      row.config_fingerprint, row.request_fingerprint, row.state, row.revision, row.created_at, row.session_id]);
    const plaintext = store.credentials.openAuthorization(String(original.secret), context(original));
    const legacyScope = store.conversationKey(value.key), legacy = { ...original, scope: legacyScope };
    const secret = store.credentials.sealAuthorization(plaintext, context(legacy));
    db.prepare("UPDATE gateway_session_creations SET scope=?, secret=? WHERE operation_id=?")
      .run(legacyScope, secret, started.operationId);
    const persisted = db.prepare("SELECT * FROM gateway_session_creations WHERE operation_id=?").get(started.operationId);
    store.close(); store = new GatewayStore(path);
    if (state === "pending") assert.throws(() => store.sessionCreations.pending(legacyScope), /创建记录结构损坏/);
    assert.throws(() => store.sessionCreations.latest(legacyScope), /创建记录结构损坏/);
    assert.throws(() => store.sessionCreations.get(started.operationId), /创建记录结构损坏/);
    assert.deepEqual(database(store).prepare("SELECT * FROM gateway_session_creations WHERE operation_id=?").get(started.operationId), persisted);
    assert.equal(database(store).prepare("SELECT COUNT(*) AS count FROM gateway_session_creations").get()!.count, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
