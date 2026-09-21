import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as flush } from "node:timers/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayStore } from "../src/store.ts";
import { PreparationRunner } from "../src/preparation-runner.ts";
import { createPreparationPlan, startPreparationStep, validatePreparationPlan } from "../src/preparation-plan.ts";
import * as authorization from "../src/prepared-authorization.ts";
import type { ChannelMessage } from "../src/channel.ts";

const identity = { channelType: "lark", installationId: "cli", tenantId: "tenant", openId: "alice" };
const proof = { version: 1 as const, identity, generation: "10000000-0000-4000-8000-000000000001",
  vaultId: "vault", credentialId: "credential", flowId: null };
const bound = () => ({ version: 1 as const, identity: { ...identity }, flowId: null, kind: "bound" as const, authorization: structuredClone(proof) });
const provisioning = () => ({ version: 1 as const, identity: { ...identity }, flowId: null, kind: "provisioning" as const,
  operationId: "20000000-0000-4000-8000-000000000002" });
const message: ChannelMessage = { ...identity, senderId: identity.openId, conversationId: "chat", conversationType: "direct", threadId: "",
  rootMessageId: "", parentMessageId: "", messageId: "message", eventId: "event", text: "hello", resources: [], createTime: 100, mentionedBot: false };
const binding = { scope: "scope", agentId: "agent", configFingerprint: "configuration" };
const input = { lifecycle: "fixture-v1" };
const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
const descriptor = (intent = bound()) => ({ id: "user-credential", kind: "hook" as const, inputFingerprint: fingerprint, authorizationIntent: intent });

function fixture(t: TestContext, incoming = message) {
  const store = new GatewayStore(":memory:"); store.acquireRuntimeLock(); t.after(() => store.close());
  const queued = store.receiveMessage(incoming, binding)!;
  const task = store.inbox.beginPreparationPlan(store.inbox.claim(queued.id, binding)!, { reusable: false });
  const runner = new PreparationRunner(store, task, { reusable: false });
  const current = () => store.inbox.findTask(task.id)!;
  return { store, task, runner, current };
}

test("credential intent is atomically stored in its pending step before the callback runs", async t => {
  const { runner, current, task } = fixture(t), intent = bound(); let captures = 0;
  const result = await runner.userCredential(input, () => { captures++; return intent; }, async (saved, recovering) => {
    const pending = current();
    assert.equal(pending.revision, task.revision + 1);
    assert.equal(pending.preparationPlan!.steps.length, 1);
    assert.deepEqual(pending.preparationPlan!.steps[0], { ...descriptor(intent), state: "pending" });
    assert.deepEqual(saved, intent); assert.equal(recovering, false);
    return structuredClone(proof);
  });
  assert.equal(captures, 1); assert.deepEqual(result, proof);
  assert.equal(current().preparationPlan!.steps[0].state, "completed");
});

for (const makeIntent of [bound, provisioning]) test(`pending ${makeIntent().kind} uses only its saved intent on recovery`, async t => {
  const { runner, current, store } = fixture(t), intent = makeIntent(); let captures = 0;
  await assert.rejects(runner.userCredential(input, () => { captures++; return intent; }, async () => { throw Error("interrupted"); }));
  const pending = current();
  const retry = new PreparationRunner(store, pending, { reusable: false });
  const result = await retry.userCredential(input, () => { captures++; throw Error("must not capture again"); }, async (original, recovering) => {
    assert.deepEqual(original, intent); assert.equal(recovering, true); return structuredClone(proof);
  });
  assert.deepEqual(result, proof); assert.equal(captures, 1);
});

test("a completed credential step returns its original proof without capture or operation", async t => {
  const { runner, current, store } = fixture(t);
  await runner.userCredential(input, bound, async () => structuredClone(proof));
  const before = current();
  const result = await new PreparationRunner(store, before, { reusable: false }).userCredential(input,
    () => assert.fail("cannot capture"), async () => assert.fail("cannot operate"));
  result.vaultId = "mutated";
  assert.deepEqual(current(), before);
});

