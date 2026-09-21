import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as flush } from "node:timers/promises";

const alice = { channelType: "lark", installationId: "cli-pending", tenantId: "tenant-pending", senderId: "alice",
  conversationId: "alice-chat", conversationType: "direct", threadId: "", rootMessageId: "", parentMessageId: "quoted-reference",
  messageId: "alice-first", eventId: "alice-first-event", text: "A1_SENTINEL 请结合引用回答", createTime: 100, resources: [], mentionedBot: false };
const aliceNext = { ...alice, messageId: "alice-second", eventId: "alice-second-event", parentMessageId: "", text: "A2_SENTINEL 后续问题", createTime: 101 };
const bob = { ...alice, senderId: "bob", conversationId: "bob-chat", messageId: "bob-first", eventId: "bob-first-event",
  parentMessageId: "", text: "B1_SENTINEL 独立问题", createTime: 102 };
const identity = { channelType: alice.channelType, installationId: alice.installationId, tenantId: alice.tenantId, openId: alice.senderId };
type Crash = "vault_post" | "vault_confirmed" | "credential_post" | "credential_confirmed" | "binding_completed"
  | "refresh_staged" | "credential_sync_post" | "credential_sync_checkpoint" | "refresh_post" | "two_vault_posts" | "ordinary_hook" | "intent_saved";
type LifecycleFault = "matches_false" | "matches_promise" | "matches_rejected_promise" | "missing_capture" | "missing_recover" | "missing_matches";
type Scenario = { crash?: Crash; queued?: boolean; twoScopes?: boolean; existing?: boolean; legacy?: boolean; restarted?: boolean;
  ordinaryHook?: boolean; lifecycleFault?: LifecycleFault; lifecycleRevision?: string; oauthRevoked?: boolean };
type Effect = { kind: string; messageId?: string; sessionId?: string; id?: string; text?: string; path?: string; method?: string; [key: string]: unknown };

// Gateway、Manager、ArkClient、SQLite均是真实产品代码；仅HTTP/OAuth边界使用持久化合成数据。
// 父进程不会先调用auth修资源，也不会重新accept原消息或手动调用reconcilePendingMessage。
const runtimeModule = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GatewayStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
import { Gateway, toConversationKey } from ${JSON.stringify(new URL("../src/gateway.ts", import.meta.url).href)};
import { EmployeeAuthorizationManager } from ${JSON.stringify(new URL("../src/employee-auth.ts", import.meta.url).href)};
import { ArkClient } from ${JSON.stringify(new URL("../src/ark.ts", import.meta.url).href)};
import { OAuthError } from ${JSON.stringify(new URL("../src/oauth.ts", import.meta.url).href)};
const alice = ${JSON.stringify(alice)}, identity = ${JSON.stringify(identity)};
const options = { agentId: 'agent-pending', environmentId: 'env-pending', vaultId: 'bot-vault', appId: alice.installationId,
  platformAccess: true, sharedGroupSessions: true, durableQueue: true, dualIdentity: true, timeoutMs: 2000,
  progressDelayMs: 60000, sessionConfigurationRevision: 'pending-recovery-v1' };
