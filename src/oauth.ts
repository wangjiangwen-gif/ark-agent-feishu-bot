export type OAuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
};

export type OAuthErrorKind = "reauth_required" | "configuration" | "permission" | "rate_limit" | "network" | "upstream" | "invalid_response" | "pending" | "denied" | "expired" | "cancelled" | "unknown";
export class OAuthError extends Error {
  readonly kind: OAuthErrorKind;
  readonly outcome: "rejected" | "unknown";
  readonly status?: number;
  readonly code?: string | number;
  readonly oauthType?: string;
  readonly retryAfterMs?: number;
  constructor(kind: OAuthErrorKind, options: { status?: number; code?: string | number; oauthType?: string; outcome?: "rejected" | "unknown"; retryAfterMs?: number } = {}) {
    super(`飞书 OAuth 请求未完成（${kind}${options.status ? `，HTTP ${options.status}` : ""}），请检查授权状态或稍后重试`);
    this.name = "OAuthError"; this.kind = kind; this.outcome = options.outcome || "unknown";
    this.status = options.status; this.code = options.code; this.retryAfterMs = options.retryAfterMs;
    this.oauthType = options.oauthType;
  }
}

export type DeviceAuthorization = {
  deviceCode: string;
  verificationUrl: string;
  expiresAt: number;
  intervalMs: number;
};

type Fetch = typeof fetch;

export class FeishuOAuth {
  private appId: string;
  private appSecret: string;
  private fetcher: Fetch;

  constructor(appId: string, appSecret: string, fetcher: Fetch = fetch) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.fetcher = fetcher;
  }

  get applicationId(): string { return this.appId; }

  async begin(scopes: string[], signal?: AbortSignal): Promise<DeviceAuthorization> {
    const body = new URLSearchParams({ client_id: this.appId, client_secret: this.appSecret });
    if (scopes.length) body.set("scope", scopes.join(" "));
    const payload = await this.request("https://accounts.feishu.cn/oauth/v1/device_authorization", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal
    });
    const deviceCode = stringField(payload, "device_code");
    const verificationUrl = stringField(payload, "verification_uri_complete") || stringField(payload, "verification_uri");
    if (!deviceCode || !verificationUrl) throw new Error("飞书 Device Flow 响应缺少授权地址或 device_code");
    return {
      deviceCode,
      verificationUrl,
      expiresAt: Date.now() + numberField(payload, "expires_in", 600) * 1000,
      intervalMs: numberField(payload, "interval", 5) * 1000
    };
  }

  async poll(device: DeviceAuthorization, signal?: AbortSignal): Promise<OAuthTokens> {
    if (signal?.aborted) throw cancellationError(signal);
    if (!Number.isFinite(device.expiresAt) || !Number.isFinite(device.intervalMs) || device.intervalMs <= 0) throw new OAuthError("invalid_response");
    if (Date.now() >= device.expiresAt) throw new OAuthError("expired", { outcome: "rejected" });
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new OAuthError("expired")), Math.min(device.expiresAt - Date.now(), 2_147_483_647));
    timer.unref?.();
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let interval = device.intervalMs;
    try {
      while (Date.now() < device.expiresAt) {
        try {
          const payload = await this.request("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
            method: "POST", headers: { "Content-Type": "application/json" }, signal: combined,
            body: JSON.stringify({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              client_id: this.appId, client_secret: this.appSecret, device_code: device.deviceCode
            })
          });
          return parseTokens(payload);
        } catch (error) {
          if (!(error instanceof OAuthError) || error.kind !== "pending") throw error;
          if (error.oauthType === "slow_down") interval += 5_000;
          await delay(Math.min(interval, Math.max(0, device.expiresAt - Date.now())), combined);
        }
      }
      throw new OAuthError("expired", { outcome: "rejected" });
    } finally { clearTimeout(timer); }
  }

  async refresh(refreshToken: string): Promise<OAuthTokens> {
    const payload = await this.request("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: this.appId, client_secret: this.appSecret, refresh_token: refreshToken })
    });
    return parseTokens(payload);
  }

  async getUserOpenId(accessToken: string): Promise<string> {
    return (await this.getUserIdentity(accessToken)).openId;
  }

  async getUserIdentity(accessToken: string, signal?: AbortSignal): Promise<{ openId: string; tenantKey?: string }> {
    const payload = await this.request("https://open.feishu.cn/open-apis/authen/v1/user_info", {
      headers: { Authorization: `Bearer ${accessToken}` }, signal
    });
    const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : payload;
    const openId = stringField(data, "open_id");
    if (!openId) throw new OAuthError("invalid_response");
    return { openId, tenantKey: stringField(data, "tenant_key") || undefined };
  }

  async ensureFresh(tokens: OAuthTokens, updateCredential: (accessToken: string) => Promise<void>): Promise<OAuthTokens> {
    if (tokens.expiresAt - Date.now() > 5 * 60_000) return tokens;
    const refreshed = await this.refresh(tokens.refreshToken);
    await updateCredential(refreshed.accessToken);
    return refreshed;
  }

  private async request(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    if (init.signal?.aborted) throw cancellationError(init.signal);
    let response: Response;
    const timeout = AbortSignal.timeout(30_000);
    try { response = await this.fetcher(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout }); }
    catch { throw init.signal?.aborted ? cancellationError(init.signal) : new OAuthError("network"); }
    const parsed: unknown = await response.json().catch(() => undefined);
    if (init.signal?.aborted) throw cancellationError(init.signal);
    const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    if (!response.ok || payload?.error || (typeof payload?.code === "number" && payload.code !== 0)) throw oauthError(response.status, payload || {}, response.headers.get("Retry-After"));
    if (!payload) throw new OAuthError("invalid_response", { status: response.status });
    return payload;
  }
}