test("old pending credentials cannot be recaptured but old completed proofs remain readable", async t => {
  const { store, task } = fixture(t), planId = task.preparationPlan!.id;
  const old = store.inbox.beginPreparationStep(task, planId, { id: "user-credential", kind: "hook", inputFingerprint: fingerprint });
  await assert.rejects(new PreparationRunner(store, old, { reusable: false }).userCredential(input,
    () => assert.fail("cannot fabricate intent"), async () => assert.fail("cannot rerun")), /准备|意图/);
  const completed = store.inbox.completePreparationStep(old, planId, "user-credential", proof);
  assert.deepEqual(await new PreparationRunner(store, completed, { reusable: false }).userCredential(input,
    () => assert.fail("cannot capture"), async () => assert.fail("cannot rerun")), proof);
});

test("captured intent cannot be mutated by its provider or by the operation callback", async t => {
  const { runner, current } = fixture(t), intent = bound();
  await runner.userCredential(input, () => intent, async saved => {
    intent.authorization.generation = "30000000-0000-4000-8000-000000000003";
    saved.identity.openId = "bob";
    return structuredClone(proof);
  });
  assert.deepEqual(current().preparationPlan!.steps[0].authorizationIntent, bound());
});

for (const field of ["generation", "vaultId", "credentialId", "flowId"] as const)
test(`bound output cannot replace the original ${field}`, async t => {
  const { runner, current } = fixture(t);
  const changed = { ...proof, [field]: field === "generation" || field === "flowId" ? "30000000-0000-4000-8000-000000000003" : "replacement" };
  await assert.rejects(runner.userCredential(input, bound, async () => changed), /准备|授权|意图/);
  assert.equal(current().preparationPlan!.steps[0].state, "pending");
});

for (const field of ["channelType", "installationId", "tenantId", "openId"] as const)
test(`inbox refuses an intent for another ${field} before operation`, async t => {
  const { runner, current } = fixture(t), intent = provisioning(); intent.identity[field] = "other";
  await assert.rejects(runner.userCredential(input, () => intent, async () => assert.fail("must not operate")), /准备|授权|意图/);
  assert.deepEqual(current().preparationPlan!.steps, []);
});

for (const changed of ["identity", "flowId"] as const)
test(`provisioning output cannot switch ${changed}`, async t => {
  const { runner, current } = fixture(t);
  const result = changed === "identity" ? { ...proof, identity: { ...identity, openId: "other" } }
    : { ...proof, flowId: "30000000-0000-4000-8000-000000000003" };
  await assert.rejects(runner.userCredential(input, provisioning, async () => result), /准备|授权|意图/);
  assert.equal(current().preparationPlan!.steps[0].state, "pending");
});

test("group messages never persist personal credential intents", async t => {
  const { runner, current } = fixture(t, { ...message, conversationType: "group" });
  await assert.rejects(runner.userCredential(input, bound, async () => assert.fail("must not operate")), /准备|授权|意图/);
  assert.deepEqual(current().preparationPlan!.steps, []);
});

test("a failed pending checkpoint cannot run the credential operation", async t => {
  const { runner, current, store } = fixture(t), before = current();
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON gateway_message_inbox BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  await assert.rejects(runner.userCredential(input, bound, async () => assert.fail("must not operate")), /准备|保存/);
  assert.deepEqual(current(), before);
});

test("credential intent replacement or removal is rejected by the same step CAS", t => {
  const { store, task } = fixture(t), id = task.preparationPlan!.id, value = descriptor();
  const pending = store.inbox.beginPreparationStep(task, id, value);
  assert.deepEqual(store.inbox.beginPreparationStep(pending, id, structuredClone(value)), pending);
  for (const candidate of [{ ...value, authorizationIntent: provisioning() }, { id: value.id, kind: value.kind, inputFingerprint: fingerprint },
    { ...value, authorizationIntent: { ...bound(), flowId: "30000000-0000-4000-8000-000000000003" } }]) {
    assert.throws(() => store.inbox.beginPreparationStep(pending, id, candidate), /准备|步骤|意图/);
  }
  assert.throws(() => store.inbox.beginPreparationStep(task, id, value), /版本|准备/);
});

