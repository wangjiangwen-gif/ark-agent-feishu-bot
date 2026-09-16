import { createHash } from "node:crypto";
import type { ArkEvent } from "./ark.ts";

type ReadObservation = {
  toolUseId: string; eventId: string; pathHash?: string; resultEventId?: string;
  outcome: "returned" | "error" | "missing_event" | "unknown"; hasDocument: boolean;
};
export type RunFileObservation = {
  version: 1; businessResult: "not_assessed"; ambiguous: boolean; truncated: boolean;
  replyTiming: "after_reads" | "before_reads_finished" | "none" | "unknown";
  unmatchedDocumentResults: number; reads: ReadObservation[];
};
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const idOf = (value: unknown): string | undefined => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : undefined;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function pathHash(input: unknown): string | undefined {
  if (typeof input === "string") {
    if (input.length > 16_384) return undefined;
    try { input = JSON.parse(input); } catch { return undefined; }
  }
  const path = object(input) ? input.file_path : undefined;
  return typeof path === "string" && path.startsWith("/") && path.length <= 4096 && !/[\u0000-\u001f]/.test(path) ? hash(path) : undefined;
}

// 只观察读取工具与回复的关系；返回Document不等于已理解，更不证明业务成功。
// 不保存工具输入、文件路径、文本、Base64，也不据此自动重试工具或模型。
export class RunFileObserver {
  private reads = new Map<string, { eventId: string; pathHash?: string; order: number }>();
  private results = new Map<string, { eventId: string; order: number; isError?: boolean; hasDocument: boolean }>();
  private seen = new Map<string, string>();
  private threads = new Set<string>();
  private order = 0;
  private lastReply = -1;
  private lastStamp = -Infinity;
  private ambiguous = false;
  private truncated = false;
  private unlinkedDocuments = 0;

  observe(event: ArkEvent): void {
    if (!["agent.tool_use", "agent.tool_result", "agent.message"].includes(String(event.type))) return;
    const read = event.type === "agent.tool_use" && event.name === "read";
    if (event.type === "agent.tool_use" && !read) return;
    const id = idOf(event.id);
    if (!id) { this.ambiguous = true; return; }
    const call = idOf(event.tool_use_id) || (read ? id : undefined);
    const content = Array.isArray(event.content) ? event.content : [];
    if (content.length > 128) this.truncated = true;
    const bounded = content.slice(0, 128);
    const hasDocument = bounded.some(item => object(item) && item.type === "document");
    const hasText = bounded.some(item => object(item) && item.type === "text" && typeof item.text === "string" && item.text.trim());
    const fileHash = read ? pathHash(event.input) : undefined;
    const signature = JSON.stringify([event.type, call, fileHash, event.is_error === true ? true : event.is_error === false ? false : null,
      hasDocument, hasText, idOf(event.session_thread_id), typeof event.processed_at === "string" ? event.processed_at.slice(0, 64) : null]);
    const previous = this.seen.get(id);
    if (previous !== undefined) { if (previous !== signature) this.ambiguous = true; return; }
    if (this.seen.size >= 1000) { this.truncated = true; return; }
    this.seen.set(id, signature);
    this.order++;
    if (idOf(event.session_thread_id)) this.threads.add(String(event.session_thread_id));
    if (this.threads.size > 1) this.ambiguous = true;
    const stamp = typeof event.processed_at === "string" ? Date.parse(event.processed_at) : NaN;
    if (Number.isFinite(stamp)) { if (stamp < this.lastStamp) this.ambiguous = true; this.lastStamp = Math.max(this.lastStamp, stamp); }
    if (read && call) {
      if (this.reads.size >= 128) { this.truncated = true; return; }
      if (this.reads.has(call)) { this.ambiguous = true; return; }
      this.reads.set(call, { eventId: id, pathHash: fileHash, order: this.order });
    } else if (event.type === "agent.tool_result") {
      if (!call) { this.ambiguous = true; if (hasDocument) this.unlinkedDocuments++; return; }
      if (this.results.has(call)) { this.ambiguous = true; return; }
      this.results.set(call, { eventId: id, order: this.order, isError: typeof event.is_error === "boolean" ? event.is_error : undefined, hasDocument });
    } else if (hasText) this.lastReply = this.order;
  }

