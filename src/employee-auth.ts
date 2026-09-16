import type { ArkClient, UserAuthorizationRequired } from "./ark.ts";
import type { IncomingMessage } from "./gateway.ts";
import type { FeishuOAuth } from "./oauth.ts";
import { OAuthError, type OAuthTokens } from "./oauth.ts";
import type { GatewayStore } from "./store.ts";
import { credentialIdentityKey, type CredentialIdentity, type CredentialState } from "./credential-state.ts";
import { provisionUserCredential, type CredentialProvisioningArk } from "./credential-provisioning.ts";
import { isAuthorizationTerminal, type AuthorizationFlow } from "./authorization-state.ts";
import { randomUUID } from "node:crypto";
import { validatePreparedAuthorization, validateUserCredentialPreparationIntent,
  type PreparedAuthorization, type UserCredentialPreparationIntent } from "./prepared-authorization.ts";

export const EMPLOYEE_CALENDAR_USER_SCOPES = ["offline_access", "auth:user.id:read", "calendar:calendar:read", "calendar:calendar.event:read", "calendar:calendar.free_busy:read"];

type EmployeeAuthArk = CredentialProvisioningArk & Pick<ArkClient, "updateEnvironmentCredential">;
type PendingAuthorization = { flow: AuthorizationFlow; controller: AbortController; restored?: boolean; timer?: ReturnType<typeof setTimeout>; task?: Promise<void> };
type AuthorizationLifecycleOptions = {
  notify?: (message: IncomingMessage, text: string) => Promise<void>;
  onStateChange?: (messages: IncomingMessage[], flowId: string, active: boolean) => void;
};

export class EmployeeAuthorizationManager {
  private pending = new Map<string, PendingAuthorization>();
  private closed = false;
  private lifecycle: AuthorizationLifecycleOptions;
  private provisioning = new Map<string, Promise<{ vaultId: string; credentialId: string }>>();
  private refreshing = new Map<string, Promise<void>>();
  private operations = new Map<string, Promise<unknown>>();
  private store: GatewayStore;
  private ark: EmployeeAuthArk;
  private oauth: FeishuOAuth;
  private sendCard: (message: IncomingMessage, url: string) => Promise<void>;
  private resume: (message: IncomingMessage, userVaultId: string) => void;
  constructor(store: GatewayStore, ark: EmployeeAuthArk, oauth: FeishuOAuth,
    sendCard: (message: IncomingMessage, url: string) => Promise<void>,
    resume: (message: IncomingMessage, userVaultId: string) => void, lifecycle: AuthorizationLifecycleOptions = {}) {
    this.store = store; this.ark = ark; this.oauth = oauth; this.sendCard = sendCard;
    this.resume = resume;
    this.lifecycle = lifecycle;
    this.store.credentials.prepare();
  }

  async vaultIds(message: IncomingMessage): Promise<string[]> {
    if (message.conversationType !== "direct") return [];
    return [(await this.ensureUserCredentialBinding(message)).vaultId];
  }

  // 仅为新准备步骤捕获本地状态；必须由调用方先持久化，再执行有副作用的prepare。
  captureUserTurn(message: IncomingMessage): UserCredentialPreparationIntent {
    this.assertOpen();
    if (message.conversationType !== "direct") throw new Error("群聊不能准备个人授权身份");
    const identity = this.identity(message);
    this.assertNoActiveFlow(identity);
    const lease = this.store.credentials.acquire(identity);
    try {
      let state = this.store.migrateEmployeeCredential(identity);
      // 旧绑定只允许在新消息的明确准备动作中补代次，恢复入口绝不补写。
      if (state && !state.authorizationGeneration) state = this.store.credentials.save(identity, state, state.revision);
      const flowId = this.store.authorizations.get(identity)?.id ?? null;
      const intent: UserCredentialPreparationIntent = state
        ? { version: 1, identity, flowId, kind: "bound", authorization: { version: 1, identity,
          flowId, generation: state.authorizationGeneration!, vaultId: state.vaultId, credentialId: state.credentialId } }
        : { version: 1, identity, flowId, kind: "provisioning",
          operationId: this.store.credentialProvisioning.get(identity)?.operationId ?? randomUUID() };
      validateUserCredentialPreparationIntent(intent);
      if (!this.matchesUserTurnIntent(message, intent)) throw new Error("用户授权准备状态不明确，未生成替代意图");
      return intent;
    } finally { this.store.credentials.release(identity, lease); }
  }