test("only the user-credential hook can hold an authorization intent", () => {
  for (const patch of [{ id: "custom-hook" }, { kind: "snapshot" }, { kind: "observation" }]) {
    assert.throws(() => startPreparationStep(createPreparationPlan({ reusable: false }), { ...descriptor(), ...patch } as never), /准备|意图/);
  }
});

test("ordinary hooks remain nonrecoverable even when named user-credential", async t => {
  const { store, task } = fixture(t), id = task.preparationPlan!.id;
  const pending = store.inbox.beginPreparationStep(task, id, descriptor());
  await assert.rejects(new PreparationRunner(store, pending, { reusable: false }).step("user-credential", "hook", input,
    async () => assert.fail("generic hooks cannot recover")), /准备|步骤/);
});

test("Promise capture is rejected synchronously without an unhandled rejection or persisted step", async t => {
  const { runner, current } = fixture(t);
  await assert.rejects(runner.userCredential(input, (() => Promise.reject(Error("PRIVATE-CAPTURE"))) as never,
    async () => assert.fail("cannot operate")), error => error instanceof Error && !error.message.includes("PRIVATE"));
  await flush(); assert.deepEqual(current().preparationPlan!.steps, []);
});

test("intent validators reject getters and arbitrary JSON fields without evaluating them", async t => {
  const { runner, current } = fixture(t); let reads = 0;
  const accessor = { ...bound(), get authorization() { reads++; return proof; } };
  const thenable = { ...bound(), get then() { reads++; throw Error("PRIVATE"); } };
  const symbol = { ...bound(), [Symbol("private")]: "secret" };
  for (const value of [accessor, thenable, symbol, { ...bound(), token: "PRIVATE" }, { ...bound(), authorization: { ...proof, token: "PRIVATE" } },
    { ...provisioning(), operationId: "bad" }, { ...provisioning(), identity: { ...identity, other: true } }]) {
    await assert.rejects(runner.userCredential(input, (() => value) as never, async () => assert.fail("cannot operate")));
  }
  assert.equal(reads, 0); assert.deepEqual(current().preparationPlan!.steps, []);
});

test("proof validators reject malformed bound intent identity and flow relationships", () => {
  for (const value of [{ ...bound(), identity: { ...identity, openId: "bob" } },
    { ...bound(), flowId: "30000000-0000-4000-8000-000000000003" }]) {
    assert.throws(() => authorization.validateUserCredentialPreparationIntent(value), /准备|意图/);
  }
});

test("plan decoding rejects output proof inconsistent with its saved bound intent", () => {
  const plan = createPreparationPlan({ reusable: false });
  plan.steps.push({ ...descriptor(), state: "completed", output: { ...proof, vaultId: "replacement" } });
  assert.throws(() => validatePreparationPlan(plan), /准备|授权|意图/);
});

function rewrite(store: GatewayStore, id: string, change: (payload: any) => void) {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const row = db.prepare("SELECT * FROM gateway_message_inbox WHERE id=?").get(id)!;
  const context = JSON.stringify(["message-inbox", row.sequence, row.id, row.event_key, row.channel_type, row.installation_id,
    row.scope, row.agent_id, row.config_fingerprint, row.state, row.owner, row.revision,
    row.session_id, row.request_fingerprint, row.interrupted_at]);
  const payload = JSON.parse(store.credentials.openAuthorization(String(row.secret), context));
  change(payload);
  db.prepare("UPDATE gateway_message_inbox SET secret=? WHERE id=?").run(store.credentials.sealAuthorization(JSON.stringify(payload), context), id);
}

