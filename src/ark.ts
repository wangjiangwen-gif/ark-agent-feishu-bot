export type ArkEvent = Record<string, unknown> & { id?: string; type?: string; processed_at?: string };

export type RunResult = {
  terminal: "idle" | "failed";
  messages: string[];
  authorizationRequired?: UserAuthorizationRequired;
};

export type UserAuthorizationRequired = {
  identity: "user";
  errorType: "authentication";
  subtype: "token_missing";
  domain?: string;
};

export type SessionStats = {
  eventCount: number;
  latestInputTokens?: number;
};

type ArkClientOptions = {
  sseHeadStartMs?: number;
  eventPollIntervalMs?: number;
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
  private environmentConfigs = new Map<string, EnvironmentConfig>();

  constructor(apiKey: string, baseUrl: string, fetcher: typeof fetch = fetch, options: ArkClientOptions = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.fetcher = fetcher;
    this.options = {
      sseHeadStartMs: options.sseHeadStartMs ?? 100,
      eventPollIntervalMs: options.eventPollIntervalMs ?? 750
    };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const method = init.method || "GET";
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
        signal: init.signal || AbortSignal.timeout(30_000)
      });
    } catch (error) {
      throw new Error(`方舟网络请求失败（${method} ${path}）：${networkErrorDetail(error)}`, { cause: error });
    }
    if (!response.ok) {
      const requestId = response.headers.get("x-request-id");
      const body = await response.text();
      throw new Error(`方舟请求失败 ${response.status}${requestId ? ` (${requestId})` : ""}: ${body.slice(0, 300)}`);
    }
    return response;
  }

  async getAgent(agentId: string): Promise<{ id: string; version?: string }> {
    const response = await this.request(`/agents/${encodeURIComponent(agentId)}`);
    const payload = await response.json() as Record<string, unknown>;
    const data = (payload.data || payload) as Record<string, unknown>;
    return { id: String(data.id || agentId), version: data.version === undefined ? undefined : String(data.version) };
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

  async getEnvironmentConfig(environmentId: string): Promise<EnvironmentConfig> {
    const cached = this.environmentConfigs.get(environmentId);
    if (cached) return cached;
    const response = await this.request(`/environments/${encodeURIComponent(environmentId)}`);
    const payload = await response.json() as Record<string, unknown>;
    const data = (payload.data || payload) as Record<string, unknown>;
    const config = data.config as EnvironmentConfig | undefined;
    if (!config || typeof config !== "object" || typeof config.type !== "string") throw new Error("Environment 响应缺少有效 config");
    this.environmentConfigs.set(environmentId, config);
    return config;
  }

  async buildSessionCreateRequest(defaults: SessionCreateDefaults): Promise<SessionCreateRequest> {
    const vaultIds = defaults.vaultIds || [];
    const envOverrides = defaults.envOverrides || {};
    const environmentConfig = Object.keys(envOverrides).length ? await this.getEnvironmentConfig(defaults.environmentId) : undefined;
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

  async uploadFile(name: string, mimeType: string, bytes: Uint8Array): Promise<{ id: string; name: string }> {
    const form = new FormData();
    form.set("purpose", "user_data");
    form.set("file", new Blob([new Uint8Array(bytes)], { type: mimeType || "application/octet-stream" }), name);
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

  async sendMessage(sessionId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      signal,
      body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text }] }] })
    });
  }

  async getSessionStats(sessionId: string, signal?: AbortSignal): Promise<SessionStats> {
    const events = await this.listSessionEvents(sessionId, signal);
    let latestInputTokens: number | undefined;
    for (const event of events) {
      const usage = event.model_usage && typeof event.model_usage === "object"
        ? event.model_usage as Record<string, unknown>
        : undefined;
      const inputTokens = usage?.input_tokens;
      if (typeof inputTokens === "number" && Number.isFinite(inputTokens)) {
        latestInputTokens = inputTokens;
      }
    }
    return { eventCount: events.length, latestInputTokens };
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
      const result = await Promise.any([
        this.consumeEventStream(eventStream, boundary, onProgress, onDelta),
        this.pollRunResult(sessionId, boundary, controller.signal)
      ]);
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
    const seen = new Set<string>();
    const previews = new Map<string, Map<number, string>>();
    const toolDomains = new Map<string, string>();
    let authorizationRequired: UserAuthorizationRequired | undefined;
    let lastSnapshot = "";
    for await (const event of await streamPromise) {
      if (!belongsToRun(event, boundary)) continue;
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
      if (event.type === "session.error" || event.type === "session.status_failed") return { terminal: "failed", messages, ...(authorizationRequired ? { authorizationRequired } : {}) };
      if (event.type === "session.status_idle") return { terminal: "idle", messages, ...(authorizationRequired ? { authorizationRequired } : {}) };
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

  private async readSessionEvents(sessionId: string, signal?: AbortSignal, startPage?: string): Promise<{ events: ArkEvent[]; lastPage?: string }> {
    const events: ArkEvent[] = [];
    let page = startPage;
    const pages = new Set<string>();
    for (let count = 0; count < 100; count++) {
      const response = await this.request(`/sessions/${encodeURIComponent(sessionId)}/events?limit=200${page ? `&page=${encodeURIComponent(page)}` : ""}`, { signal });
      const payload = await response.json() as Record<string, unknown>;
      const data = payload.data as { items?: ArkEvent[]; next_page?: string } | undefined;
      events.push(...(Array.isArray(payload.data) ? payload.data as ArkEvent[] : data?.items || []));
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

function networkErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : typeof error.cause === "string" ? error.cause : "";
  return [error.message, cause].filter(Boolean).join("；").slice(0, 180);
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
  current = [...new Map(current.map((event, index) => [event.id || `anonymous:${index}`, event])).values()];
  const failed = current.some(event => event.type === "session.error" || event.type === "session.status_failed");
  const idle = current.some(event => event.type === "session.status_idle");
  if (!failed && !idle) return undefined;
  const messages = current.filter(event => event.type === "agent.message").map(eventText).filter(Boolean);
  const toolDomains = new Map<string, string>();
  for (const event of current) rememberLarkCliToolDomain(event, toolDomains);
  const authorizationRequired = current.map(event => eventUserAuthorizationRequired(event, toolDomains)).find(Boolean);
  return { terminal: failed ? "failed" : "idle", messages, ...(authorizationRequired ? { authorizationRequired } : {}) };
}

function rememberLarkCliToolDomain(event: ArkEvent, toolDomains: Map<string, string>): void {
  if (event.type !== "agent.tool_use" || typeof event.id !== "string") return;
  const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : undefined;
  if (typeof input?.command !== "string") return;
  const match = input.command.match(/(?:^|[;&|]\s*|\s)lark-cli\s+([a-z][\w-]*)\b/i);
  if (match) toolDomains.set(event.id, match[1].toLowerCase());
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