  matchesUserTurnIntent(message: IncomingMessage, intent: UserCredentialPreparationIntent): boolean {
    try {
      this.assertOpen();
      validateUserCredentialPreparationIntent(intent);
      if (message.conversationType !== "direct") return false;
      const identity = this.identity(message);
      if (credentialIdentityKey(identity) !== credentialIdentityKey(intent.identity)) return false;
      const flow = this.store.authorizations.get(identity);
      if ((flow && !isAuthorizationTerminal(flow.phase)) || (flow?.id ?? null) !== intent.flowId) return false;
      if (intent.kind === "bound") return this.matchesPreparedAuthorization(message, intent.authorization);
      const journal = this.store.credentialProvisioning.get(identity);
      if (journal && journal.operationId !== intent.operationId) return false;
      const state = this.store.credentials.get(identity);
      if (!state) return journal?.phase !== "completed";
      // 已完成预置只能接回本次原始占位绑定，不能接受后来的同ID授权或重建绑定。
      return Boolean(journal?.phase === "completed" && journal.initialAuthorizationGeneration
        && journal.initialAuthorizationGeneration === state.authorizationGeneration
        && journal.vaultId === state.vaultId && journal.credentialId === state.credentialId
        && state.status === "binding" && state.scopes.length === 0 && state.expiresAt === 0
        && !state.refreshToken && !state.pendingAccessToken);
    } catch { return false; }
  }

  async recoverUserTurn(message: IncomingMessage, intent: UserCredentialPreparationIntent): Promise<PreparedAuthorization> {
    validateUserCredentialPreparationIntent(intent);
    const expected = structuredClone(intent), incoming = structuredClone(message);
    const assertOriginal = () => {
      if (!this.matchesUserTurnIntent(incoming, expected)) throw new Error("用户授权准备绑定已变化或证据不完整，未恢复旧任务");
    };
    assertOriginal();
    if (expected.kind === "bound") {
      await this.refreshPreparedAuthorization(incoming, expected.authorization);
      return structuredClone(expected.authorization);
    }
    return this.exclusive(expected.identity, async () => {
      assertOriginal();
      if (!this.store.credentials.get(expected.identity)) {
        await provisionUserCredential(this.store, this.ark, expected.identity, assertOriginal, expected.operationId);
      }
      assertOriginal();
      const state = this.store.credentials.get(expected.identity)!;
      const proof: PreparedAuthorization = { version: 1, identity: expected.identity, flowId: expected.flowId,
        generation: state.authorizationGeneration!, vaultId: state.vaultId, credentialId: state.credentialId };
      validatePreparedAuthorization(proof);
      if (!this.matchesPreparedAuthorization(incoming, proof, true)) throw new Error("原用户凭证尚未就绪，未恢复旧任务");
      return proof;
    });
  }