for (const field of ["channelType", "installationId", "tenantId", "openId"] as const)
test(`authenticated pending intent for another ${field} is rejected when decoding`, t => {
  const { store, task, current } = fixture(t);
  store.inbox.beginPreparationStep(task, task.preparationPlan!.id, { ...descriptor(), authorizationIntent: provisioning() });
  rewrite(store, task.id, payload => { payload.preparationPlan.steps[0].authorizationIntent.identity[field] = "another"; });
  assert.throws(current, /结构损坏/);
});

for (const change of [
  (step: any) => { step.authorizationIntent.version = 2; },
  (step: any) => { step.authorizationIntent.operationId = "invalid"; },
  (step: any) => { step.authorizationIntent.token = "PRIVATE"; },
  (step: any) => { step.id = "unrelated-hook"; },
  (step: any) => { step.kind = "snapshot"; },
  (step: any) => { step.state = "completed"; step.output = { ...proof, flowId: "30000000-0000-4000-8000-000000000003" }; }
]) test("authenticated malformed intent or conflicting result is rejected when decoding", t => {
  const { store, task, current } = fixture(t);
  store.inbox.beginPreparationStep(task, task.preparationPlan!.id, { ...descriptor(), authorizationIntent: provisioning() });
  rewrite(store, task.id, payload => change(payload.preparationPlan.steps[0]));
  assert.throws(current, /结构损坏/);
});

test("authenticated group context cannot retain a personal credential intent", t => {
  const { store, task, current } = fixture(t);
  store.inbox.beginPreparationStep(task, task.preparationPlan!.id, descriptor());
  rewrite(store, task.id, payload => { payload.message.conversationType = "group"; });
  assert.throws(current, /结构损坏/);
});

test("pending intent survives encrypted restart without capturing a replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-credential-intent-")), path = join(dir, "gateway.db");
  let store = new GatewayStore(path); store.acquireRuntimeLock();
  try {
    const queued = store.receiveMessage(message, binding)!;
    const task = store.inbox.claim(queued.id, binding)!;
    await assert.rejects(new PreparationRunner(store, task, { reusable: false }).userCredential(input, provisioning, async () => { throw Error("interrupt"); }));
    const saved = store.inbox.findTask(task.id)!.preparationPlan!;
    store.close();
    assert.equal(readFileSync(path).includes(Buffer.from(provisioning().operationId)), false);
    store = new GatewayStore(path); store.acquireRuntimeLock();
    const interrupted = store.recoverMessages("lark", "cli").interrupted[0];
    assert.deepEqual(interrupted.preparationPlan, saved);
    const claimed = store.claimPreparingMessage(interrupted, binding);
    const result = await new PreparationRunner(store, claimed, { reusable: false }).userCredential(input,
      () => assert.fail("cannot capture after restart"), async (intent, recovering) => {
        assert.deepEqual(intent, provisioning()); assert.equal(recovering, true); return structuredClone(proof);
      });
    assert.deepEqual(result, proof);
    assert.equal(store.inbox.findTask(task.id)!.dispatchId, undefined);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("changed input on pending credential preparation cannot trigger recovery", async t => {
  const { runner, current, store } = fixture(t);
  await assert.rejects(runner.userCredential(input, bound, async () => { throw Error("interrupted"); }));
  await assert.rejects(new PreparationRunner(store, current(), { reusable: false }).userCredential({ lifecycle: "changed" },
    () => assert.fail("cannot recapture"), async () => assert.fail("cannot recover altered input")), /准备|意图/);
});

test("an in-flight credential operation cannot be mistaken for interrupted recovery on the same runner", async t => {
  const { runner } = fixture(t); let release!: () => void, operations = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = runner.userCredential(input, bound, async () => { operations++; await gate; return structuredClone(proof); });
  try {
    await assert.rejects(runner.userCredential(input, () => assert.fail("cannot capture twice"), async () => {
      operations++; throw Error("duplicate operation");
    }), /进行中/);
    assert.equal(operations, 1);
  } finally { release(); await first; }
});
