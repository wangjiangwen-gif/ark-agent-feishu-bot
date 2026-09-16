import type { ArkClient, UserAuthorizationRequired } from "./ark.ts";
import type { IncomingMessage } from "./gateway.ts";
import type { FeishuOAuth } from "./oauth.ts";
import { OAuthError, type OAuthTokens } from "./oauth.ts";
import type { GatewayStore } from "./store.ts";
import { credentialIdentityKey, type CredentialIdentity, type CredentialState } from "./credential-state.ts";
import { createHash } from "node:crypto";
import { isAuthorizationTerminal, type AuthorizationFlow } from "./authorization-state.ts";

export const EMPLOYEE_CALENDAR_USER_SCOPES = ["offline_access", "auth:user.id:read", "calendar:calendar:read", "calendar:calendar.event:read", "calendar:calendar.free_busy:read"];

type EmployeeAuthArk = Pick<ArkClient, "listVaults" | "createVault" | "listCredentials" | "createEnvironmentVariableCredential" | "updateEnvironmentCredential">;
type PendingAuthorization = { flow: AuthorizationFlow; controller: AbortController; restored?: boolean; timer?: ReturnType<typeof setTimeout>; task?: Promise<void> };
type AuthorizationLifecycleOptions = { notify?: (message: IncomingMessage, text: string) => Promise<void> };

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
          pendingAccessToken: "ARKAGENT_USER_AUTH_PENDING", expiresAt: 0 }, state.revision);
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
  }

  private stop(key: string, pending: PendingAuthorization, state: "cancelled" | "expired" | "failed" | "uncertain"): void {
    this.assertActive(key, pending);
    pending.flow = this.store.finishAuthorizationFlow(pending.flow, state);
    this.removePending(key, pending);
    pending.controller.abort(new OAuthError(state === "expired" ? "expired" : "cancelled"));
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
      const name = `ark-employee-user-${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
      let vault = (await this.ark.listVaults()).find(item => item.displayName === name);
      this.assertOpen();
      if (!vault) vault = { id: await this.ark.createVault(name), displayName: name };
      this.assertOpen();
      const found = (await this.ark.listCredentials(vault.id)).find(item => item.secretName === "LARKSUITE_CLI_USER_ACCESS_TOKEN");
      this.assertOpen();
      const credentialId = found?.id || await this.ark.createEnvironmentVariableCredential(
        vault.id,
        "lark-cli-user-access-token",
        "LARKSUITE_CLI_USER_ACCESS_TOKEN",
        "ARKAGENT_USER_AUTH_PENDING"
      );
      this.assertOpen();
      this.store.credentials.save(identity, { vaultId: vault.id, credentialId, status: "binding", scopes: [], expiresAt: 0 }, 0);
      return { vaultId: vault.id, credentialId };
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