  async prepareUserTurn(message: IncomingMessage, intent?: UserCredentialPreparationIntent): Promise<PreparedAuthorization> {
    if (intent !== undefined) return this.recoverUserTurn(message, intent);
    this.assertOpen();
    if (message.conversationType !== "direct") throw new Error("群聊不能准备个人授权身份");
    const identity = this.identity(message);
    this.assertNoActiveFlow(identity);
    const originalFlowId = this.store.authorizations.get(identity)?.id ?? null;
    const original = this.store.credentials.get(identity);
    if (!original) await this.ensureUserCredentialBinding(message);
    return this.exclusive(identity, async () => {
      this.assertNoActiveFlow(identity);
      const beforeRefresh = this.store.credentials.get(identity);
      if ((this.store.authorizations.get(identity)?.id ?? null) !== originalFlowId
        || (original?.authorizationGeneration && (beforeRefresh?.authorizationGeneration !== original.authorizationGeneration
          || beforeRefresh.vaultId !== original.vaultId || beforeRefresh.credentialId !== original.credentialId))) {
        throw new Error("用户授权在等待维护期间发生变化，未刷新替代凭证");
      }
      // 已绑定身份只领取一次维护租约；排队中的其他轮次会复用前一轮刷新结果。
      await this.refreshCredential(identity);
      this.assertNoActiveFlow(identity);
      let state = this.store.credentials.get(identity);
      if (!state) throw new Error("用户凭证绑定缺失，未继续执行");
      // 新输入尚未冻结准备证明时，确认失效并已同步占位凭证可以降为Bot能力，
      // 让实际工具错误继续触发OAuth；这不允许旧准备任务恢复或采纳新授予的权限。
      const confirmedLoss = state.status === "reauth_required" && !state.refreshToken && !state.pendingAccessToken
        && original?.vaultId === state.vaultId && original.credentialId === state.credentialId;
      if ((this.store.authorizations.get(identity)?.id ?? null) !== originalFlowId
        || (original?.authorizationGeneration && ((!confirmedLoss && state.authorizationGeneration !== original.authorizationGeneration)
          || state.vaultId !== original.vaultId || state.credentialId !== original.credentialId))) {
        throw new Error("用户授权在准备期间发生变化，未给旧任务生成新证明");
      }
      // 旧记录仅在本次明确准备时补写代次；不能替旧任务补造已保存的证明。
      if (!state.authorizationGeneration) state = this.store.credentials.save(identity, state, state.revision);
      const proof: PreparedAuthorization = { version: 1, identity, generation: state.authorizationGeneration!,
        vaultId: state.vaultId, credentialId: state.credentialId, flowId: this.store.authorizations.get(identity)?.id ?? null };
      validatePreparedAuthorization(proof);
      if (!this.matchesPreparedAuthorization(message, proof, true)) throw new Error("用户授权状态未就绪，未继续执行");
      return proof;
    });
  }

  matchesPreparedAuthorization(message: IncomingMessage, proof: PreparedAuthorization, forDispatch = false): boolean {
    try {
      this.assertOpen();
      if (message.conversationType !== "direct") return false;
      validatePreparedAuthorization(proof);
      const identity = this.identity(message);
      if (credentialIdentityKey(identity) !== credentialIdentityKey(proof.identity)) return false;
      const state = this.store.credentials.get(identity), flow = this.store.authorizations.get(identity);
      if ((flow && !isAuthorizationTerminal(flow.phase)) || (flow?.id ?? null) !== proof.flowId) return false;
      if (!state || state.authorizationGeneration !== proof.generation || state.vaultId !== proof.vaultId
        || state.credentialId !== proof.credentialId || ["refreshing", "refresh_uncertain"].includes(state.status)) return false;
      return !forDispatch || state.status === "binding" || state.status === "reauth_required"
        || (state.status === "ready" && state.expiresAt > Date.now());
    } catch { return false; }
  }

  async refreshPreparedAuthorization(message: IncomingMessage, proof: PreparedAuthorization): Promise<void> {
    if (!this.matchesPreparedAuthorization(message, proof)) throw new Error("用户授权绑定已变化或结果未知，未恢复旧任务");
    const expected = structuredClone(proof), identity = this.identity(message);
    await this.exclusive(identity, async () => {
      if (!this.matchesPreparedAuthorization(message, expected)) throw new Error("用户授权绑定已变化，未恢复旧任务");
      // 已有绑定的维护不调用provisioning；未知Token交换不会重试，只允许已落盘Token的同Credential同步。
      await this.refreshCredential(identity);
      if (!this.matchesPreparedAuthorization(message, expected, true)) throw new Error("用户授权在维护期间发生变化，未恢复旧任务");
    });
  }

  private assertNoActiveFlow(identity: CredentialIdentity): void {
    const flow = this.store.authorizations.get(identity);
    if (flow && !isAuthorizationTerminal(flow.phase)) throw new Error("当前用户仍有活跃授权流程，未准备其他单聊任务");
  }

  async ensureCredentialFresh(message: IncomingMessage): Promise<void> {
    if (message.conversationType !== "direct") return;
    const identity = this.identity(message), key = credentialIdentityKey(identity);
    let task = this.refreshing.get(key);
    if (!task) {
      task = this.exclusive(identity, () => this.refreshCredential(identity)).finally(() => this.refreshing.delete(key));
      this.refreshing.set(key, task);
    }
    await task;
  }

