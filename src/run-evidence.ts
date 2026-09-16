import { createHash } from "node:crypto";
import type { ArkEvent } from "./ark.ts";

export type ToolReceipt = {
  toolUseId: string; eventId: string; name: string; inputHash: string;
  effect: "read" | "write" | "unknown"; operation?: string;
  outcome: "succeeded" | "auth_required" | "failed" | "unknown";
  resultEventId?: string; resources: { type: string; id: string }[];
};
export type RunEvidence = {
  version: 1; complete: boolean; anchorEventId?: string;
  terminal: "idle" | "failed"; truncated: boolean; steps: ToolReceipt[];
};

const textOf = (event: ArkEvent): string => (Array.isArray(event.content) ? event.content : [])
  .filter(item => item && item.type === "text").map(item => String(item.text || "")).join("\n");
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function cliToolEnvelope(event: ArkEvent): { exitCode: number; payload?: Record<string, unknown> } | undefined {
  const text = textOf(event).trim();
  const exit = text.match(/^exit_code:\s*(\d+)\b/);
  if (!exit) return undefined;
  const sections = text.split(/--- (?:stdout|stderr|output \(stdout \+ stderr\)) ---\s*\n/).slice(1);
  const payloads: Record<string, unknown>[] = [];
  for (const section of sections) {
    const normalized = section.split("\n").map(line => line.replace(/^\s*\d+\t/, "")).join("\n").trim();
    if (!normalized) continue;
    try { const payload = JSON.parse(normalized); if (object(payload)) payloads.push(payload); }
    catch { /* 非JSON结果只保留退出码，不能猜测业务成功。 */ }
  }
  return { exitCode: Number(exit[1]), ...(payloads.length === 1 ? { payload: payloads[0] } : {}) };
}