  snapshot(): RunFileObservation | undefined {
    const unmatchedDocumentResults = this.unlinkedDocuments + [...this.results].filter(([call, result]) => result.hasDocument && !this.reads.has(call)).length;
    if (!this.reads.size && !unmatchedDocumentResults) return undefined;
    let ambiguous = this.ambiguous || unmatchedDocumentResults > 0, lastRead = -1;
    const reads = [...this.reads].map(([toolUseId, read]): ReadObservation => {
      const result = this.results.get(toolUseId);
      if (!result || result.order < read.order) ambiguous = true;
      lastRead = Math.max(lastRead, read.order, result?.order ?? -1);
      return { toolUseId, eventId: read.eventId, ...(read.pathHash ? { pathHash: read.pathHash } : {}),
        ...(result ? { resultEventId: result.eventId } : {}), hasDocument: result?.hasDocument || false,
        outcome: !result ? "missing_event" : result.isError === true ? "error" : result.isError === false ? "returned" : "unknown" };
    });
    return { version: 1, businessResult: "not_assessed", ambiguous, truncated: this.truncated, unmatchedDocumentResults, reads,
      replyTiming: ambiguous || this.truncated ? "unknown" : this.lastReply < 0 ? "none" : this.lastReply > lastRead ? "after_reads" : "before_reads_finished" };
  }
}

export function sanitizeFileObservation(value: unknown): RunFileObservation | undefined {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.reads)) return undefined;
  let invalid = false;
  const reads: ReadObservation[] = [];
  const calls = new Set<string>();
  for (const item of value.reads.slice(0, 128)) {
    if (!object(item) || !idOf(item.toolUseId) || !idOf(item.eventId)) { invalid = true; continue; }
    const outcome = ["returned", "error", "missing_event", "unknown"].includes(String(item.outcome)) ? item.outcome as ReadObservation["outcome"] : "unknown";
    if (calls.has(String(item.toolUseId)) || !idOf(item.resultEventId) || outcome === "missing_event" || outcome === "unknown") invalid = true;
    calls.add(String(item.toolUseId));
    reads.push({ toolUseId: String(item.toolUseId), eventId: String(item.eventId), outcome, hasDocument: item.hasDocument === true,
      ...(typeof item.pathHash === "string" && /^[a-f0-9]{64}$/.test(item.pathHash) ? { pathHash: item.pathHash } : {}),
      ...(idOf(item.resultEventId) ? { resultEventId: String(item.resultEventId) } : {}) });
  }
  const truncated = value.truncated === true || value.reads.length > 128;
  const count = value.unmatchedDocumentResults;
  const validCount = Number.isInteger(count) && Number(count) >= 0 && Number(count) <= 1000;
  const ambiguous = value.ambiguous === true || invalid || !validCount || Number(count) > 0;
  const replyTiming = !ambiguous && !truncated && ["after_reads", "before_reads_finished", "none"].includes(String(value.replyTiming))
    ? value.replyTiming as RunFileObservation["replyTiming"] : "unknown";
  return { version: 1, businessResult: "not_assessed", ambiguous, truncated, replyTiming, reads,
    unmatchedDocumentResults: validCount ? Number(count) : 0 };
}

export function parseStoredFileObservation(raw: string): RunFileObservation {
  // 诊断损坏不能泄露JSON解析错误中的原始内容，也不能伪装成“没有读取”。
  try {
    if (raw.length > 128 * 1024) throw new Error();
    const value = sanitizeFileObservation(JSON.parse(raw));
    if (value) return value;
  } catch { /* 下方统一提供安全错误 */ }
  throw new Error("文件读取观测记录无效，请检查本地审计数据库");
}