  private async refreshCredential(identity: CredentialIdentity): Promise<void> {
    let state = this.store.migrateEmployeeCredential(identity);
    if (!state || state.status === "binding" || state.status === "reauth_required") return;
    if (state.status === "refreshing" || state.status === "refresh_uncertain") {
      if (state.status === "refreshing") this.store.credentials.save(identity, { ...state, status: "refresh_uncertain" }, state.revision);
      throw new Error("用户凭证刷新结果尚未确认，已保留原Session与凭证记录；需检查授权状态后恢复，不能自动重复刷新");
    }
    if (state.status === "sync_pending" && (!state.refreshToken || state.expiresAt > Date.now())) {
      await this.syncCredential(identity, state); return;
    }
    if (state.retryAfter && state.retryAfter > Date.now()) throw new Error("用户凭证刷新暂时被限流，请稍后重试；已有授权未清除");
    if (state.status === "ready" && state.expiresAt - Date.now() > 5 * 60_000) return;
    if (!state.refreshToken) throw new Error("用户凭证缺少刷新信息，请检查授权状态");
    state = this.store.credentials.save(identity, { ...state, status: "refreshing", retryAfter: undefined }, state.revision);
    let tokens: OAuthTokens;
    try { tokens = await this.oauth.refresh(state.refreshToken!); }
    catch (error) {
      this.assertOpen();
      if (error instanceof OAuthError && error.kind === "reauth_required") {
        state = this.store.credentials.save(identity, { ...state, status: "sync_pending", refreshToken: undefined,
          pendingAccessToken: "ARKAGENT_USER_AUTH_PENDING", expiresAt: 0 }, state.revision, true);
        await this.syncCredential(identity, state); return;
      }
      const uncertain = !(error instanceof OAuthError) || error.outcome === "unknown";
      this.store.credentials.save(identity, { ...state, status: uncertain ? "refresh_uncertain" : "ready",
        retryAfter: error instanceof OAuthError && error.kind === "rate_limit" ? Date.now() + (error.retryAfterMs || 30_000) : undefined }, state.revision);
      if (error instanceof OAuthError) throw error;
      throw new Error("用户凭证刷新未完成，结果尚未确认；已有授权记录未清除");
    }
    this.assertOpen();
    // 飞书轮换成功后先落盘，再更新MA。MA失败或重启都只重试同一Credential同步。
    state = this.store.credentials.save(identity, { ...state, status: "sync_pending", refreshToken: tokens.refreshToken,
      pendingAccessToken: tokens.accessToken, expiresAt: tokens.expiresAt, scopes: tokens.scopes ?? state.scopes }, state.revision);
    await this.syncCredential(identity, state);
  }

  private async syncCredential(identity: CredentialIdentity, state: CredentialState): Promise<void> {
    if (!state.pendingAccessToken) throw new Error("用户凭证待同步数据缺失，请检查授权状态");
    try { await this.ark.updateEnvironmentCredential(state.vaultId, state.credentialId, state.pendingAccessToken); }
    catch { throw new Error("用户凭证同步到MA失败，已加密保存待同步结果，请稍后重试"); }
    // 停机时可能已经关闭数据库；待同步记录仍可供下次启动核查。
    if (this.closed) return;
    this.store.credentials.save(identity, { ...state, status: state.refreshToken ? "ready" : "reauth_required", pendingAccessToken: undefined }, state.revision);
  }

  async ensure(message: IncomingMessage, request: UserAuthorizationRequired): Promise<boolean> {
    if (this.closed) throw new Error("授权处理器已关闭");
    if (message.conversationType !== "direct") throw new Error("群聊仅使用Bot身份，不能申请个人授权");
    if (request.domain !== "calendar") throw new Error(`尚未配置 ${request.domain || "未知"} 域的用户授权，无法自动发起 OAuth`);
    const key = credentialIdentityKey(this.identity(message));
    const existing = this.pending.get(key);
    if (existing) {
      if (!existing.flow.messages.some(item => item.messageId === message.messageId)) {
        this.checkpoint(key, existing, { messages: [...existing.flow.messages, message] });
      }
      return false;
    }
    const pending: PendingAuthorization = { flow: this.store.authorizations.create(this.identity(message), [message]), controller: new AbortController() };
    this.pending.set(key, pending);
    this.setDeadline(key, pending, Date.now() + 30_000);
    try {
      this.publishState(pending.flow);
      const device = await this.oauth.begin(EMPLOYEE_CALENDAR_USER_SCOPES, pending.controller.signal);
      this.assertActive(key, pending);
      if (!Number.isFinite(device.expiresAt)) throw new OAuthError("invalid_response");
      if (device.expiresAt <= Date.now()) throw new OAuthError("expired", { outcome: "rejected" });
      this.checkpoint(key, pending, { phase: "card_pending", device, expiresAt: device.expiresAt });
      this.setDeadline(key, pending, device.expiresAt);
      await this.sendCard(message, device.verificationUrl);
      this.assertActive(key, pending);
      this.checkpoint(key, pending, { phase: "waiting" });
      this.launch(key, pending);
    } catch (error) {
      if (!this.isActive(key, pending)) return false;
      this.stop(key, pending, error instanceof OAuthError && error.kind === "expired" ? "expired" : "failed");
      throw error;
    }
    return false;
  }