function classify(name: string, input: unknown): Pick<ToolReceipt, "effect" | "operation"> {
  if (name === "read") return { effect: "read", operation: "read" };
  if (name !== "bash" || !object(input) || typeof input.command !== "string") return { effect: "unknown" };
  const command = input.command.trim();
  // 仅识别单个、无shell展开的CLI调用；复合命令/重定向/脚本保持unknown。
  if (command.length > 16_384 || /[;&|`$<>\n\r\\]/.test(command)) return { effect: "unknown" };
  const tokens: string[] = [];
  const part = /\s*(?:"([^"\\]*)"|'([^']*)'|([^\s"'\\]+))/gy;
  let end = 0;
  for (let match = part.exec(command); match; match = part.exec(command)) {
    tokens.push(match[1] ?? match[2] ?? match[3]); end = part.lastIndex;
  }
  if (end !== command.length || tokens[0] !== "lark-cli" || tokens.some(item => /^--(?:output|output-dir|file)(?:=|$)/.test(item))) return { effect: "unknown" };
  const operation = tokens.slice(1, tokens[2]?.startsWith("+") ? 3 : 4).join(" ");
  const reads = new Set(["calendar +agenda", "calendar +freebusy", "calendar calendars list", "calendar calendars get",
    "calendar events list", "calendar events get", "docs +fetch", "im +chat-messages-list", "im +threads-messages-list"]);
  const writes = new Set(["docs +create", "docs +update", "calendar events create", "calendar events update", "calendar events delete",
    "im +send", "im +reply"]);
  return reads.has(operation) ? { effect: "read", operation } : writes.has(operation) ? { effect: "write", operation } : { effect: "unknown" };
}

function resourceRefs(payload: Record<string, unknown> | undefined): ToolReceipt["resources"] {
  const allowed = new Set(["document_id", "event_id", "calendar_id", "message_id", "file_token", "app_token"]);
  const refs = new Map<string, { type: string; id: string }>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || refs.size >= 20 || !value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (refs.size >= 20) break;
      if (allowed.has(key) && typeof item === "string" && /^[\w-]{1,160}$/.test(item)) refs.set(`${key}:${item}`, { type: key, id: item });
      else if (typeof item === "object") visit(item, depth + 1);
    }
  };
  visit(payload?.data, 0);
  return [...refs.values()];
}

export class RunEvidenceCollector {
  private steps = new Map<string, ToolReceipt>();
  private results = new Map<string, { event: ArkEvent; auth: boolean }>();
  private seen = new Map<string, string>();
  private threads = new Set<string>();
  private anchorEventId?: string;
  private invalid = false;
  private truncated = false;

  observe(event: ArkEvent, authRequired = false): void {
    if (typeof event.session_thread_id === "string" && event.session_thread_id) {
      this.threads.add(event.session_thread_id);
      if (this.threads.size > 1) this.invalid = true;
    }
    if (/^agent\..*tool_(?:use|result)$/.test(String(event.type)) && !["agent.tool_use", "agent.tool_result"].includes(String(event.type))) {
      this.invalid = true; return;
    }
    if (!["user.message", "agent.tool_use", "agent.tool_result"].includes(String(event.type))) return;
    if (typeof event.id !== "string" || !event.id) { this.invalid = true; return; }
    const hash = createHash("sha256").update(JSON.stringify(event)).digest("hex");
    const previous = this.seen.get(event.id);
    if (previous) { if (previous !== hash) this.invalid = true; return; }
    if (this.seen.size >= 1000) { this.truncated = true; return; }
    this.seen.set(event.id, hash);
    if (event.type === "user.message") {
      if (this.anchorEventId) this.invalid = true;
      else this.anchorEventId = event.id;
      return;
    }
    const toolUseId = typeof event.tool_use_id === "string" && event.tool_use_id ? event.tool_use_id : event.type === "agent.tool_use" ? event.id : undefined;
    if (!toolUseId) { this.invalid = true; return; }
    if (event.type === "agent.tool_use") {
      if (this.steps.has(toolUseId) || this.steps.size >= 200) { this.invalid = true; this.truncated ||= this.steps.size >= 200; return; }
      const name = typeof event.name === "string" ? event.name.slice(0, 80) : "unknown";
      this.steps.set(toolUseId, { toolUseId, eventId: event.id, name, inputHash: createHash("sha256").update(JSON.stringify(event.input ?? null)).digest("hex"),
        ...classify(name, event.input), outcome: "unknown", resources: [] });
    } else {
      if (this.results.has(toolUseId)) { this.invalid = true; return; }
      // 不保留完整输出，Document/base64或Token不进入持久化证据。
      const envelope = cliToolEnvelope(event);
      const payload = envelope?.payload;
      const minimal = { id: event.id, is_error: event.is_error, name: event.name,
        _exitCode: envelope?.exitCode, _ok: payload?.ok, _resources: resourceRefs(payload) };
      this.results.set(toolUseId, { event: minimal, auth: authRequired });
    }
  }

  snapshot(terminal: "idle" | "failed"): RunEvidence {
    let complete = Boolean(this.anchorEventId) && !this.invalid && !this.truncated;
    for (const id of this.results.keys()) if (!this.steps.has(id)) complete = false;
    const steps = [...this.steps.values()].map(step => {
      const result = this.results.get(step.toolUseId);
      if (!result) return { ...step };
      const event = result.event;
      const outcome = result.auth && step.name === "bash" ? "auth_required" : event.is_error === true ? "failed"
        : step.name === "read" && event.is_error === false ? "succeeded"
        : event._exitCode === 0 && event._ok === true && event.is_error !== true ? "succeeded"
        : typeof event._exitCode === "number" && event._exitCode !== 0 ? "failed" : "unknown";
      return { ...step, outcome, resultEventId: event.id, resources: outcome === "succeeded" ? event._resources as ToolReceipt["resources"] : [] } as ToolReceipt;
    });
    return { version: 1, complete, anchorEventId: this.anchorEventId, terminal, truncated: this.truncated, steps };
  }
}

export function authorizationRecoveryDecision(evidence: RunEvidence | undefined): "read_only" | "writes_present" | "uncertain" {
  if (!evidence || evidence.version !== 1 || !evidence.complete || evidence.truncated || evidence.terminal !== "idle" || !evidence.steps.length) return "uncertain";
  if (evidence.steps.some(step => step.effect === "write" && step.outcome === "succeeded")) return "writes_present";
  if (!evidence.steps.some(step => step.outcome === "auth_required")) return "uncertain";
  return evidence.steps.every(step => step.effect === "read" && ["succeeded", "auth_required"].includes(step.outcome)) ? "read_only" : "uncertain";
}

export function authorizationContinuation(evidence: RunEvidence): string {
  if (authorizationRecoveryDecision(evidence) !== "read_only") throw new Error("执行证据不足，不能自动续跑");
  const ids = evidence.steps.filter(step => step.outcome === "auth_required").map(step => step.toolUseId);
  return `用户身份凭证已更新。这是原任务的授权恢复事件，不是重新开始原任务。\n仅继续本Session上轮因缺少用户凭证而未完成的步骤；不要重新执行已完成步骤。\n原任务事件：${evidence.anchorEventId}\n待继续的工具调用：${JSON.stringify(ids)}\n已核查此前步骤仅有读取。若任务状态与此记录不一致，停止并说明差异。`;
}
