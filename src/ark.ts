import { createHash } from "node:crypto";
import { ArkHttpError, ArkNetworkError, failureDiagnostic, safeErrorCode, safeRequestId } from "./ark-errors.ts";
export { ArkHttpError } from "./ark-errors.ts";
import { RunEvidenceCollector, type RunEvidence } from "./run-evidence.ts";
import { RunFileObserver, type RunFileObservation } from "./run-file-observation.ts";
import { inspectMountResources, validMountQuery, type FileMountQuery, type FileMountInspection } from "./mount-inspection.ts";
import { inspectUploadedFile, validUploadName, type FileUploadQuery, type FileUploadInspection } from "./upload-inspection.ts";
import {
  prepareSessionUpgrade, parseSessionUpgradeSnapshot, validUpgradeSessionId, validateUpgradeWait,
  type SessionUpgradeRequest, type SessionUpgradeSubmission, type SessionUpgradeObservation, type SessionUpgradeWaitOptions
} from "./session-upgrade.ts";

export type ArkEvent = Record<string, unknown> & { id?: string; type?: string; processed_at?: string };

export type RunResult = {
  terminal: "idle" | "failed";
  messages: string[];
  authorizationRequired?: UserAuthorizationRequired;
  evidence?: RunEvidence;
  fileObservation?: RunFileObservation;
};

export type RunInspection =
  | { status: "unknown"; reason: "history_unavailable" | "anchor_not_found" | "ambiguous_anchor" | "conflicting_event" | "later_request" | "multiple_threads" | "event_order_unknown" | "activity_after_terminal" | "terminal_not_observed"; anchorEventId?: string }
  | { status: "running"; anchorEventId: string }
  | { status: "ended"; anchorEventId: string; terminalEventId: string; result: RunResult };

export type UserAuthorizationRequired = {
  identity: "user";
  errorType: "authentication";
  subtype: "token_missing";
  domain?: string;
};

export type SessionStats = {
  eventCount: number;
  latestInputTokens?: number;
  latestTokenSampleId?: string;
  latestBusinessEventId?: string;
  latestEventId?: string;
  status?: "running" | "idle" | "failed";
  latestCompaction?: { eventId: string; eventCount: number; tokenSampleId?: string; businessEventId?: string };
};

export type CompactionObservation = {
  result: "succeeded" | "failed" | "unknown";
  terminal?: "idle" | "failed";
  reason: string;
  evidenceEventId?: string;
};

type ArkClientOptions = {
  sseHeadStartMs?: number;
  eventPollIntervalMs?: number;
  inspectionTimeoutMs?: number;
};

type RunBoundary = { startedAt: number; input: string; previousIds: Set<string>; anchored: boolean; page?: string };

export type AgentConfig = {
  name: string;
  description: string;
  model: { id: string };
  system: string;
  tools: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown>>;
  mcp_servers: Array<Record<string, unknown>>;
  metadata?: Record<string, string>;
};

export type EnvironmentConfig = {
  type: string;
  env?: Record<string, string>;
  networking?: Record<string, unknown>;
  packages?: Record<string, unknown>;
  setup_script?: string;
  [key: string]: unknown;
};

export type SessionResource = {
  type: string;
  [key: string]: unknown;
};

export type SessionCreateRequest = {
  agent: string | (Record<string, unknown> & { id: string; type: string });
  environment_id?: string;
  environment?: Record<string, unknown> & {
    id: string;
    type: "environment_with_overrides" | (string & {});
    config?: EnvironmentConfig;
  };
  resources?: SessionResource[];
  tags?: Array<Record<string, unknown> & { key: string; value?: string }>;
  title?: string;
  vault_ids?: string[];
  [key: string]: unknown;
};

export type SessionCreateDefaults = {
  agentId: string;
  environmentId: string;
  vaultIds?: string[];
  envOverrides?: Record<string, string>;
};

const LARK_CLI_VERSION = "1.0.88";
const LARK_CLI_SETUP_SCRIPT = `set -e
case "$(uname -m)" in
  x86_64) ARCH=amd64; SHA=497de20939acdd2aae4c898fea7a0ca71d5a459ed543202e762a8bcb3228effe ;;
  aarch64|arm64) ARCH=arm64; SHA=96a3cac444947456ce9971c912946323f20d14416434da7e274bd9d77d7ac28b ;;
  *) echo "unsupported architecture" >&2; exit 1 ;;
esac
ARCHIVE=/tmp/lark-cli.tar.gz
curl --fail --location --silent --show-error --connect-timeout 10 --max-time 120 "https://registry.npmmirror.com/-/binary/lark-cli/v${LARK_CLI_VERSION}/lark-cli-${LARK_CLI_VERSION}-linux-$ARCH.tar.gz" -o "$ARCHIVE"
echo "$SHA  $ARCHIVE" | sha256sum -c -
tar -xzf "$ARCHIVE" -C /usr/local/bin lark-cli
chmod 0755 /usr/local/bin/lark-cli
rm -f "$ARCHIVE"`;

export class ArkClient {
  private apiKey: string;
  private baseUrl: string;

  private fetcher: typeof fetch;
  private options: Required<ArkClientOptions>;
  private environmentConfigs = new Map<string, { config: EnvironmentConfig; fetchedAt: number }>();