  // 启动时只恢复本应用的流程。全局数据库锁防止两个Gateway同时重启同一轮询。
  restore(): number {
    this.assertOpen();
    this.store.assertRuntimeLock();
    if (!this.oauth.applicationId) throw new Error("恢复授权必须指定飞书应用身份");
    let count = 0;
    for (const flow of this.store.authorizations.listActive(this.oauth.applicationId)) {
      const key = credentialIdentityKey(flow.identity);
      if (this.pending.has(key)) continue;
      const pending: PendingAuthorization = { flow, controller: new AbortController(), restored: true };
      this.pending.set(key, pending); count++;
      this.publishState(flow);
      if (["starting", "card_pending", "polling"].includes(flow.phase)) {
        this.stop(key, pending, "uncertain");
        void this.notify(flow.messages[0], "网关重启时授权请求或卡片发送结果尚未确认，未重复交换Token或重放任务。请检查授权状态后重新发起所需操作。");
      } else if (flow.expiresAt <= Date.now() && flow.phase !== "sync_pending" && flow.phase !== "ready") {
        this.stop(key, pending, "expired");
        void this.notify(flow.messages[0], "上次授权流程已过期，未自动续跑任务。请重新发起所需操作。");
      } else {
        // 仅已校验身份的凭证恢复可使用刷新窗口；不能延长用户授权或身份校验期限。
        const refreshable = flow.phase === "sync_pending" || flow.phase === "ready";
        this.setDeadline(key, pending, refreshable ? Math.max(flow.expiresAt, Date.now() + 30_000) : flow.expiresAt);
        this.launch(key, pending);
      }
    }
    return count;
  }

  private launch(key: string, pending: PendingAuthorization): void {
    pending.task = this.complete(key, pending).catch(() => {
      // 存储损坏等非业务异常不暴露敏感payload，也不留下未处理Promise。
      console.error("授权恢复状态处理失败，请检查数据库；未自动重放业务任务");
    }).finally(() => this.removePending(key, pending));
  }

