export type ArkEvent = Record<string, unknown> & { id?: string; type?: string; processed_at?: string };

export type RunResult = {
  terminal: "idle" | "failed";
  messages: string[];
};

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

export class ArkClient {
  private apiKey: string;
  private baseUrl: string;

  private fetcher: typeof fetch;
  private environmentConfigs = new Map<string, EnvironmentConfig>();

  constructor(apiKey: string, baseUrl: string, fetcher: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.fetcher = fetcher;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
        ...init.headers
      },
      signal: init.signal || AbortSignal.timeout(30_000)
    });
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
        env: { LARKSUITE_CLI_APP_ID: feishuAppId },
        setup_script: "set -e\nnpm install -g @larksuite/cli\nlark-cli --version"
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
    const response = await this.request(`/vaults/${encodeURIComponent(vaultId)}/credentials`, {
      method: "POST", body: JSON.stringify({ display_name: displayName, auth: {
        type: "environment_variable", secret_name: "LARKSUITE_CLI_USER_ACCESS_TOKEN", secret_value: secretValue,
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

  async createSession(agentId: string, environmentId: string, vaultIds: string[] = [], envOverrides: Record<string, string> = {}): Promise<string> {
    const environmentConfig = Object.keys(envOverrides).length ? await this.getEnvironmentConfig(environmentId) : undefined;
    const response = await this.request("/sessions", {
      method: "POST",
      body: JSON.stringify({
        agent: agentId,
        ...(environmentConfig ? {
          environment: {
            id: environmentId,
            type: "environment_with_overrides",
            config: { ...environmentConfig, env: { ...(environmentConfig.env || {}), ...envOverrides } }
          }
        } : { environment_id: environmentId }),
        ...(vaultIds.length ? { vault_ids: vaultIds } : {})
      })
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
    form.set("file", new Blob([bytes], { type: mimeType || "application/octet-stream" }), name);
    const response = await this.request("/files", { method: "POST", body: form });
    const payload = await response.json() as Record<string, unknown>;
    const data = (payload.data || payload) as Record<string, unknown>;
    const id = String(data.id || "");
    if (!id) throw new Error(`上传文件 ${name} 成功，但响应中没有 File ID`);
    return { id, name: String(data.filename || name) };
  }

  async addSessionFile(sessionId: string, fileId: string, mountPath: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/resources`, {
      method: "POST",
      body: JSON.stringify({ type: "file", file_id: fileId, access: "read_only", mount_path: mountPath })
    });
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text }] }] })
    });
  }

  async run(sessionId: string, text: string, timeoutMs: number, onProgress?: (progress: string) => Promise<void>): Promise<RunResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Session 运行超时")), timeoutMs);
    const messages: string[] = [];
    const seen = new Set<string>();
    try {
      // 先建立事件流再发送消息，避免快速完成的 Agent 在 SSE 订阅建立前
      // 已经产生 message + idle，导致 Gateway 永久等待下一条事件。
      const eventStream = await this.openEventStream(sessionId, controller.signal);
      await this.sendMessage(sessionId, text);
      for await (const event of eventStream) {
        if (event.id && seen.has(event.id)) continue;
        if (event.id) seen.add(event.id);
        if (event.type === "agent.message") {
          const text = eventText(event);
          if (text) messages.push(text);
        }
        const progress = eventProgress(event);
        if (progress) await onProgress?.(progress);
        if (event.type === "session.error" || event.type === "session.status_failed") return { terminal: "failed", messages };
        if (event.type === "session.status_idle") return { terminal: "idle", messages };
      }
      throw new Error("事件流结束，但未观察到 Session 终态");
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      const recovered = await this.recoverTimedOutRun(sessionId, startedAt);
      if (recovered) return recovered;
      throw new Error("Session 运行超时");
    } finally {
      clearTimeout(timer);
    }
  }

  private async recoverTimedOutRun(sessionId: string, startedAt: number): Promise<RunResult | undefined> {
    // 超时边界常与最终 idle 只差几秒；短暂回查事件历史，避免已经完成的回复丢失。
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 5_000));
      const response = await this.request(`/sessions/${encodeURIComponent(sessionId)}/events?limit=200`);
      const payload = await response.json() as Record<string, unknown>;
      const events = Array.isArray(payload.data) ? payload.data as ArkEvent[] : [];
      const result = resultFromEvents(events, startedAt);
      if (result) return result;
    }
    return undefined;
  }

  async *streamEvents(sessionId: string, signal: AbortSignal): AsyncGenerator<ArkEvent> {
    yield* await this.openEventStream(sessionId, signal);
  }

  private async openEventStream(sessionId: string, signal: AbortSignal): Promise<AsyncGenerator<ArkEvent>> {
    const response = await this.fetcher(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events/stream`, {
      headers: { Accept: "text/event-stream", Authorization: `Bearer ${this.apiKey}` }, signal
    });
    if (!response.ok || !response.body) throw new Error(`方舟事件流失败 ${response.status}`);
    return parseEventStream(response.body);
  }
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
  const failed = current.some(event => event.type === "session.error" || event.type === "session.status_failed");
  const idle = current.some(event => event.type === "session.status_idle");
  if (!failed && !idle) return undefined;
  const messages = current.filter(event => event.type === "agent.message").map(eventText).filter(Boolean);
  return { terminal: failed ? "failed" : "idle", messages };
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
