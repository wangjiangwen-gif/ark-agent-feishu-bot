import type { SessionStats } from "./ark.ts";

export type CompactionResult = "running" | "succeeded" | "failed" | "unknown" | "no_effect";
export type CompactionCheckpoint = {
  baselineEventCount: number;
  consumedTokenSampleId?: string;
  lastBusinessEventId?: string;
  lastMessageId?: string;
  failures: number;
  paused: boolean;
  cooldownUntil: number;
  platformCompactionEventId?: string;
  attempt?: {
    source: "manual" | "automatic";
    messageId: string;
    beforeEventId?: string;
    afterEventId?: string;
    startedAt: number;
    endedAt?: number;
    result: CompactionResult;
    evidenceEventId?: string;
    terminal?: "idle" | "failed";
  };
};

export function baselineCompaction(stats: SessionStats): CompactionCheckpoint {
  return {
    baselineEventCount: stats.eventCount,
    consumedTokenSampleId: stats.latestTokenSampleId,
    lastBusinessEventId: stats.latestBusinessEventId,
    failures: 0, paused: false, cooldownUntil: 0,
    ...(stats.latestCompaction ? { platformCompactionEventId: stats.latestCompaction.eventId } : {})
  };
}

export function decideCompaction(
  checkpoint: CompactionCheckpoint | undefined, stats: SessionStats, messageId: string, now: number,
  limits: { maxEvents?: number; maxInputTokens?: number } = {}
): { compact: boolean; checkpoint: CompactionCheckpoint } {
  if (!checkpoint) return { compact: false, checkpoint: baselineCompaction(stats) };
  const waiting = checkpoint.attempt?.result === "running" || checkpoint.attempt?.result === "unknown";
  const platform = stats.latestCompaction;
  if (!waiting && stats.status === "idle" && platform && platform.eventId !== checkpoint.platformCompactionEventId) {
    return { compact: false, checkpoint: { ...checkpoint, baselineEventCount: platform.eventCount,
      consumedTokenSampleId: platform.tokenSampleId, lastBusinessEventId: platform.businessEventId,
      platformCompactionEventId: platform.eventId, failures: 0, paused: false, cooldownUntil: now + 300000 } };
  }
  const newBusiness = Boolean(stats.latestBusinessEventId && stats.latestBusinessEventId !== checkpoint.lastBusinessEventId);
  const freshSample = Boolean(stats.latestTokenSampleId && stats.latestTokenSampleId !== checkpoint.consumedTokenSampleId);
  const oversized = stats.eventCount - checkpoint.baselineEventCount >= (limits.maxEvents ?? 120)
    || (freshSample && (stats.latestInputTokens ?? 0) >= (limits.maxInputTokens ?? 20000));
  return {
    compact: !waiting && !checkpoint.paused && now >= checkpoint.cooldownUntil
      && checkpoint.lastMessageId !== messageId && stats.status === "idle" && newBusiness && oversized,
    checkpoint
  };
}

export function startCompaction(
  checkpoint: CompactionCheckpoint, stats: SessionStats, messageId: string,
  source: "manual" | "automatic", now: number
): CompactionCheckpoint {
  return {
    ...checkpoint, consumedTokenSampleId: stats.latestTokenSampleId,
    lastBusinessEventId: stats.latestBusinessEventId, lastMessageId: messageId,
    attempt: { source, messageId, beforeEventId: stats.latestEventId, startedAt: now, result: "running" }
  };
}

export function finishCompaction(
  checkpoint: CompactionCheckpoint, result: Exclude<CompactionResult, "running">,
  stats: SessionStats | undefined, now: number, cooldownMs = 300000,
  evidence?: { eventId?: string; terminal?: "idle" | "failed" }
): CompactionCheckpoint {
  if (!checkpoint.attempt) throw new Error("压缩检查点缺少执行记录");
  const failures = result === "succeeded" ? 0 : checkpoint.failures + (result === "failed" || result === "no_effect" ? 1 : 0);
  return {
    ...checkpoint,
    ...(result === "succeeded" && stats ? {
      baselineEventCount: stats.eventCount,
      consumedTokenSampleId: stats.latestTokenSampleId,
      lastBusinessEventId: stats.latestBusinessEventId,
      platformCompactionEventId: stats.latestCompaction?.eventId || checkpoint.platformCompactionEventId
    } : {}),
    failures, paused: failures >= 2, cooldownUntil: now + cooldownMs,
    attempt: { ...checkpoint.attempt, result, endedAt: now, afterEventId: stats?.latestEventId,
      ...(evidence?.eventId ? { evidenceEventId: evidence.eventId } : {}),
      ...(evidence?.terminal ? { terminal: evidence.terminal } : result === "succeeded" ? { terminal: "idle" as const } : result === "failed" ? { terminal: "failed" as const } : {}) }
  };
}
