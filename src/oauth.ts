export type OAuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

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

  async begin(scopes: string[]): Promise<DeviceAuthorization> {
    const body = new URLSearchParams({ client_id: this.appId, client_secret: this.appSecret });
    if (scopes.length) body.set("scope", scopes.join(" "));
    const payload = await this.request("https://accounts.feishu.cn/oauth/v1/device_authorization", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body
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

  async poll(device: DeviceAuthorization): Promise<OAuthTokens> {
    let interval = device.intervalMs;
    while (Date.now() < device.expiresAt) {
      const response = await this.fetcher("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: this.appId, client_secret: this.appSecret, device_code: device.deviceCode
        })
      });
      const payload = await response.json() as Record<string, unknown>;
      if (response.ok && payload.access_token) return parseTokens(payload);
      const error = String(payload.error || payload.msg || "unknown_error");
      if (error === "authorization_pending") { await delay(interval); continue; }
      if (error === "slow_down") { interval += 5_000; await delay(interval); continue; }
      throw oauthError(response.status, payload);
    }
    throw new Error("飞书用户授权链接已过期，请重新运行 arkagent login；首次使用请运行 arkagent init");
  }

  async refresh(refreshToken: string): Promise<OAuthTokens> {
    const payload = await this.request("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: this.appId, client_secret: this.appSecret, refresh_token: refreshToken })
    });
    return parseTokens(payload, refreshToken);
  }

  async getUserOpenId(accessToken: string): Promise<string> {
    const payload = await this.request("https://open.feishu.cn/open-apis/authen/v1/user_info", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const openId = stringField(payload, "open_id") || stringField((payload.data || {}) as Record<string, unknown>, "open_id");
    if (!openId) throw new Error("飞书用户信息响应缺少 open_id");
    return openId;
  }

  async ensureFresh(tokens: OAuthTokens, updateCredential: (accessToken: string) => Promise<void>): Promise<OAuthTokens> {
    if (tokens.expiresAt - Date.now() > 5 * 60_000) return tokens;
    const refreshed = await this.refresh(tokens.refreshToken);
    await updateCredential(refreshed.accessToken);
    return refreshed;
  }

  private async request(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.fetcher(url, { ...init, signal: init.signal || AbortSignal.timeout(30_000) });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || payload.error || (typeof payload.code === "number" && payload.code !== 0)) throw oauthError(response.status, payload);
    return payload;
  }
}

function parseTokens(payload: Record<string, unknown>, fallbackRefresh = ""): OAuthTokens {
  const accessToken = stringField(payload, "access_token");
  const refreshToken = stringField(payload, "refresh_token") || fallbackRefresh;
  if (!accessToken || !refreshToken) throw new Error("飞书 OAuth 响应缺少 access_token 或 refresh_token；请确认请求包含 offline_access");
  return { accessToken, refreshToken, expiresAt: Date.now() + numberField(payload, "expires_in", 7200) * 1000 };
}

function oauthError(status: number, payload: Record<string, unknown>): Error {
  return new Error(`飞书 OAuth 请求失败 ${status}: ${String(payload.error_description || payload.msg || payload.error || payload.code || "未知错误")}`);
}
function stringField(payload: Record<string, unknown>, key: string): string { return typeof payload[key] === "string" ? payload[key] : ""; }
function numberField(payload: Record<string, unknown>, key: string, fallback: number): number { const value = Number(payload[key]); return Number.isFinite(value) && value > 0 ? value : fallback; }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