function parseTokens(payload: Record<string, unknown>): OAuthTokens {
  const accessToken = stringField(payload, "access_token");
  const refreshToken = stringField(payload, "refresh_token");
  const expiresIn = Number(payload.expires_in);
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new OAuthError("invalid_response");
  return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000,
    ...(typeof payload.scope === "string" ? { scopes: payload.scope.split(/\s+/).filter(Boolean) } : {}) };
}

function oauthError(status: number, payload: Record<string, unknown>, retryHeader: string | null): OAuthError {
  // 不匹配自然语言msg，也不回显可能包含Token的服务端描述。未知数字码保留供诊断。
  const types: Record<string, OAuthErrorKind> = {
    invalid_grant: "reauth_required", invalid_client: "configuration", unauthorized_client: "configuration",
    invalid_scope: "permission", authorization_pending: "pending", slow_down: "pending",
    access_denied: "denied", expired_token: "expired"
  };
  // 官方v2刷新接口错误表（2026-09-16核验）。不能把应用不匹配20024当成用户重新授权。
  const codes: Record<number, OAuthErrorKind> = {
    20001: "configuration", 20002: "configuration", 20008: "permission", 20009: "configuration",
    20010: "permission", 20024: "configuration", 20026: "reauth_required", 20036: "configuration",
    20037: "reauth_required", 20048: "configuration", 20050: "upstream", 20063: "configuration",
    20064: "reauth_required", 20066: "permission", 20067: "configuration", 20068: "permission",
    20069: "configuration", 20070: "configuration", 20072: "upstream", 20073: "reauth_required", 20074: "configuration"
  };
  const symbol = typeof payload.error === "string" && Object.hasOwn(types, payload.error) ? payload.error : undefined;
  const knownCode = typeof payload.code === "number" ? codes[payload.code] : undefined;
  const kind = status === 429 ? "rate_limit" : status >= 500 ? "upstream" : knownCode || (symbol ? types[symbol] : "unknown");
  const delayMs = retryHeader ? (/^\d+(\.\d+)?$/.test(retryHeader) ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - Date.now()) : 30_000;
  return new OAuthError(kind, { status, code: typeof payload.code === "number" ? payload.code : symbol, oauthType: symbol,
    outcome: kind === "upstream" || kind === "unknown" ? "unknown" : "rejected",
    ...(kind === "rate_limit" ? { retryAfterMs: Number.isFinite(delayMs) ? Math.max(1_000, Math.min(delayMs, 300_000)) : 30_000 } : {}) });
}
function stringField(payload: Record<string, unknown>, key: string): string { return typeof payload[key] === "string" ? payload[key] : ""; }
function numberField(payload: Record<string, unknown>, key: string, fallback: number): number { const value = Number(payload[key]); return Number.isFinite(value) && value > 0 ? value : fallback; }
function cancellationError(signal: AbortSignal): OAuthError {
  return new OAuthError(signal.reason instanceof OAuthError && signal.reason.kind === "expired" ? "expired" : "cancelled");
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancellationError(signal)); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(cancellationError(signal)); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