  constructor(apiKey: string, baseUrl: string, fetcher: typeof fetch = fetch, options: ArkClientOptions = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.fetcher = fetcher;
    this.options = {
      sseHeadStartMs: options.sseHeadStartMs ?? 100,
      eventPollIntervalMs: options.eventPollIntervalMs ?? 750,
      inspectionTimeoutMs: options.inspectionTimeoutMs ?? 10_000
    };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const method = init.method || "GET";
    const signal = init.signal || AbortSignal.timeout(30_000);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
          ...init.headers
        },
        signal
      });
    } catch (error) {
      const operation = `${method} ${path.split("?")[0]}`.replaceAll(this.apiKey, "[redacted]");
      throw new ArkNetworkError(operation, signal.aborted ? signal.reason : error);
    }
    if (!response.ok) {
      const redactKnownSecret = (value: string | undefined): string | undefined => value && !value.includes(this.apiKey) ? value : undefined;
      const requestId = redactKnownSecret(safeRequestId(response.headers.get("x-request-id")));
      let code: string | undefined;
      let hint = "";
      try {
        const body = await boundedHistoryBody(response, 64 * 1024,
          AbortSignal.any([signal, AbortSignal.timeout(Math.min(5_000, this.options.inspectionTimeoutMs))]));
        // 兼容旧版纯文本格式错误，只提取固定提示，绝不复制上下文或据此认定可重试。
        if (path === "/files" && response.status === 400 && /file type not supported/i.test(body)) hint = ": file type not supported";
        const parsed = JSON.parse(body);
        code = redactKnownSecret(safeErrorCode(parsed?.error?.code));
      } catch { /* 不完整、超限或非JSON响应不提供结构化拒绝证明。 */ }
      throw new ArkHttpError(`方舟请求失败 ${response.status}${code ? ` ${code}` : ""}${requestId ? ` (${requestId})` : ""}${hint}`, response.status, code, requestId);
    }
    return response;
  }

  async getAgent(agentId: string): Promise<{ id: string; version?: string }> {
    const response = await this.request(`/agents/${encodeURIComponent(agentId)}`);
    const payload = await response.json() as Record<string, unknown>;
    const data = (payload.data || payload) as Record<string, unknown>;
    return { id: String(data.id || agentId), version: data.version === undefined ? undefined : String(data.version) };
  }

  // 这是原生协议层，不是普通聊天用户的升级入口。调用方须先校验身份并持久化提交意图。
  // 官方契约：https://docs.volcengine.com/docs/82379/2673930?lang=zh
  async upgradeSession(sessionId: string, request: SessionUpgradeRequest, signal?: AbortSignal): Promise<SessionUpgradeSubmission> {
    if (!validUpgradeSessionId(sessionId)) throw new Error("Session ID 无效");
    const prepared = prepareSessionUpgrade(request);
    signal?.throwIfAborted();
    const requestFingerprint = prepared.fingerprint;
    const combined = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    try {
      // initial_events也可能产生业务副作用，任何结果未知都不得自动重发。
      const response = await this.request(`/sessions/${encodeURIComponent(sessionId)}/upgrades`, {
        method: "POST", body: prepared.body, signal: combined
      });
      const body = await boundedHistoryBody(response, 4 * 1024 * 1024,
        AbortSignal.any([combined, AbortSignal.timeout(this.options.inspectionTimeoutMs)]));
      const snapshot = parseSessionUpgradeSnapshot(JSON.parse(body), sessionId);
      return snapshot ? { status: "accepted", requestFingerprint, snapshot }
        : { status: "unknown", reason: "invalid_response", requestFingerprint };
    } catch (error) {
      const rejected = error instanceof ArkHttpError && error.status === 400 && error.code === "InvalidParameter";
      return { status: rejected ? "rejected" : "unknown", reason: "request_failed", requestFingerprint, failure: failureDiagnostic(error) };
    }
  }

  async waitForSessionUpgrade(submission: SessionUpgradeSubmission, options: SessionUpgradeWaitOptions = {}): Promise<SessionUpgradeObservation> {
    const receipt = validateUpgradeWait(submission, options);
    let last = receipt.snapshot;
    let observedUpgrading = last.status === "upgrading";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    const observation = (status: SessionUpgradeObservation["status"], reason: SessionUpgradeObservation["reason"]): SessionUpgradeObservation => ({
      status, reason, snapshot: last, requestFingerprint: receipt.requestFingerprint,
      configurationVerified: false, businessResult: "not_assessed"
    });
    try {
      for (;;) {
        signal.throwIfAborted();
        const response = await this.request(`/sessions/${encodeURIComponent(last.sessionId)}`, { signal });
        const body = await boundedHistoryBody(response, 4 * 1024 * 1024, signal);
        let snapshot;
        try { snapshot = parseSessionUpgradeSnapshot(JSON.parse(body), last.sessionId); }
        catch { return observation("unknown", "invalid_response"); }
        if (!snapshot) return observation("unknown", "invalid_response");
        if (Date.parse(snapshot.updatedAt) < Date.parse(last.updatedAt)) return observation("unknown", "time_regressed");
        last = snapshot;
        if (snapshot.status === "idle") return observation(observedUpgrading ? "settled" : "unknown", observedUpgrading ? "upgrading_to_idle" : "transition_not_observed");
        if (snapshot.status !== "upgrading") return observation("unknown", "status_not_confirmed");
        observedUpgrading = true;
        await waitFor(options.pollIntervalMs ?? 750, signal);
      }
    } catch {
      if (options.signal?.aborted) return observation("unknown", "cancelled");
      if (controller.signal.aborted) return observation(last.status === "upgrading" ? "pending" : "unknown", "timeout");
      return observation("unknown", "query_failed");
    } finally { clearTimeout(timer); controller.abort(); }
  }

  async getSessionInfo(sessionId: string): Promise<{
    id: string; status?: string; agentId?: string; agentVersion?: string; environmentId?: string;
    appId?: string; vaultIds: string[]; systemFingerprint?: string;
  }> {
    const response = await this.request(`/sessions/${encodeURIComponent(sessionId)}`);
    const payload = await response.json() as Record<string, unknown>;
    const data = (payload.data || payload) as Record<string, unknown>;
    const agent = data.agent && typeof data.agent === "object" ? data.agent as Record<string, unknown> : undefined;
    const environment = data.environment && typeof data.environment === "object" ? data.environment as { id?: string; config?: EnvironmentConfig } : undefined;
    return {
      id: String(data.id || sessionId), status: typeof data.status === "string" ? data.status : undefined,
      agentId: typeof data.agent === "string" ? data.agent : typeof agent?.id === "string" ? agent.id : undefined,
      agentVersion: agent?.version === undefined ? undefined : String(agent.version),
      environmentId: typeof data.environment_id === "string" ? data.environment_id : environment?.id,
      appId: environment?.config?.env?.LARKSUITE_CLI_APP_ID,
      vaultIds: Array.isArray(data.vault_ids) ? data.vault_ids.filter((id): id is string => typeof id === "string") : [],
      systemFingerprint: typeof agent?.system === "string" ? createHash("sha256").update(agent.system).digest("hex") : undefined
    };
  }

  async updateAgent(agentId: string, version: string, config: AgentConfig): Promise<{ id: string; version?: string }> {
    const response = await this.request(`/agents/${encodeURIComponent(agentId)}`, { method: "POST", body: JSON.stringify({ ...config, version: Number(version) }) });
    const payload = await response.json() as Record<string, unknown>;
    const data = (payload.data || payload) as Record<string, unknown>;
    return { id: String(data.id || agentId), version: data.version === undefined ? undefined : String(data.version) };
  }

  async listAgents(): Promise<Array<{ id: string; name: string; version?: string }>> {
    const response = await this.request("/agents?limit=100");
    const payload = await response.json() as Record<string, unknown>;
    const items = Array.isArray(payload.data) ? payload.data : Array.isArray((payload.data as Record<string, unknown> | undefined)?.items) ? (payload.data as { items: unknown[] }).items : [];
    return items.map(item => {
      const record = item as Record<string, unknown>;
      return {
        id: String(record.id || ""),
        name: String(record.name || record.id || ""),
        version: record.version === undefined ? undefined : String(record.version)
      };
    }).filter(item => item.id);
  }

  async createAgent(config: AgentConfig): Promise<{ id: string; name: string; version?: string }> {
    const response = await this.request("/agents", { method: "POST", body: JSON.stringify(config) });
    const payload = await response.json() as Record<string, unknown>;
    const data = (payload.data || payload) as Record<string, unknown>;
    const id = String(data.id || data.agent_id || "");
    if (!id) throw new Error("创建 Agent 成功，但响应中没有 Agent ID");
    return { id, name: String(data.name || config.name), version: data.version === undefined ? undefined : String(data.version) };
  }

  async listEnvironments(): Promise<Array<{ id: string; name: string }>> {
    const response = await this.request("/environments?limit=100");
    const payload = await response.json() as Record<string, unknown>;
    const items = Array.isArray(payload.data) ? payload.data : Array.isArray((payload.data as Record<string, unknown> | undefined)?.items) ? (payload.data as { items: unknown[] }).items : [];
    return items.map(item => {
      const record = item as Record<string, unknown>;
      return { id: String(record.id || ""), name: String(record.name || record.id || "") };
    }).filter(item => item.id);
  }

  async createEnvironment(name: string, feishuAppId: string): Promise<{ id: string; name: string }> {
    const response = await this.request("/environments", {
      method: "POST",
      body: JSON.stringify({ name, config: {
        type: "cloud", networking: { type: "unrestricted" },
        env: {
          LARKSUITE_CLI_APP_ID: feishuAppId,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
          LARKSUITE_CLI_STRICT_MODE: "off"
        },
        setup_script: LARK_CLI_SETUP_SCRIPT
      } })
    });
    const payload = await response.json() as Record<string, unknown>;
    const data = (payload.data || payload) as Record<string, unknown>;
    const id = String(data.id || data.environment_id || "");
    if (!id) throw new Error("创建 Environment 成功，但响应中没有 Environment ID");
    return { id, name: String(data.name || name) };
  }

  async createVault(displayName: string): Promise<string> {
    const response = await this.request("/vaults", { method: "POST", body: JSON.stringify({ display_name: displayName }) });
    return responseId(await response.json(), "Vault");
  }

  async listVaults(): Promise<Array<{ id: string; displayName: string }>> {
    const response = await this.request("/vaults?limit=100");
    const payload = await response.json() as Record<string, unknown>;
    const items = Array.isArray(payload.data) ? payload.data : [];
    return items.map(item => {
      const record = item as Record<string, unknown>;
      return { id: String(record.id || ""), displayName: String(record.display_name || "") };
    }).filter(item => item.id);
  }

  async listCredentials(vaultId: string): Promise<Array<{ id: string; displayName: string; authType: string; secretName?: string }>> {
    const response = await this.request(`/vaults/${encodeURIComponent(vaultId)}/credentials?limit=100`);
    const payload = await response.json() as Record<string, unknown>;
    const items = Array.isArray(payload.data) ? payload.data : [];
    return items.map(item => {
      const record = item as Record<string, unknown>;
      const auth = (record.auth || {}) as Record<string, unknown>;
      return { id: String(record.id || ""), displayName: String(record.display_name || ""), authType: String(auth.type || ""), secretName: typeof auth.secret_name === "string" ? auth.secret_name : undefined };
    }).filter(item => item.id);
  }

  async createEnvironmentCredential(vaultId: string, displayName: string, secretValue: string): Promise<string> {
    return this.createEnvironmentVariableCredential(vaultId, displayName, "LARKSUITE_CLI_USER_ACCESS_TOKEN", secretValue);
  }

  async createEnvironmentVariableCredential(vaultId: string, displayName: string, secretName: string, secretValue: string): Promise<string> {
    const response = await this.request(`/vaults/${encodeURIComponent(vaultId)}/credentials`, {
      method: "POST", body: JSON.stringify({ display_name: displayName, auth: {
        type: "environment_variable", secret_name: secretName, secret_value: secretValue,
        networking: { type: "unrestricted" }
      } })
    });
    return responseId(await response.json(), "Credential");
  }

  async updateEnvironmentCredential(vaultId: string, credentialId: string, secretValue: string): Promise<void> {
    await this.request(`/vaults/${encodeURIComponent(vaultId)}/credentials/${encodeURIComponent(credentialId)}`, {
      method: "POST", body: JSON.stringify({ auth: { type: "environment_variable", secret_value: secretValue } })
    });
  }

  async getEnvironmentConfig(environmentId: string, options: { fresh?: boolean } = {}): Promise<EnvironmentConfig> {
    const cached = this.environmentConfigs.get(environmentId);
    if (cached && !options.fresh && Date.now() - cached.fetchedAt < 60_000) return structuredClone(cached.config);
    const response = await this.request(`/environments/${encodeURIComponent(environmentId)}`);
    const payload = await response.json() as Record<string, unknown>;
    const data = (payload.data || payload) as Record<string, unknown>;
    const config = data.config as EnvironmentConfig | undefined;
    if (!config || typeof config !== "object" || typeof config.type !== "string") throw new Error("Environment 响应缺少有效 config");
    this.environmentConfigs.set(environmentId, { config: structuredClone(config), fetchedAt: Date.now() });
    return structuredClone(config);
  }

  async buildSessionCreateRequest(defaults: SessionCreateDefaults): Promise<SessionCreateRequest> {
    const vaultIds = defaults.vaultIds || [];
    const envOverrides = defaults.envOverrides || {};
    const environmentConfig = Object.keys(envOverrides).length ? await this.getEnvironmentConfig(defaults.environmentId) : undefined;
    if (envOverrides.LARKSUITE_CLI_APP_ID && environmentConfig?.env?.LARKSUITE_CLI_APP_ID && environmentConfig.env.LARKSUITE_CLI_APP_ID !== envOverrides.LARKSUITE_CLI_APP_ID) throw new Error("Environment的LARKSUITE_CLI_APP_ID与当前FEISHU_APP_ID冲突，请显式修正绑定");
    return {
      agent: defaults.agentId,
      ...(environmentConfig ? {
        environment: {
          id: defaults.environmentId,
          type: "environment_with_overrides",
          config: { ...environmentConfig, env: { ...(environmentConfig.env || {}), ...envOverrides } }
        }
      } : { environment_id: defaults.environmentId }),
      ...(vaultIds.length ? { vault_ids: vaultIds } : {})
    };
  }

  async createSession(request: SessionCreateRequest): Promise<string>;
  async createSession(agentId: string, environmentId: string, vaultIds?: string[], envOverrides?: Record<string, string>): Promise<string>;
  async createSession(
    requestOrAgentId: SessionCreateRequest | string,
    environmentId?: string,
    vaultIds: string[] = [],
    envOverrides: Record<string, string> = {}
  ): Promise<string> {
    if (typeof requestOrAgentId === "string" && !environmentId) {
      throw new Error("创建 Session 必须提供 environmentId");
    }
    const request = typeof requestOrAgentId === "string"
      ? await this.buildSessionCreateRequest({
        agentId: requestOrAgentId,
        environmentId: environmentId || "",
        vaultIds,
        envOverrides
      })
      : requestOrAgentId;
    validateSessionCreateRequest(request);
    const response = await this.request("/sessions", {
      method: "POST",
      body: JSON.stringify(request)
    });
    const payload = await response.json() as Record<string, unknown>;
    const data = (payload.data || payload) as Record<string, unknown>;
    const id = String(data.id || data.session_id || "");
    if (!id) throw new Error("创建 Session 成功，但响应中没有 Session ID");
    return id;
  }

  async uploadFile(name: string, mimeType: string, bytes: Uint8Array, options: { uploadName: string } | undefined = undefined): Promise<{ id: string; name: string }> {
    if (options && !validUploadName(options.uploadName)) throw new Error("上传操作标识无效");
    const form = new FormData();
    form.set("purpose", "user_data");
    form.set("file", new Blob([new Uint8Array(bytes)], { type: mimeType || "application/octet-stream" }), options?.uploadName || name);
    const response = await this.request("/files", { method: "POST", body: form });
    const payload = await response.json() as Record<string, unknown>;
    const data = (payload.data || payload) as Record<string, unknown>;
    const id = String(data.id || "");
    if (!id) throw new Error(`上传文件 ${name} 成功，但响应中没有 File ID`);
    return { id, name: String(data.filename || name) };
  }

  async addSessionFile(sessionId: string, fileId: string, mountPath: string): Promise<void> {
    await this.addSessionResource(sessionId, { type: "file", file_id: fileId, mount_path: mountPath });
  }

  async addSessionResource(sessionId: string, resource: SessionResource): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/resources`, {
      method: "POST",
      body: JSON.stringify(resource)
    });
  }

  async inspectFileMount(query: FileMountQuery, signal?: AbortSignal): Promise<FileMountInspection> {
    if (!validMountQuery(query)) return { status: "unknown", reason: "invalid_resources" };
    const deadline = AbortSignal.timeout(this.options.inspectionTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      combined.throwIfAborted();
      // 此只读接口最多1000条、无分页；独立读取确保错误正文也不会无界读取或泄漏。
      const response = await this.fetcher(`${this.baseUrl}/sessions/${encodeURIComponent(query.sessionId)}/resources`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${this.apiKey}` }, signal: combined
      });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return { status: "unknown", reason: "resources_unavailable" }; }
      const body = await boundedHistoryBody(response, 4 * 1024 * 1024, combined);
      combined.throwIfAborted();
      return inspectMountResources(JSON.parse(body), query);
    } catch { return { status: "unknown", reason: "resources_unavailable" }; }
  }

  async inspectFileUpload(query: FileUploadQuery, signal?: AbortSignal): Promise<FileUploadInspection> {
    const deadline = AbortSignal.timeout(this.options.inspectionTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let remaining = 4 * 1024 * 1024;
    try {
      return await inspectUploadedFile(query, async path => {
        combined.throwIfAborted();
        const response = await this.fetcher(`${this.baseUrl}${path}`, {
          headers: { Accept: "application/json", Authorization: `Bearer ${this.apiKey}` }, signal: combined
        });
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error("文件核查接口不可用"); }
        const body = await boundedHistoryBody(response, remaining, combined);
        remaining -= Buffer.byteLength(body);
        combined.throwIfAborted();
        return JSON.parse(body);
      });
    } catch { return { status: "unknown", reason: "files_unavailable" }; }
  }

  async sendMessage(sessionId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      signal,
      body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text }] }] })
    });
  }

  async getSessionStats(sessionId: string, signal?: AbortSignal): Promise<SessionStats> {
    const history = await this.listSessionEvents(sessionId, signal);
    const events = [...new Map(history.map((event, index) => [event.id || `anonymous:${index}`, event])).values()];
    const stats: SessionStats = { eventCount: 0 };
    const threads = new Set(events.flatMap(event => typeof event.session_thread_id === "string" ? [event.session_thread_id] : []));
    let compactTurn = false;
    for (const event of events) {
      if (event.id) stats.latestEventId = event.id;
      if (event.type === "session.status_running") stats.status = "running";
      if (event.type === "session.status_idle") stats.status = "idle";
      if (event.type === "session.status_failed" || event.type === "session.error") stats.status = "failed";
      if (event.type === "user.message") {
        compactTurn = eventText(event).trim() === "/compact";
        if (!compactTurn && event.id) stats.latestBusinessEventId = event.id;
      }
      if (event.type === "agent.thread_context_compacted" && event.id && threads.size <= 1) {
        stats.latestCompaction = { eventId: event.id, eventCount: stats.eventCount,
          ...(stats.latestTokenSampleId ? { tokenSampleId: stats.latestTokenSampleId } : {}),
          ...(stats.latestBusinessEventId ? { businessEventId: stats.latestBusinessEventId } : {}) };
        continue;
      }
      // 压缩模型调用不是新的业务输入，不得用它再次触发压缩。
      if (compactTurn) {
        if (event.type === "session.status_idle" || event.type === "session.status_failed") compactTurn = false;
        continue;
      }
      stats.eventCount++;
      const usage = event.model_usage && typeof event.model_usage === "object"
        ? event.model_usage as Record<string, unknown>
        : undefined;
      const inputTokens = usage?.input_tokens;
      if (event.is_error !== true && typeof inputTokens === "number" && Number.isFinite(inputTokens) && inputTokens > 0) {
        stats.latestInputTokens = inputTokens;
        stats.latestTokenSampleId = event.id;
      }
    }
    return stats;
  }

  async inspectCompaction(sessionId: string, beforeEventId?: string, signal?: AbortSignal): Promise<CompactionObservation> {
    const history = await this.listSessionEvents(sessionId, signal);
    const events = [...new Map(history.map((event, index) => [event.id || `anonymous:${index}`, event])).values()];
    const boundary = beforeEventId ? events.findIndex(event => event.id === beforeEventId) : -1;
    if (beforeEventId && boundary < 0) return { result: "unknown", reason: "boundary_not_found" };
    const next = events.slice(boundary + 1);
    const command = next.findIndex(event => event.type === "user.message");
    if (command < 0 || eventText(next[command]).trim() !== "/compact") return { result: "unknown", reason: "command_not_found" };
    const current: ArkEvent[] = [];
    for (const event of next.slice(command + 1)) {
      if (event.type === "user.message") break;
      current.push(event);
      if (event.type === "session.status_idle" || event.type === "session.status_failed") break;
    }
    const result = terminalResult(current);
    if (result?.terminal === "failed") return { result: "failed", terminal: "failed", reason: "session_error" };
    // 官方事件契约：https://docs.volcengine.com/docs/82379/2559583?lang=zh
    // 同时要求本轮正常结束和明确压缩事件。多线程结果不能代表整个Session，暂不自动确认。
    const threads = new Set([...next.slice(0, command), ...current].flatMap(event => typeof event.session_thread_id === "string" ? [event.session_thread_id] : []));
    const proof = current.find(event => event.type === "agent.thread_context_compacted" && typeof event.id === "string");
    if (result?.terminal === "idle" && proof && threads.size <= 1) {
      return { result: "succeeded", terminal: "idle", reason: "thread_context_compacted", evidenceEventId: proof.id };
    }
    return { result: "unknown", ...(result ? { terminal: result.terminal } : {}), reason: result ? "missing_completion_evidence" : "run_not_terminal" };
  }

  async run(
    sessionId: string,
    text: string,
    timeoutMs: number,
    onProgress?: (progress: string) => Promise<void>,
    onDelta?: (snapshot: string) => Promise<void>
  ): Promise<RunResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Session 运行超时")), timeoutMs);
    let boundary: RunBoundary | undefined;
    try {
      const previous = await this.readSessionEvents(sessionId, controller.signal);
      boundary = { startedAt, input: text, previousIds: new Set(previous.events.flatMap(event => event.id ? [event.id] : [])), anchored: false, page: previous.lastPage };
      // 先发起 SSE 请求，但不等待服务端返回响应头。部分环境建立事件流约需
      // 15 秒；若在这里 await，会让 user.message 也被无谓阻塞。
      const eventStream = this.openEventStream(sessionId, controller.signal, Boolean(onDelta));
      await Promise.race([
        eventStream.then(() => undefined, () => undefined),
        waitFor(this.options.sseHeadStartMs, controller.signal)
      ]);
      await this.sendMessage(sessionId, text, controller.signal);
      let result = await Promise.any([
        this.consumeEventStream(eventStream, boundary, onProgress, onDelta),
        this.pollRunResult(sessionId, boundary, controller.signal)
      ]);
      if (result.authorizationRequired) {
        // SSE可能漏掉前面的写入或用户锚点。授权续跑只能依赖本轮完整历史，不把流式片段当证明。
        try {
          const history = await this.readSessionEvents(sessionId, AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)]), boundary.page);
          const verified = resultForBoundary(history.events, { ...boundary, anchored: false });
          result = { ...result, evidence: verified?.authorizationRequired ? verified.evidence : undefined };
        } catch {
          console.warn("授权任务历史核验失败，保留授权需求但禁止依据不完整证据自动续跑");
          result = { ...result, evidence: undefined };
        }
      }
      controller.abort();
      return result;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      const recovered = boundary ? await this.recoverTimedOutRun(sessionId, boundary) : undefined;
      if (recovered) return recovered;
      throw new Error("Session 运行超时");
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  }

  private async recoverTimedOutRun(sessionId: string, boundary: RunBoundary): Promise<RunResult | undefined> {
    // 超时边界常与最终 idle 只差几秒；短暂回查事件历史，避免已经完成的回复丢失。
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 5_000));
      const { events } = await this.readSessionEvents(sessionId, undefined, boundary.page);
      const result = resultForBoundary(events, boundary);
      if (result) return result;
    }
    return undefined;
  }

  async *streamEvents(sessionId: string, signal: AbortSignal): AsyncGenerator<ArkEvent> {
    yield* await this.openEventStream(sessionId, signal);
  }

  private async consumeEventStream(
    streamPromise: Promise<AsyncGenerator<ArkEvent>>,
    boundary: RunBoundary,
    onProgress?: (progress: string) => Promise<void>,
    onDelta?: (snapshot: string) => Promise<void>
  ): Promise<RunResult> {
    const messages: string[] = [];
    const files = new RunFileObserver();
    const seen = new Set<string>();
    const previews = new Map<string, Map<number, string>>();
    const toolDomains = new Map<string, string>();
    let authorizationRequired: UserAuthorizationRequired | undefined;
    let lastSnapshot = "";
    for await (const event of await streamPromise) {
      if (!belongsToRun(event, boundary)) continue;
      files.observe(event);
      if (event.id && seen.has(event.id)) continue;
      if (event.id) seen.add(event.id);
      rememberLarkCliToolDomain(event, toolDomains);
      authorizationRequired ||= eventUserAuthorizationRequired(event, toolDomains);
      if (event.type === "event_start") {
        const preview = event.event && typeof event.event === "object" ? event.event as Record<string, unknown> : undefined;
        if (preview?.type === "agent.message" && typeof preview.id === "string") previews.set(preview.id, new Map());
      }
      if (event.type === "event_delta" && typeof event.event_id === "string") {
        const blocks = previews.get(event.event_id);
        const delta = event.delta && typeof event.delta === "object" ? event.delta as Record<string, unknown> : undefined;
        const content = delta?.content && typeof delta.content === "object" ? delta.content as Record<string, unknown> : undefined;
        const index = typeof delta?.index === "number" ? delta.index : 0;
        if (blocks && delta?.type === "content_delta" && content?.type === "text" && typeof content.text === "string") {
          blocks.set(index, `${blocks.get(index) || ""}${content.text}`);
          const snapshot = [...blocks.entries()].sort(([left], [right]) => left - right).map(([, value]) => value).join("\n");
          if (!authorizationRequired && snapshot && snapshot !== lastSnapshot) {
            lastSnapshot = snapshot;
            await onDelta?.(snapshot);
          }
        }
      }
      if (event.type === "agent.message") {
        const text = eventText(event);
        if (text) {
          messages.push(text);
          if (!authorizationRequired && text !== lastSnapshot) {
            lastSnapshot = text;
            await onDelta?.(text);
          }
        }
        if (event.id) previews.delete(event.id);
      }
      const progress = eventProgress(event);
      if (progress) await onProgress?.(progress);
      if (["session.error", "session.status_failed", "session.status_idle"].includes(String(event.type))) {
        const fileObservation = files.snapshot();
        return { terminal: event.type === "session.status_idle" ? "idle" : "failed", messages,
          ...(fileObservation ? { fileObservation } : {}), ...(authorizationRequired ? { authorizationRequired } : {}) };
      }
    }
    throw new Error("事件流结束，但未观察到 Session 终态");
  }

  private async pollRunResult(sessionId: string, boundary: RunBoundary, signal: AbortSignal): Promise<RunResult> {
    while (!signal.aborted) {
      const { events } = await this.readSessionEvents(sessionId, signal, boundary.page);
      const result = resultForBoundary(events, { ...boundary });
      if (result) return result;
      await waitFor(this.options.eventPollIntervalMs, signal);
    }
    throw signal.reason || new Error("Session 事件轮询已取消");
  }

  private async listSessionEvents(sessionId: string, signal?: AbortSignal): Promise<ArkEvent[]> {
    return (await this.readSessionEvents(sessionId, signal)).events;
  }

  // 只核查已提交的原运行，不发送消息、不执行工具，也不将idle等同于业务成功。
  async inspectRun(sessionId: string, requestFingerprint: string, signal?: AbortSignal): Promise<RunInspection> {
    if (!/^[a-f0-9]{64}$/.test(requestFingerprint)) throw new Error("运行请求指纹必须是SHA256");
    const deadline = AbortSignal.timeout(this.options.inspectionTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      combined.throwIfAborted();
      const { events } = await this.readSessionEvents(sessionId, combined, undefined, true);
      combined.throwIfAborted();
      return inspectRunHistory(events, requestFingerprint);
    } catch {
      // 上游错误可能包含凭证或文档片段；核查状态只返回稳定原因，不转发原始错误。
      return { status: "unknown", reason: "history_unavailable" };
    }
  }

  private async readSessionEvents(sessionId: string, signal?: AbortSignal, startPage?: string, strict = false): Promise<{ events: ArkEvent[]; lastPage?: string }> {
    const events: ArkEvent[] = [];
    let page = startPage;
    const pages = new Set<string>();
    let bytes = 0;
    for (let count = 0; count < 100; count++) {
      signal?.throwIfAborted();
      const response = await this.request(`/sessions/${encodeURIComponent(sessionId)}/events?limit=200${page ? `&page=${encodeURIComponent(page)}` : ""}`, { signal });
      const body = strict ? await boundedHistoryBody(response, 64 * 1024 * 1024 - bytes, signal) : undefined;
      if (body !== undefined) {
        bytes += Buffer.byteLength(body);
        if (bytes > 64 * 1024 * 1024) throw new Error("事件历史超过核查大小上限");
      }
      const payload = (body === undefined ? await response.json() : JSON.parse(body)) as Record<string, unknown>;
      if (strict) validateInspectionPage(payload);
      const data = payload.data as { items?: ArkEvent[]; next_page?: string } | undefined;
      events.push(...(Array.isArray(payload.data) ? payload.data as ArkEvent[] : data?.items || []));
      if (strict && events.length > 20_000) throw new Error("事件历史超过核查数量上限");
      const nextPage = payload.next_page || data?.next_page;
      if (typeof nextPage !== "string" || !nextPage) return { events, lastPage: page };
      if (pages.has(nextPage)) throw new Error("Session 事件分页游标重复，不能确认完整运行结果");
      pages.add(nextPage);
      page = nextPage;
    }
    throw new Error("Session 事件历史超过安全翻页上限，不能确认完整运行结果");
  }

  private async openEventStream(sessionId: string, signal: AbortSignal, includeMessageDeltas = false): Promise<AsyncGenerator<ArkEvent>> {
    const deltaQuery = includeMessageDeltas ? "?event_deltas%5B%5D=agent.message" : "";
    const response = await this.fetcher(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events/stream${deltaQuery}`, {
      headers: { Accept: "text/event-stream", Authorization: `Bearer ${this.apiKey}` }, signal
    });
    if (!response.ok || !response.body) throw new Error(`方舟事件流失败 ${response.status}`);
    return parseEventStream(response.body);
  }
}

async function boundedHistoryBody(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) throw new Error("事件历史响应为空");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error("事件历史超过核查大小上限");
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function validateInspectionPage(payload: unknown): void {
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(payload)) throw new Error("无效事件历史结构");
  const data = payload.data;
  const items = Array.isArray(data) ? data : object(data) ? data.items : undefined;
  if (!Array.isArray(items) || items.some(event => !object(event) || typeof event.id !== "string" || !event.id || typeof event.type !== "string" || !event.type)) throw new Error("事件历史不完整");
  const cursors = [payload.next_page, object(data) ? data.next_page : undefined];
  if (cursors.some(cursor => cursor != null && typeof cursor !== "string")) throw new Error("无效事件分页游标");
  if (cursors.every(cursor => typeof cursor === "string") && cursors[0] !== cursors[1]) throw new Error("事件分页游标冲突");
}

function inspectRunHistory(events: ArkEvent[], requestFingerprint: string): RunInspection {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  const seen = new Map<string, string>();
  const unique: ArkEvent[] = [];
  for (const event of events) {
    const id = event.id!;
    const hash = createHash("sha256").update(JSON.stringify(canonical(event))).digest("hex");
    const previous = seen.get(id);
    if (previous && previous !== hash) return { status: "unknown", reason: "conflicting_event" };
    if (!previous) { seen.set(id, hash); unique.push(event); }
  }
  const anchors = unique.filter(event => event.type === "user.message" && Array.isArray(event.content)
    && event.content.length > 0 && event.content.every(item => item && item.type === "text" && typeof item.text === "string")
    && createHash("sha256").update(eventText(event)).digest("hex") === requestFingerprint);
  if (anchors.length !== 1) return { status: "unknown", reason: anchors.length ? "ambiguous_anchor" : "anchor_not_found" };
  const anchorEventId = anchors[0].id!;
  const unknown = (reason: Extract<RunInspection, { status: "unknown" }>["reason"]): RunInspection => ({ status: "unknown", reason, anchorEventId });
  const current = unique.slice(unique.indexOf(anchors[0]));
  if (current.slice(1).some(event => event.type === "user.message")) return unknown("later_request");
  const threads = new Set(current.map(event => event.session_thread_id).filter(value => typeof value === "string" && value));
  if (threads.size > 1) return unknown("multiple_threads");
  let stamp = -Infinity;
  for (const event of current) {
    if (event.processed_at === undefined) continue;
    const next = Date.parse(event.processed_at);
    if (!Number.isFinite(next) || next < stamp) return unknown("event_order_unknown");
    stamp = next;
  }
  const terminalIndex = current.findIndex(event => event.type === "session.status_idle" || event.type === "session.status_failed");
  if (terminalIndex < 0) return current.some(event => event.type === "session.status_running")
    ? { status: "running", anchorEventId } : unknown("terminal_not_observed");
  const tail = current.slice(terminalIndex + 1);
  if (tail.some(event => event.type?.startsWith("agent.") || ["session.status_running", "session.status_failed", "session.error"].includes(event.type!))) return unknown("activity_after_terminal");
  const result = terminalResult(current.slice(0, terminalIndex + 1))!;
  return { status: "ended", anchorEventId, terminalEventId: current[terminalIndex].id!, result };
}

function validateSessionCreateRequest(request: SessionCreateRequest): void {
  if (!request || !request.agent || (typeof request.agent !== "string" && typeof request.agent !== "object")) {
    throw new Error("创建 Session 必须提供 agent");
  }
  const hasEnvironment = request.environment !== undefined;
  const hasEnvironmentId = request.environment_id !== undefined;
  if (hasEnvironment === hasEnvironmentId) {
    throw new Error("environment 与 environment_id 必须且只能传一个");
  }
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ArkEvent> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      const parsed = drainEventBuffer(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) yield event;
    }
    const tail = buffer.trim();
    if (tail) for (const event of parseEventBlock(tail)) yield event;
}

function responseId(payload: unknown, resource: string): string {
  const envelope = payload as Record<string, unknown>;
  const data = (envelope.data || envelope) as Record<string, unknown>;
  const id = String(data.id || "");
  if (!id) throw new Error(`创建 ${resource} 成功，但响应中没有 ID`);
  return id;
}

export function drainEventBuffer(input: string): { events: ArkEvent[]; rest: string } {
  const normalized = input.replace(/\r\n/g, "\n");
  const events: ArkEvent[] = [];
  let cursor = 0;
  while (true) {
    const boundary = normalized.indexOf("\n\n", cursor);
    if (boundary < 0) break;
    events.push(...parseEventBlock(normalized.slice(cursor, boundary)));
    cursor = boundary + 2;
  }
  const rest = normalized.slice(cursor);
  if (!normalized.includes("\n\n") && rest.includes("\n")) {
    const lines = rest.split("\n");
    const pending = lines.pop() || "";
    const parsedLines = lines.flatMap(parseEventBlock);
    return { events: [...events, ...parsedLines], rest: pending };
  }
  return { events, rest };
}

export function eventProgress(event: ArkEvent): string | undefined {
  if (event.type === "agent.tool_result" && event.is_error === true) return "工具执行未成功，Agent 正在尝试恢复";
  if (event.type !== "agent.tool_use") return undefined;
  const name = typeof event.name === "string" ? event.name : "未知工具";
  const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
  const description = typeof input.description === "string" ? input.description.trim() : "";
  // 只展示 Agent 主动提供的简短描述，绝不转发 command、路径或完整工具参数。
  return description ? `正在执行：${description.slice(0, 120)}` : `正在调用工具：${name.slice(0, 80)}`;
}

export function resultFromEvents(events: ArkEvent[], startedAt: number): RunResult | undefined {
  const current = events.filter(event => {
    const timestamp = typeof event.processed_at === "string" ? Date.parse(event.processed_at) : NaN;
    return Number.isFinite(timestamp) && timestamp >= startedAt;
  });
  return terminalResult(current);
}

function belongsToRun(event: ArkEvent, boundary: RunBoundary): boolean {
  const preview = event.type === "event_start" ? event.event as ArkEvent | undefined : undefined;
  const id = preview?.id || (typeof event.event_id === "string" ? event.event_id : undefined) || event.id;
  if (id && boundary.previousIds.has(id)) return false;
  if (event.type === "user.message" && eventText(event) === boundary.input) boundary.anchored = true;
  const stamp = Date.parse(String(event.processed_at || preview?.processed_at || ""));
  // 用户事件建立本轮边界后不再依赖本机时钟；无边界的旧事件不能触发终态。
  return boundary.anchored || (Number.isFinite(stamp) ? stamp >= boundary.startedAt : boundary.previousIds.size === 0);
}

function resultForBoundary(events: ArkEvent[], boundary: RunBoundary): RunResult | undefined {
  const current = events.filter(event => belongsToRun(event, boundary));
  return terminalResult(current);
}

function terminalResult(current: ArkEvent[]): RunResult | undefined {
  const raw = current;
  current = [...new Map(current.map((event, index) => [event.id || `anonymous:${index}`, event])).values()];
  const failed = current.some(event => event.type === "session.error" || event.type === "session.status_failed");
  const idle = current.some(event => event.type === "session.status_idle");
  if (!failed && !idle) return undefined;
  const messages = current.filter(event => event.type === "agent.message").map(eventText).filter(Boolean);
  const toolDomains = new Map<string, string>();
  for (const event of current) rememberLarkCliToolDomain(event, toolDomains);
  const authorizationRequired = current.map(event => eventUserAuthorizationRequired(event, toolDomains)).find(Boolean);
  const terminal = failed ? "failed" : "idle";
  const files = new RunFileObserver();
  for (const event of raw) files.observe(event);
  const fileObservation = files.snapshot();
  const observed = fileObservation ? { fileObservation } : {};
  if (authorizationRequired) {
    const collector = new RunEvidenceCollector();
    for (const event of raw) collector.observe(event, Boolean(eventUserAuthorizationRequired(event, toolDomains)));
    return { terminal, messages, ...observed, authorizationRequired, evidence: collector.snapshot(terminal) };
  }
  return { terminal, messages, ...observed };
}

function rememberLarkCliToolDomain(event: ArkEvent, toolDomains: Map<string, string>): void {
  if (event.type !== "agent.tool_use" || typeof event.id !== "string") return;
  const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : undefined;
  if (typeof input?.command !== "string") return;
  const match = input.command.match(/(?:^|[;&|]\s*|\s)lark-cli\s+([a-z][\w-]*)\b/i);
  if (match) {
    toolDomains.set(event.id, match[1].toLowerCase());
    if (typeof event.tool_use_id === "string") toolDomains.set(event.tool_use_id, match[1].toLowerCase());
  }
}

export function eventUserAuthorizationRequired(
  event: ArkEvent,
  toolDomains: ReadonlyMap<string, string> = new Map()
): UserAuthorizationRequired | undefined {
  if (event.type !== "agent.tool_result") return undefined;
  const text = eventText(event).trim();
  if (!/^exit_code:\s*3\b/m.test(text)) return undefined;
  const marker = text.match(/--- (?:stderr|output \(stdout \+ stderr\)) ---\s*\n([\s\S]+)$/);
  if (!marker) return undefined;
  const normalized = marker[1].split("\n").map(line => line.replace(/^\s*\d+\t/, "")).join("\n").trim();
  const jsonStart = normalized.indexOf("{");
  const jsonEnd = normalized.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) return undefined;
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(normalized.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>; }
  catch { return undefined; }
  const error = payload.error && typeof payload.error === "object" ? payload.error as Record<string, unknown> : undefined;
  if (payload.ok !== false || payload.identity !== "user" || error?.type !== "authentication" || error.subtype !== "token_missing") return undefined;
  const toolUseId = typeof event.tool_use_id === "string" ? event.tool_use_id : "";
  const domain = toolDomains.get(toolUseId);
  return { identity: "user", errorType: "authentication", subtype: "token_missing", ...(domain ? { domain } : {}) };
}

function parseEventBlock(block: string): ArkEvent[] {
  const lines = block.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith(":"));
  if (!lines.length) return [];
  const dataLines = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trim());
  if (dataLines.length) return [JSON.parse(dataLines.join("\n")) as ArkEvent];
  return lines.map(line => JSON.parse(line) as ArkEvent);
}

export function eventText(event: ArkEvent): string {
  const content = Array.isArray(event.content) ? event.content as Array<Record<string, unknown>> : [];
  return content.filter(item => item.type === "text").map(item => String(item.text || "")).join("\n");
}