  private async complete(key: string, pending: PendingAuthorization): Promise<void> {
    const message = pending.flow.messages[0], identity = pending.flow.identity;
    try {
      if (pending.flow.phase === "waiting") {
        const device = pending.flow.device;
        if (!device) throw new Error("授权设备信息缺失");
        const tokens = await this.oauth.poll(device, pending.controller.signal, {
          nextPollAt: pending.flow.nextPollAt,
          onAttempt: () => this.checkpoint(key, pending, { phase: "polling" }),
          onPending: (nextPollAt, intervalMs) => this.checkpoint(key, pending,
            { phase: "waiting", nextPollAt, device: { ...device, intervalMs } })
        });
        // Token交换成功先加密落盘；校验用户信息的GET可在重启后安全重做。
        this.checkpoint(key, pending, { phase: "verifying", tokens, device: undefined, nextPollAt: undefined, expiresAt: tokens.expiresAt });
        this.setDeadline(key, pending, tokens.expiresAt);
      }
      if (pending.flow.phase === "verifying") {
        const tokens = pending.flow.tokens;
        if (!tokens || tokens.expiresAt <= Date.now()) throw new OAuthError("expired");
        const user = await this.oauth.getUserIdentity(tokens.accessToken, pending.controller.signal);
        this.assertActive(key, pending);
        if (user.openId !== message.senderId || user.tenantKey !== message.tenantId) throw new Error("授权账号或租户与消息发送者不一致");
        await this.ensureUserCredentialBinding(message);
        this.assertActive(key, pending);
        await this.exclusive(identity, async () => {
          this.assertActive(key, pending);
          pending.flow = this.store.stageAuthorizationCredential(pending.flow, tokens, EMPLOYEE_CALENDAR_USER_SCOPES);
        });
      }
      if (pending.flow.phase === "sync_pending" || pending.flow.phase === "ready") {
        await this.exclusive(identity, async () => {
          this.assertActive(key, pending);
          const current = this.store.credentials.get(identity);
          if (!current) throw new Error("授权凭证绑定缺失");
          await this.refreshCredential(identity);
          this.assertActive(key, pending);
          const updated = this.store.credentials.get(identity)!;
          if (updated.status !== "ready" || updated.expiresAt <= Date.now()) throw new Error("授权凭证状态尚未确认");
          this.checkpoint(key, pending, { phase: "ready", expiresAt: updated.expiresAt });
        });
      }
      this.assertActive(key, pending);
      const credential = this.store.credentials.get(identity);
      if (pending.flow.phase !== "ready" || credential?.status !== "ready") throw new Error("授权未就绪");
      for (const queued of pending.flow.messages) {
        const recovery = this.store.getAuthorizationRecovery(queued);
        if (recovery?.state === "resuming" || (pending.restored && !recovery)) {
          this.store.finishAuthorizationRecovery(queued, "blocked");
          void this.notify(queued, "用户授权已恢复，但上次业务投递结果尚未确认，未再次提交任务。请检查原Session执行记录后确认下一步。");
          continue;
        }
        if (recovery && recovery.state !== "waiting") continue;
        this.resume(queued, credential.vaultId);
      }
      this.checkpoint(key, pending, { phase: "completed" });
    } catch (error) {
      if (!this.isActive(key, pending)) return;
      const credentialStatus = this.store.credentials.get(identity)?.status;
      if (pending.flow.phase === "sync_pending" && (credentialStatus === "sync_pending" || credentialStatus === "ready")) {
        await this.notify(message, "用户凭证已加密保存，但同步到MA未完成。重启恢复时只重试同一凭证同步，不重新交换Token或重放已执行操作。");
        return;
      }
      const uncertain = credentialStatus === "refresh_uncertain" || credentialStatus === "refreshing"
        || (pending.flow.phase === "polling" && (!(error instanceof OAuthError) || error.outcome === "unknown"));
      this.stop(key, pending, error instanceof OAuthError && error.kind === "expired" ? "expired" : uncertain ? "uncertain" : "failed");
      const reason = error instanceof OAuthError && error.kind === "denied" ? "用户拒绝了授权"
        : error instanceof OAuthError && error.kind === "expired" ? "授权已过期"
        : "身份校验、网络请求或凭证同步未完成";
      await this.notify(message, `${reason}，本次任务未自动续跑。请检查授权状态后重新发起所需操作；已有飞书操作不会因此撤销。`);
    }
  }

  cancel(message: IncomingMessage): boolean {
    if (message.conversationType !== "direct" || this.closed) return false;
    const key = credentialIdentityKey(this.identity(message));
    let pending = this.pending.get(key);
    if (!pending) {
      const flow = this.store.authorizations.get(this.identity(message));
      if (!flow || isAuthorizationTerminal(flow.phase)) return false;
      pending = { flow, controller: new AbortController() };
      this.pending.set(key, pending);
    }
    this.stop(key, pending, "cancelled");
    return true;
  }