export function createRuntime(files, scenario = {}) {
  const record = value => appendFileSync(files.ledger, JSON.stringify(value) + '\\n');
  const read = () => JSON.parse(readFileSync(files.remote, 'utf8'));
  const save = value => writeFileSync(files.remote, JSON.stringify(value));
  const store = new GatewayStore(files.path); store.acquireRuntimeLock();
  const prepareInbox = store.inbox.prepare.bind(store.inbox);
  store.inbox.prepare = (id, preparation) => {
    const task = store.inbox.findTask(id);
    record({ kind: 'ready_from_plan', messageId: task.message.messageId, inboxId: task.id,
      planId: task.preparationPlan?.id,
      authorizationIntent: task.preparationPlan?.steps.find(step => step.id === 'user-credential')?.authorizationIntent });
    return prepareInbox(id, preparation);
  };
  const streams = new Map(), held = new Map();
  let closed = false;
  const control = { beforeRequest: undefined, afterRecover: undefined, holdFirstReply: false };
  const quit = phase => { if (scenario.crash === phase) { record({ kind: 'process_exit', phase }); process.exit(77); } };
  function finish(sessionId, text) {
    const data = read(), session = data.sessions.find(item => item.id === sessionId);
    const number = session.events.filter(item => item.type === 'agent.message').length + 1;
    const result = 'RESULT_' + (text.match(/(?:A1|A2|B1)_SENTINEL/)?.[0] || 'SYNTHETIC');
    const events = [{ id: sessionId + '-agent-' + number, type: 'agent.message', content: [{ type: 'text', text: result }] },
      { id: sessionId + '-idle-' + number, type: 'session.status_idle' }];
    session.events.push(...events); session.status = 'idle'; save(data);
    const stream = streams.get(sessionId);
    if (stream) { for (const event of events) stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\\n\\n')); stream.close(); streams.delete(sessionId); }
  }
  async function fetcher(url, init = {}) {
    const path = new URL(String(url)).pathname, method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    record({ kind: 'http', path, method });
    if (control.beforeRequest) await control.beforeRequest({ path, method, body });
    const data = read(), now = new Date().toISOString(), parts = path.split('/').filter(Boolean);
    if (path === '/vaults') {
      if (method === 'GET') return Response.json({ data: data.vaults, total: data.vaults.length, next_page: null });
      if (method === 'POST') {
        const id = 'vlt-pending-' + (data.vaults.length + 1);
        data.vaults.push({ id, type: 'vault', display_name: body.display_name, metadata: body.metadata, created_at: now, updated_at: now }); save(data);
        record({ kind: 'vault_post', id, metadata: body.metadata });
        if (scenario.crash === 'two_vault_posts') {
          if (data.vaults.length === 2) quit('two_vault_posts');
          return new Promise(() => {});
        }
        quit('vault_post'); return Response.json({ id });
      }
    }
    if (parts[0] === 'vaults' && parts.length === 2 && method === 'GET') {
      const item = data.vaults.find(value => value.id === parts[1]); return Response.json(item || { error: 'missing' }, { status: item ? 200 : 404 });
    }
    if (parts[0] === 'vaults' && parts[2] === 'credentials') {
      if (parts.length === 3 && method === 'GET') {
        const items = data.credentials.filter(item => item.vault_id === parts[1]); return Response.json({ data: items, total: items.length, next_page: null });
      }
      if (parts.length === 3 && method === 'POST') {
        if (body.auth.secret_value !== 'ARKAGENT_USER_AUTH_PENDING') throw Error('首次预置不能写入其他用户Token');
        const id = 'vcrd-pending-' + (data.credentials.length + 1), auth = { ...body.auth }; delete auth.secret_value;
        data.credentials.push({ id, type: 'vault_credential', vault_id: parts[1], display_name: body.display_name,
          metadata: body.metadata, auth, created_at: now, updated_at: now }); save(data);
        record({ kind: 'credential_post', id, vaultId: parts[1], metadata: body.metadata }); quit('credential_post'); return Response.json({ id });
      }
      const item = data.credentials.find(value => value.id === parts[3] && value.vault_id === parts[1]);
      if (parts.length === 4 && method === 'GET') return Response.json(item || { error: 'missing' }, { status: item ? 200 : 404 });
      if (parts.length === 4 && method === 'POST') {
        if (!item) throw Error('不能更新不存在的Credential');
        item.updated_at = now; save(data); record({ kind: 'credential_sync_post', id: item.id,
          tokenFingerprint: createHash('sha256').update(body.auth.secret_value).digest('hex') });
        quit('credential_sync_post'); return Response.json({ id: item.id });
      }
    }
    if (parts[0] === 'environments' && method === 'GET') return Response.json({ id: parts[1], config: { type: 'cloud', env: {} } });
    if (path === '/sessions' && method === 'POST') {
      const id = 'sesn-pending-' + (data.sessions.length + 1);
      data.sessions.push({ id, type: 'session', agent: body.agent, environment: body.environment, vault_ids: body.vault_ids,
        status: 'idle', events: [] }); save(data); record({ kind: 'session_post', id, vaultIds: body.vault_ids }); return Response.json({ id });
    }
    if (parts[0] === 'sessions') {
      const session = data.sessions.find(item => item.id === parts[1]);
      if (!session) throw Error('合成Session不存在');
      if (parts.length === 2 && method === 'GET') return Response.json(session);
      if (parts[2] === 'events' && parts[3] === 'stream' && method === 'GET') {
        const stream = new ReadableStream({ start(controller) {
          streams.set(session.id, controller);
          init.signal?.addEventListener('abort', () => { if (streams.get(session.id) === controller) {
            streams.delete(session.id); try { controller.close(); } catch {} } }, { once: true });
        } });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (parts[2] === 'events' && parts.length === 3 && method === 'GET') return Response.json({ data: session.events, next_page: null });
      if (parts[2] === 'events' && parts.length === 3 && method === 'POST') {
        if (body.events?.length !== 1 || body.events[0].type !== 'user.message') throw Error('只允许一次明确的用户事件');
        const text = body.events[0].content?.[0]?.text;
        if (typeof text !== 'string' || text.trim().startsWith('/')) throw Error('测试不能用Compact等命令冒充原用户消息');
        const number = session.events.filter(item => item.type === 'user.message').length + 1;
        const event = { ...body.events[0], id: session.id + '-user-' + number };
        session.events.push(event); session.status = 'running'; save(data);
        record({ kind: 'business_post', sessionId: session.id, text });
        const stream = streams.get(session.id); if (stream) stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\\n\\n'));
        if (control.holdFirstReply && text.includes('A1_SENTINEL')) held.set(session.id, () => finish(session.id, text));
        else finish(session.id, text);
        return Response.json({ data: [] });
      }
    }
    throw Error('未授权的合成请求 ' + method + ' ' + path);
  }
  if (scenario.existing && !scenario.restarted) {
    const data = read(), now = new Date().toISOString();
    data.vaults.push({ id: 'vlt-existing', type: 'vault', display_name: 'existing', metadata: {}, created_at: now, updated_at: now });
    data.credentials.push({ id: 'vcrd-existing', type: 'vault_credential', vault_id: 'vlt-existing', display_name: 'existing',
      auth: { type: 'environment_variable', secret_name: 'LARKSUITE_CLI_USER_ACCESS_TOKEN', networking: { type: 'unrestricted' } }, created_at: now, updated_at: now });
    data.sessions.push({ id: 'sesn-existing', type: 'session', agent: 'agent-pending', status: 'idle', vault_ids: ['bot-vault', 'vlt-existing'], events: [] }); save(data);
    store.credentials.save(identity, { vaultId: 'vlt-existing', credentialId: 'vcrd-existing', status: 'ready', refreshToken: 'synthetic-old-refresh', expiresAt: 1, scopes: ['calendar:calendar.event:read'] }, 0);
    store.saveSession(toConversationKey(alice, true), 'sesn-existing', 'agent-pending', undefined, ['bot-vault', 'vlt-existing']);
  }
  if (['vault_confirmed', 'credential_confirmed', 'binding_completed'].includes(scenario.crash)) {
    const method = { vault_confirmed: 'confirmVault', credential_confirmed: 'confirmCredential', binding_completed: 'complete' }[scenario.crash];
    const original = store.credentialProvisioning[method].bind(store.credentialProvisioning);
    store.credentialProvisioning[method] = (...args) => { const value = original(...args); quit(scenario.crash); return value; };
  }
  if (scenario.crash === 'intent_saved') {
    const original = store.inbox.beginPreparationStep.bind(store.inbox);
    store.inbox.beginPreparationStep = (...args) => {
      const result = original(...args); if (args[2].id === 'user-credential') quit('intent_saved'); return result;
    };
  }
  if (['refresh_staged', 'credential_sync_checkpoint'].includes(scenario.crash)) {
    const original = store.credentials.save.bind(store.credentials);
    store.credentials.save = (...args) => { const result = original(...args);
      if (scenario.crash === 'refresh_staged' && args[1].status === 'sync_pending') quit('refresh_staged');
      if (scenario.crash === 'credential_sync_checkpoint' && args[1].status === 'ready') quit('credential_sync_checkpoint'); return result; };
  }
  const client = new ArkClient('synthetic-test-key', 'https://ark.synthetic.test', fetcher,
    { sseHeadStartMs: 0, eventPollIntervalMs: 10, inspectionTimeoutMs: 1500 });
  const auth = new EmployeeAuthorizationManager(store, client, { applicationId: alice.installationId,
    refresh: async () => { record({ kind: 'refresh_post' }); quit('refresh_post');
      if (scenario.oauthRevoked) throw new OAuthError('reauth_required', { code: 'invalid_grant', outcome: 'rejected' });
      return { accessToken: 'synthetic-new-access', refreshToken: 'synthetic-new-refresh', expiresAt: Date.now() + 3600000 }; }
  }, async () => record({ kind: 'oauth_card' }), () => record({ kind: 'oauth_resume' }));
  const lifecycle = { revision: scenario.lifecycleRevision || 'pending-credential-v1',
    prepare: async (message, intent) => { record({ kind: 'user_prepare', messageId: message.messageId }); return auth.prepareUserTurn(message, intent); },
    refresh: async (message, proof) => { record({ kind: 'user_refresh', messageId: message.messageId }); return auth.refreshPreparedAuthorization(message, proof); },
    matches: (message, proof, final) => auth.matchesPreparedAuthorization(message, proof, final),
    ...(!scenario.legacy ? {
      capture: message => { record({ kind: 'user_capture', messageId: message.messageId }); return auth.captureUserTurn(message); },
      recover: async (message, intent) => { record({ kind: 'user_recover', messageId: message.messageId });
        const proof = await auth.recoverUserTurn(message, intent); if (control.afterRecover) await control.afterRecover(message, proof); return proof; },
      matchesIntent: (message, intent) => auth.matchesUserTurnIntent(message, intent)
    } : {}) };
  if (scenario.lifecycleFault === 'matches_false') lifecycle.matchesIntent = () => false;
  if (scenario.lifecycleFault === 'matches_promise') lifecycle.matchesIntent = () => Promise.resolve(true);
  if (scenario.lifecycleFault === 'matches_rejected_promise') lifecycle.matchesIntent = () => Promise.reject(Error('synthetic rejection'));
  if (scenario.lifecycleFault === 'missing_capture') delete lifecycle.capture;
  if (scenario.lifecycleFault === 'missing_recover') delete lifecycle.recover;
  if (scenario.lifecycleFault === 'missing_matches') delete lifecycle.matchesIntent;
  const gateway = new Gateway(store, client, async (message, outbound) => {
    if (outbound.type !== 'text') throw Error('期望真实Channel文本回复协议');
    record({ kind: 'reply', messageId: message.messageId, text: outbound.text });
  }, {
    ...options, userCredentialLifecycle: lifecycle, getUserVaultIds: message => auth.vaultIds(message),
    beforeCreateSession: async () => record({ kind: 'bot_hook' }),
    ...(scenario.crash === 'ordinary_hook' || scenario.ordinaryHook ? { beforeDirectTurn: async () => {
      record({ kind: 'ordinary_hook' }); quit('ordinary_hook'); throw Error('未知普通hook不允许重放');
    } } : {}),
    readMessage: async () => { record({ kind: 'quote_read', restarted: Boolean(scenario.restarted) });
      return { status: 'available', message: { messageId: 'quoted-reference', senderId: 'reference-user', senderType: 'user', createTime: 80,
        text: scenario.restarted ? 'EDITED_QUOTE_MUST_NOT_BE_USED' : 'ORIGINAL_QUOTE_SENTINEL' } }; }
  });
  return { store, gateway, auth, client, lifecycle, control, record, read, save,
    releaseReplies: () => { for (const resume of held.values()) resume(); held.clear(); },
    close: () => { if (!closed) { closed = true; auth.close(); store.close(); } } };
}
`;

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "ark-pending-credential-process-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { path: join(dir, "gateway.db"), remote: join(dir, "remote.json"), ledger: join(dir, "effects.ndjson"), module: join(dir, "runtime.mjs") };
  writeFileSync(files.remote, JSON.stringify({ vaults: [], credentials: [], sessions: [] }));
  writeFileSync(files.ledger, ""); writeFileSync(files.module, runtimeModule); return files;
}
type Files = ReturnType<typeof fixture>;
function effects(files: Files): Effect[] { return readFileSync(files.ledger, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
function count(files: Files, kind: string, messageId?: string) { return effects(files).filter(item => item.kind === kind && (!messageId || item.messageId === messageId)).length; }
async function until(check: () => boolean, reason: string) { for (let i = 0; i < 2500 && !check(); i++) await flush(); assert.ok(check(), reason); }
async function settle() { for (let i = 0; i < 50; i++) await flush(); }
async function restart(t: { after: (fn: () => void) => void }, files: Files, scenario: Scenario = {}) {
  const runtime = (await import(pathToFileURL(files.module).href)).createRuntime(files, { ...scenario, crash: undefined, restarted: true });
  t.after(() => runtime.close()); return runtime;
}
function crash(files: Files, scenario: Scenario) {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { createRuntime } from ${JSON.stringify(pathToFileURL(files.module).href)};
    const runtime = createRuntime(${JSON.stringify(files)}, ${JSON.stringify(scenario)});
    runtime.gateway.accept(${JSON.stringify(alice)});
    if (${Boolean(scenario.queued)}) runtime.gateway.accept(${JSON.stringify(aliceNext)});
    if (${Boolean(scenario.twoScopes)}) runtime.gateway.accept(${JSON.stringify(bob)});
    setTimeout(() => process.exit(99), 3000);
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 77, child.stderr || child.stdout);
  assert.equal(count(files, "business_post"), 0); assert.equal(count(files, "reply"), 0);
}
function start(runtime: any) { runtime.gateway.recoverPendingMessages(alice.channelType, alice.installationId); }
function pendingTask(runtime: any, message = alice) {
  const task = runtime.store.inbox.findMessage(message)!;
  assert.ok(task); assert.equal(task.preparation, undefined);
  const step = task.preparationPlan!.steps.find((value: any) => value.id === "user-credential");
  assert.equal(step?.state, "pending"); return { task, step };
}
function assertCompleted(files: Files, runtime: any, originalId: string, message = alice) {
  const task = runtime.store.inbox.findMessage(message)!;
  assert.equal(task.id, originalId); assert.equal(task.state, "completed");
  const posts = effects(files).filter(value => value.kind === "business_post" && value.text!.includes(message.text.split(" ")[0]));
  assert.equal(posts.length, 1); assert.equal(count(files, "reply", message.messageId), 1);
  assert.equal(count(files, "user_prepare", message.messageId), 1);
  assert.equal(count(files, "user_capture", message.messageId), 1);
  assert.equal(count(files, "user_recover", message.messageId), 1);
  if (message.parentMessageId) {
    assert.match(posts[0].text!, /ORIGINAL_QUOTE_SENTINEL/); assert.doesNotMatch(posts[0].text!, /EDITED_QUOTE_MUST_NOT_BE_USED/);
    assert.equal(effects(files).filter(value => value.kind === "quote_read").length, 1);
  }
  assert.equal(effects(files).find(value => value.kind === "reply" && value.messageId === message.messageId)!.text!, `RESULT_${message.text.split(" ")[0]}`);
}

for (const point of ["vault_post", "vault_confirmed", "credential_post", "credential_confirmed", "binding_completed"] as const)
test(`Gateway startup recovers its original pending user message after ${point} without manual auth repair`, async t => {
  const files = fixture(t); crash(files, { crash: point }); const runtime = await restart(t, files);
  const { task, step } = pendingTask(runtime), original = runtime.store.credentialProvisioning.get(identity)!;
  assert.equal(step.authorizationIntent.kind, "provisioning"); assert.equal(step.authorizationIntent.operationId, original.operationId);
  start(runtime); await until(() => runtime.store.inbox.findMessage(alice)?.state === "completed", "原A1必须由启动恢复自动完成");
  assertCompleted(files, runtime, task.id);
  const ready = effects(files).find(item => item.kind === "ready_from_plan" && item.messageId === alice.messageId)!;
  assert.equal(ready.inboxId, task.id); assert.equal(ready.planId, task.preparationPlan.id);
  assert.deepEqual(ready.authorizationIntent, step.authorizationIntent);
  assert.equal(runtime.store.credentialProvisioning.get(identity).operationId, original.operationId);
  assert.equal(runtime.store.credentialProvisioning.get(identity).phase, "completed");
  assert.equal(count(files, "vault_post"), 1); assert.equal(count(files, "credential_post"), 1); assert.equal(count(files, "session_post"), 1);
  const session = runtime.read().sessions[0], binding = runtime.store.credentials.get(identity);
  assert.deepEqual(session.vault_ids, ["bot-vault", binding.vaultId]);
  assert.equal(runtime.store.credentialProvisioning.get(identity).initialAuthorizationGeneration, binding.authorizationGeneration);
  start(runtime); start(runtime); await settle(); assert.equal(count(files, "business_post"), 1);
  runtime.close();
  const nextBoot = await restart(t, files); start(nextBoot); await settle();
  assert.equal(nextBoot.store.inbox.findMessage(alice).id, task.id);
  assert.equal(nextBoot.store.inbox.findMessage(alice).state, "completed");
  assert.equal(count(files, "business_post"), 1); assert.equal(count(files, "reply", alice.messageId), 1);
  assert.equal(count(files, "vault_post"), 1); assert.equal(count(files, "credential_post"), 1); assert.equal(count(files, "session_post"), 1);
});

test("recovered A1 keeps same-scope FIFO while a new Bob scope completes in parallel", async t => {
  const files = fixture(t); crash(files, { crash: "credential_post", queued: true }); const runtime = await restart(t, files);
  const { task } = pendingTask(runtime); assert.equal(runtime.store.inbox.findMessage(aliceNext).state, "queued");
  runtime.control.holdFirstReply = true; start(runtime);
  await until(() => count(files, "business_post") === 1, "恢复A1应先进入原模型请求");
  assert.equal(runtime.store.inbox.findMessage(aliceNext).state, "queued");
  runtime.gateway.accept(bob);
  await until(() => runtime.store.inbox.findMessage(bob)?.state === "completed", "A1等待期间Bob应独立完成");
  assert.equal(runtime.store.inbox.findMessage(aliceNext).state, "queued");
  runtime.releaseReplies(); await until(() => runtime.store.inbox.findMessage(aliceNext)?.state === "completed", "A1完成后A2应继续");
  assertCompleted(files, runtime, task.id);
  const posts = effects(files).filter(value => value.kind === "business_post");
  assert.deepEqual(posts.map(value => value.text!.match(/(?:A1|A2|B1)_SENTINEL/)![0]), ["A1_SENTINEL", "B1_SENTINEL", "A2_SENTINEL"]);
  assert.equal(posts[0].sessionId, posts[2].sessionId); assert.notEqual(posts[0].sessionId, posts[1].sessionId);
  assert.equal(count(files, "vault_post"), 2); assert.equal(count(files, "credential_post"), 2);
});

test("startup recovery of one slow provisioning scope does not block another interrupted scope", async t => {
  const files = fixture(t); crash(files, { crash: "two_vault_posts", twoScopes: true }); const runtime = await restart(t, files);
  const first = pendingTask(runtime), second = pendingTask(runtime, bob);
  const aliceVault = runtime.read().vaults.find((item: any) => item.metadata.arkagent_provision_operation === first.step.authorizationIntent.operationId);
  let blocked = false, released = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  runtime.control.beforeRequest = async ({ path, method }: { path: string; method: string }) => {
    if (method === "GET" && path === `/vaults/${aliceVault.id}` && !released) { blocked = true; await gate; }
  };
  start(runtime); await until(() => blocked, "A1恢复必须实际进入被延迟的只读核查");
  await until(() => runtime.store.inbox.findMessage(bob)?.state === "completed", "Bob启动恢复不能串行等待A1的远端查询");
  assert.equal(released, false); assert.equal(count(files, "business_post"), 1);
  released = true; release(); await until(() => runtime.store.inbox.findMessage(alice)?.state === "completed", "解除核查等待后A1应恢复");
  assertCompleted(files, runtime, first.task.id); assertCompleted(files, runtime, second.task.id, bob);
  assert.equal(count(files, "vault_post"), 2); assert.equal(count(files, "credential_post"), 2);
});

for (const point of ["refresh_staged", "credential_sync_post", "credential_sync_checkpoint"] as const)
test(`Gateway resumes original bound preparation after ${point} without another OAuth refresh`, async t => {
  const files = fixture(t); crash(files, { crash: point, existing: true }); const runtime = await restart(t, files, { existing: true });
  const { task, step } = pendingTask(runtime), expected = step.authorizationIntent.authorization;
  assert.equal(step.authorizationIntent.kind, "bound"); start(runtime);
  await until(() => runtime.store.inbox.findMessage(alice)?.state === "completed", "已有绑定的原准备任务应恢复完成");
  assertCompleted(files, runtime, task.id); assert.equal(count(files, "refresh_post"), 1);
  assert.equal(count(files, "credential_sync_post"), point === "credential_sync_post" ? 2 : 1);
  assert.equal(count(files, "vault_post"), 0); assert.equal(count(files, "credential_post"), 0); assert.equal(count(files, "session_post"), 0);
  assert.equal(effects(files).find(item => item.kind === "business_post")!.sessionId, "sesn-existing");
  assert.equal(runtime.store.credentials.get(identity).authorizationGeneration, expected.generation);
});

test("unknown OAuth refresh outcome remains paused rather than resending the refresh or business request", async t => {
  const files = fixture(t); crash(files, { crash: "refresh_post", existing: true }); const runtime = await restart(t, files, { existing: true });
  const { task } = pendingTask(runtime); start(runtime); await settle();
  assert.equal(runtime.store.inbox.findMessage(alice).id, task.id); assert.equal(runtime.store.inbox.findMessage(alice).state, "uncertain");
  assert.equal(count(files, "refresh_post"), 1); assert.equal(count(files, "business_post"), 0);
  assert.equal(count(files, "credential_sync_post"), 0);
});

test("revoked bound authorization pauses the frozen original message instead of silently switching it to Bot identity", async t => {
  const files = fixture(t); crash(files, { crash: "intent_saved", existing: true, queued: true });
  const runtime = await restart(t, files, { existing: true, oauthRevoked: true });
  const { task, step } = pendingTask(runtime); assert.equal(step.authorizationIntent.kind, "bound");
  start(runtime); await until(() => runtime.store.credentials.get(identity)?.status === "reauth_required", "明确失效的授权应清除云端Token并落盘");
  await settle();
  assert.notEqual(runtime.store.credentials.get(identity).authorizationGeneration, step.authorizationIntent.authorization.generation);
  assert.equal(runtime.store.inbox.findMessage(alice).id, task.id); assert.equal(runtime.store.inbox.findMessage(alice).state, "uncertain");
  assert.equal(runtime.store.inbox.findMessage(aliceNext).state, "queued");
  assert.equal(count(files, "user_prepare", alice.messageId), 0); assert.equal(count(files, "user_capture", alice.messageId), 1);
  assert.equal(count(files, "user_recover", alice.messageId), 1); assert.equal(count(files, "refresh_post"), 1);
  assert.equal(count(files, "credential_sync_post"), 1); assert.equal(count(files, "business_post"), 0);
  assert.equal(count(files, "vault_post"), 0); assert.equal(count(files, "credential_post"), 0); assert.equal(count(files, "session_post"), 0);
  assert.equal(count(files, "oauth_card"), 0); assert.equal(count(files, "oauth_resume"), 0);
});

for (const kind of ["provisioning", "bound"] as const)
for (const changed of ["oauth_replaced", "flow_cancelled", "generation", "binding", "during_recover"] as const)
test(`${kind} pending recovery refuses ${changed} instead of adopting current authorization`, async t => {
  const files = fixture(t); crash(files, { crash: kind === "bound" ? "credential_sync_checkpoint" : "binding_completed", existing: kind === "bound", queued: true });
  const runtime = await restart(t, files, { existing: kind === "bound" }); const { task } = pendingTask(runtime);
  const mutate = () => {
    const current = runtime.store.credentials.get(identity);
    if (changed === "flow_cancelled") {
      const flow = runtime.store.authorizations.create(identity, [alice]); runtime.store.authorizations.save(identity, flow, { phase: "cancelled" });
    } else if (changed === "oauth_replaced" || changed === "during_recover") {
      let flow = runtime.store.authorizations.create(identity, [alice]);
      flow = runtime.store.authorizations.save(identity, flow, { phase: "verifying" });
      flow = runtime.store.stageAuthorizationCredential(flow, { accessToken: "synthetic-second-access", refreshToken: "synthetic-second-refresh", expiresAt: Date.now() + 3600000 }, current.scopes);
      const staged = runtime.store.credentials.get(identity);
      runtime.store.credentials.save(identity, { ...staged, status: "ready", pendingAccessToken: undefined }, staged.revision);
      runtime.store.authorizations.save(identity, flow, { phase: "completed" });
    } else runtime.store.credentials.save(identity, changed === "binding" ? { ...current, credentialId: "vcrd-replacement" } : current, current.revision, true);
  };
  if (changed === "during_recover") runtime.control.afterRecover = async () => mutate(); else mutate();
  const postsBefore = count(files, "vault_post") + count(files, "credential_post"); start(runtime); await settle();
  assert.equal(runtime.store.inbox.findMessage(alice).id, task.id); assert.equal(runtime.store.inbox.findMessage(alice).state, "uncertain");
  assert.equal(runtime.store.inbox.findMessage(aliceNext).state, "queued"); assert.equal(count(files, "business_post"), 0);
  assert.equal(count(files, "vault_post") + count(files, "credential_post"), postsBefore);
  assert.equal(count(files, "user_prepare", alice.messageId), 1); assert.equal(count(files, "user_capture", alice.messageId), 1);
});

for (const changed of ["missing", "duplicate", "metadata", "updated_at"] as const)
test(`Gateway leaves original provisioning and FIFO paused when remote recovery evidence is ${changed}`, async t => {
  const files = fixture(t); crash(files, { crash: "credential_post", queued: true }); const runtime = await restart(t, files);
  const { task } = pendingTask(runtime), before = runtime.store.credentialProvisioning.get(identity), data = runtime.read();
  if (changed === "missing") data.credentials = [];
  if (changed === "duplicate") data.credentials.push({ ...data.credentials[0], id: "vcrd-duplicate" });
  if (changed === "metadata") data.credentials[0].metadata.arkagent_provision_operation = "00000000-0000-4000-8000-000000000000";
  if (changed === "updated_at") data.credentials[0].updated_at = new Date(Date.parse(data.credentials[0].created_at) + 1000).toISOString();
  runtime.save(data); start(runtime); await settle();
  assert.equal(runtime.store.inbox.findMessage(alice).id, task.id); assert.equal(runtime.store.inbox.findMessage(alice).state, "uncertain");
  assert.equal(runtime.store.inbox.findMessage(aliceNext).state, "queued"); assert.equal(count(files, "business_post"), 0);
  assert.equal(count(files, "vault_post"), 1); assert.equal(count(files, "credential_post"), 1);
  assert.deepEqual(runtime.store.credentialProvisioning.get(identity), before);
});

for (const kind of ["legacy", "ordinary_hook"] as const)
test(`${kind} pending hook still cannot recover through the new typed credential path`, async t => {
  const files = fixture(t); crash(files, { crash: kind === "legacy" ? "credential_post" : "ordinary_hook", legacy: kind === "legacy" });
  const runtime = await restart(t, files, { legacy: kind === "legacy", ordinaryHook: kind === "ordinary_hook" }); const task = runtime.store.inbox.findMessage(alice);
  if (kind === "legacy") assert.equal(pendingTask(runtime).step.authorizationIntent, undefined);
  const before = effects(files).length; start(runtime); await settle();
  assert.equal(runtime.store.inbox.findMessage(alice).id, task.id); assert.equal(runtime.store.inbox.findMessage(alice).state, "uncertain");
  assert.equal(count(files, "business_post"), 0); assert.equal(count(files, "user_recover"), 0);
  if (kind === "ordinary_hook") assert.equal(count(files, "ordinary_hook"), 1);
  assert.equal(effects(files).slice(before).some(item => item.method === "POST"), false);
});

for (const fault of ["matches_false", "matches_promise", "matches_rejected_promise", "missing_capture", "missing_recover", "missing_matches", "revision_changed"] as const)
test(`pending user preparation refuses lifecycle ${fault} before resource writes or business dispatch`, async t => {
  const files = fixture(t); crash(files, { crash: "vault_post", queued: true });
  const runtime = await restart(t, files, fault === "revision_changed" ? { lifecycleRevision: "pending-credential-v2" } : { lifecycleFault: fault });
  const { task, step } = pendingTask(runtime), journal = runtime.store.credentialProvisioning.get(identity), before = effects(files).length;
  start(runtime); await settle();
  const stopped = runtime.store.inbox.findMessage(alice);
  assert.equal(stopped.id, task.id); assert.equal(stopped.state, "uncertain");
  assert.equal(stopped.preparationPlan.id, task.preparationPlan.id);
  assert.deepEqual(stopped.preparationPlan.steps.find((item: any) => item.id === "user-credential"), step);
  assert.deepEqual(runtime.store.credentialProvisioning.get(identity), journal);
  assert.equal(runtime.store.inbox.findMessage(aliceNext).state, "queued");
  assert.equal(count(files, "user_prepare", alice.messageId), 1); assert.equal(count(files, "user_capture", alice.messageId), 1);
  assert.equal(count(files, "user_recover"), 0); assert.equal(count(files, "business_post"), 0);
  assert.equal(effects(files).slice(before).some(item => item.method === "POST"), false);
});