  // 只读本地检查点，不刷新Token、不恢复流程；授权完成和业务完成分别展示。
  status(message: IncomingMessage): string {
    this.assertOpen();
    if (message.conversationType !== "direct") return "群聊和话题仅使用 Bot 身份，不查询或申请个人用户授权。";
    const identity = this.identity(message);
    const credential = this.store.credentials.get(identity);
    const provisioning = !credential ? this.store.credentialProvisioning.get(identity) : undefined;
    const flow = this.store.authorizations.get(identity);
    const messages = flow?.messages.filter(item => item.conversationId === message.conversationId
      && (item.threadId || "") === (message.threadId || "")) || [];
    const lines = ["授权状态（本地记录，未实时校验飞书服务端）："];
    const credentialLabels: Record<CredentialState["status"], string> = {
      binding: "已预留用户凭证，尚未完成授权",
      ready: "本地凭证已就绪，不代表全部资源均有权限",
      refreshing: "刷新请求进行中；结果未确认前不会重复刷新",
      refresh_uncertain: "刷新结果尚未确认，需检查运行记录，不能自动重复刷新",
      sync_pending: "用户凭证已保存，等待同步到 MA",
      reauth_required: "需要重新授权，下一次实际调用按权限错误处理"
    };
    lines.push(`凭证：${!credential ? provisioning ? "用户凭证预置未完成，尚不能确认可用的用户凭证"
      : "没有当前应用身份的授权记录；旧版授权是否有效需另行核实"
      : credential.status === "ready" && credential.expiresAt <= Date.now() ? "凭证有效期已到，业务执行前需刷新或重新授权"
      : credentialLabels[credential.status]}`);
    if (provisioning) {
      const labels = { vault_pending: "Vault创建结果待确认", vault_confirmed: "Vault已记录，Credential尚未创建",
        credential_pending: "Credential创建结果待确认", ready: "资源回执已记录，本地绑定待确认",
        completed: "预置记录已完成但本地绑定缺失，需管理员核查" };
      lines.push(`预置：${labels[provisioning.phase]}。查询不会创建资源、发起授权或重放业务，请保留数据库及配套密钥供核查。`);
    }
    if (!flow || !messages.length) {
      lines.push("当前会话没有授权流程记录；本次查询不会创建授权或业务任务。");
      return lines.join("\n");
    }
    const phaseLabels: Record<AuthorizationFlow["phase"], string> = {
      starting: "正在发起授权请求", card_pending: "授权卡片发送结果待确认", waiting: "等待你完成授权",
      polling: "正在查询授权结果", verifying: "正在校验授权账号和租户", sync_pending: "已授权，等待同步到 MA",
      ready: "授权已就绪，等待任务恢复处理", completed: "授权流程已结束，不等于业务已完成",
      cancelled: "已取消本次授权等待", expired: "授权流程已过期", failed: "授权流程未完成",
      uncertain: "授权请求结果尚未确认，未自动重复交换凭证"
    };
    lines.push(`流程：${phaseLabels[flow.phase]}`);
    if (!isAuthorizationTerminal(flow.phase) && !["sync_pending", "ready"].includes(flow.phase)) {
      lines.push(flow.expiresAt <= Date.now() ? "等待期限已到，终态尚待处理；查询不会延长有效期。"
        : `当前阶段剩余等待时间约 ${Math.ceil((flow.expiresAt - Date.now()) / 1000)} 秒。`);
    }
    const recoveryLabels = {
      waiting: "等待授权恢复处理", resuming: "恢复任务已领取，执行结果尚待确认",
      completed: "恢复执行已结束，请以原任务回复和产物为准", failed: "恢复未完成，请核实执行记录，勿重复提交写入",
      blocked: "待确认，未自动重放；请核实已完成操作再明确剩余步骤",
      cancelled: "已取消续跑", expired: "已过期，未续跑"
    };
    // 只展示同会话的最近任务和标识，不返回原始请求、工具输入、凭证或授权链接。
    for (const item of messages.slice(-10)) {
      const recovery = this.store.getAuthorizationRecovery(item);
      const safeId = (value: string) => /^[\w-]{1,160}$/.test(value) ? value : "[标识已隐藏]";
      lines.push(`任务 ${safeId(item.messageId)}：${recovery ? recoveryLabels[recovery.state] : "没有恢复检查点，执行状态未知"}${recovery ? `（Session ${safeId(recovery.sessionId)}）` : ""}`);
    }
    if (messages.length > 10) lines.push(`仅展示最近 10 条，共 ${messages.length} 条关联任务。`);
    if (!isAuthorizationTerminal(flow.phase)) lines.push("可发送 /auth cancel 取消本次等待和续跑；不会撤销飞书授权或已完成操作。");
    return lines.join("\n");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // 关闭不是取消：保留可恢复阶段；正在交换Token的polling由下一次启动标记未确认。
    for (const [key, pending] of this.pending) {
      this.removePending(key, pending);
      pending.controller.abort(new OAuthError("cancelled"));
    }
  }

  private isActive(key: string, pending: PendingAuthorization): boolean {
    if (this.closed || this.pending.get(key) !== pending || pending.controller.signal.aborted) return false;
    const current = this.store.authorizations.get(pending.flow.identity);
    return current?.id === pending.flow.id && current.revision === pending.flow.revision && !isAuthorizationTerminal(current.phase);
  }

  private assertActive(key: string, pending: PendingAuthorization): void {
    if (!this.isActive(key, pending)) throw new OAuthError("cancelled");
  }

  private removePending(key: string, pending: PendingAuthorization): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (this.pending.get(key) === pending) this.pending.delete(key);
  }

  private checkpoint(key: string, pending: PendingAuthorization, patch: Parameters<GatewayStore["authorizations"]["save"]>[2]): void {
    this.assertActive(key, pending);
    pending.flow = this.store.authorizations.save(pending.flow.identity, pending.flow, patch);
    this.publishState(pending.flow);
  }

  private stop(key: string, pending: PendingAuthorization, state: "cancelled" | "expired" | "failed" | "uncertain"): void {
    this.assertActive(key, pending);
    pending.flow = this.store.finishAuthorizationFlow(pending.flow, state);
    this.removePending(key, pending);
    pending.controller.abort(new OAuthError(state === "expired" ? "expired" : "cancelled"));
    this.publishState(pending.flow);
  }

  private publishState(flow: AuthorizationFlow): void {
    this.lifecycle.onStateChange?.(flow.messages, flow.id, !isAuthorizationTerminal(flow.phase));
  }

  private setDeadline(key: string, pending: PendingAuthorization, expiresAt: number): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (!this.isActive(key, pending)) return;
      this.stop(key, pending, "expired");
      void this.notify(pending.flow.messages[0], "授权等待超时，本次任务未自动续跑。请重新发起所需操作；旧卡片不能恢复已过期的任务。");
    }, Math.max(0, Math.min(expiresAt - Date.now(), 2_147_483_647)));
    pending.timer.unref?.();
  }

  private async notify(message: IncomingMessage, text: string): Promise<void> {
    try {
      if (this.lifecycle.notify) await this.lifecycle.notify(message, text);
      else console.warn("用户授权未完成，调用方未提供状态通知处理器");
    } catch { console.warn("发送用户授权状态通知失败；未自动重放业务任务"); }
  }

  async ensureUserCredentialBinding(message: IncomingMessage): Promise<{ vaultId: string; credentialId: string }> {
    this.assertOpen();
    if (message.conversationType !== "direct") throw new Error("群聊不能挂载个人用户凭证");
    const identity = this.identity(message), key = credentialIdentityKey(identity);
    const existing = this.provisioning.get(key);
    if (existing) return existing;
    const provisioning = this.exclusive(identity, async () => {
      const current = this.store.migrateEmployeeCredential(identity);
      if (current) return { vaultId: current.vaultId, credentialId: current.credentialId };
      return provisionUserCredential(this.store, this.ark, identity, () => this.assertOpen());
    }).finally(() => {
      this.provisioning.delete(key);
    });
    this.provisioning.set(key, provisioning);
    return provisioning;
  }

  private identity(message: IncomingMessage): CredentialIdentity {
    const identity = { channelType: message.channelType, installationId: message.installationId, tenantId: message.tenantId, openId: message.senderId };
    credentialIdentityKey(identity);
    if (this.oauth.applicationId && message.installationId !== this.oauth.applicationId) throw new Error("授权应用与消息所属应用不一致");
    return identity;
  }

  private exclusive<T>(identity: CredentialIdentity, operation: () => Promise<T>): Promise<T> {
    const key = credentialIdentityKey(identity);
    const previous = this.operations.get(key);
    const task = (previous || Promise.resolve()).catch(() => undefined).then(async () => {
      this.assertOpen();
      const lease = this.store.credentials.acquire(identity);
      try { return await operation(); }
      finally { this.store.credentials.release(identity, lease); }
    }).finally(() => { if (this.operations.get(key) === task) this.operations.delete(key); });
    this.operations.set(key, task);
    return task;
  }

  private assertOpen(): void {
    if (this.closed) throw new OAuthError("cancelled");
  }
}
