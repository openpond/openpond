import { createHash } from "node:crypto";
import {
  UsageAnomalyInsightPayloadSchema,
  type InsightItem,
  type InsightSeverity,
  type ModelUsageRecord,
  type UsageAnomalyInsightKind,
  type UsageAnomalyMetric,
} from "@openpond/contracts";
import { now } from "../utils.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const BASELINE_DAYS = 14;
const CURRENT_WINDOW_MS = DAY_MS;
const MIN_BASELINE_ACTIVE_DAYS = 3;
const TOP_LINK_LIMIT = 5;

type UsageGroupScope = {
  scope: "visibility" | "model";
  provider: string | null;
  model: string | null;
  visibility: string;
};

type UsageStats = {
  requests: number;
  totalTokens: number;
  failedRequests: number;
  missingUsageRequests: number;
  durations: number[];
  sessionCounts: Map<string, number>;
  commandCounts: Map<string, number>;
};

type DailyUsageStats = UsageStats & {
  day: string;
};

type UsageBaseline = {
  from: string;
  to: string;
  activeDays: number;
  medianRequests: number;
  medianTotalTokens: number;
  medianFailedRequests: number;
  medianMissingUsageRequests: number;
  medianP95LatencyMs: number | null;
};

export type UsageAnomalyInsightDetectorCandidate = {
  item: InsightItem | null;
  evidenceKey: string;
  keepFingerprint: string | null;
};

export function detectUsageAnomalyInsights(
  records: ModelUsageRecord[],
  timestamp: string = now(),
): UsageAnomalyInsightDetectorCandidate[] {
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return [];

  const currentFromMs = timestampMs - CURRENT_WINDOW_MS;
  const baselineFromMs = currentFromMs - BASELINE_DAYS * DAY_MS;
  const currentFrom = new Date(currentFromMs).toISOString();
  const baselineFrom = new Date(baselineFromMs).toISOString();
  const currentRecords = eligibleUsageRecords(records).filter((record) => {
    const startedAtMs = Date.parse(record.startedAt);
    return Number.isFinite(startedAtMs) && startedAtMs > currentFromMs && startedAtMs <= timestampMs;
  });
  const baselineRecords = eligibleUsageRecords(records).filter((record) => {
    const startedAtMs = Date.parse(record.startedAt);
    return Number.isFinite(startedAtMs) && startedAtMs > baselineFromMs && startedAtMs <= currentFromMs;
  });
  if (currentRecords.length === 0 || baselineRecords.length === 0) return [];

  const currentGroups = groupUsageRecords(currentRecords);
  const baselineGroups = groupUsageRecords(baselineRecords);
  const candidates: UsageAnomalyInsightDetectorCandidate[] = [];

  for (const [groupKey, currentRecordsForGroup] of currentGroups) {
    const current = usageStatsForRecords(currentRecordsForGroup);
    const baseline = baselineForRecords(baselineGroups.get(groupKey) ?? [], baselineFrom, currentFrom);
    if (baseline.activeDays < MIN_BASELINE_ACTIVE_DAYS) continue;
    const scope = scopeFromGroupKey(groupKey);
    for (const anomaly of anomaliesForGroup({
      scope,
      current,
      baseline,
      currentFrom,
      currentTo: timestamp,
    })) {
      candidates.push({
        evidenceKey: anomaly.payload.evidenceKey,
        keepFingerprint: anomaly.item.fingerprint,
        item: anomaly.item,
      });
    }
  }

  return candidates.sort((left, right) => {
    const leftPayload = left.item?.payload;
    const rightPayload = right.item?.payload;
    const leftSeverity = severityRank(left.item?.severity);
    const rightSeverity = severityRank(right.item?.severity);
    const leftRatio = typeof leftPayload?.ratio === "number" ? leftPayload.ratio : 0;
    const rightRatio = typeof rightPayload?.ratio === "number" ? rightPayload.ratio : 0;
    return rightSeverity - leftSeverity || rightRatio - leftRatio || left.evidenceKey.localeCompare(right.evidenceKey);
  });
}

function anomaliesForGroup(input: {
  scope: UsageGroupScope;
  current: UsageStats;
  baseline: UsageBaseline;
  currentFrom: string;
  currentTo: string;
}): Array<{ item: InsightItem; payload: ReturnType<typeof UsageAnomalyInsightPayloadSchema.parse> }> {
  const anomalies: Array<{ item: InsightItem; payload: ReturnType<typeof UsageAnomalyInsightPayloadSchema.parse> }> = [];
  const currentP95Latency = percentile(input.current.durations, 0.95);

  if (input.current.totalTokens >= tokenFloor(input.scope) && exceeds(input.current.totalTokens, input.baseline.medianTotalTokens, 3)) {
    anomalies.push(usageAnomalyItem({
      scope: input.scope,
      kind: input.scope.scope === "model" ? "model_usage_spike" : "usage_spike",
      metric: "total_tokens",
      current: input.current,
      baseline: input.baseline,
      currentFrom: input.currentFrom,
      currentTo: input.currentTo,
      value: input.current.totalTokens,
      baselineValue: input.baseline.medianTotalTokens,
      absoluteFloor: tokenFloor(input.scope),
    }));
  } else if (input.current.requests >= requestFloor(input.scope) && exceeds(input.current.requests, input.baseline.medianRequests, 3)) {
    anomalies.push(usageAnomalyItem({
      scope: input.scope,
      kind: input.scope.scope === "model" ? "model_usage_spike" : "usage_spike",
      metric: "requests",
      current: input.current,
      baseline: input.baseline,
      currentFrom: input.currentFrom,
      currentTo: input.currentTo,
      value: input.current.requests,
      baselineValue: input.baseline.medianRequests,
      absoluteFloor: requestFloor(input.scope),
    }));
  }

  if (
    currentP95Latency !== null &&
    input.baseline.medianP95LatencyMs !== null &&
    currentP95Latency >= 10_000 &&
    input.current.durations.length >= 5 &&
    exceeds(currentP95Latency, input.baseline.medianP95LatencyMs, 2)
  ) {
    anomalies.push(usageAnomalyItem({
      scope: input.scope,
      kind: "latency_regression",
      metric: "p95_latency_ms",
      current: input.current,
      baseline: input.baseline,
      currentFrom: input.currentFrom,
      currentTo: input.currentTo,
      value: currentP95Latency,
      baselineValue: input.baseline.medianP95LatencyMs,
      absoluteFloor: 10_000,
    }));
  }

  if (
    input.current.failedRequests >= 3 &&
    input.current.failedRequests / Math.max(1, input.current.requests) >= 0.25 &&
    exceeds(input.current.failedRequests, input.baseline.medianFailedRequests, 2)
  ) {
    anomalies.push(usageAnomalyItem({
      scope: input.scope,
      kind: "failure_cluster",
      metric: "failed_requests",
      current: input.current,
      baseline: input.baseline,
      currentFrom: input.currentFrom,
      currentTo: input.currentTo,
      value: input.current.failedRequests,
      baselineValue: input.baseline.medianFailedRequests,
      absoluteFloor: 3,
    }));
  }

  if (
    input.current.missingUsageRequests >= 3 &&
    input.current.missingUsageRequests / Math.max(1, input.current.requests) >= 0.25 &&
    exceeds(input.current.missingUsageRequests, input.baseline.medianMissingUsageRequests, 2)
  ) {
    anomalies.push(usageAnomalyItem({
      scope: input.scope,
      kind: "missing_usage_frames",
      metric: "missing_usage_requests",
      current: input.current,
      baseline: input.baseline,
      currentFrom: input.currentFrom,
      currentTo: input.currentTo,
      value: input.current.missingUsageRequests,
      baselineValue: input.baseline.medianMissingUsageRequests,
      absoluteFloor: 3,
    }));
  }

  return anomalies;
}

function usageAnomalyItem(input: {
  scope: UsageGroupScope;
  kind: UsageAnomalyInsightKind;
  metric: UsageAnomalyMetric;
  current: UsageStats;
  baseline: UsageBaseline;
  currentFrom: string;
  currentTo: string;
  value: number;
  baselineValue: number | null;
  absoluteFloor: number;
}): { item: InsightItem; payload: ReturnType<typeof UsageAnomalyInsightPayloadSchema.parse> } {
  const ratio = ratioValue(input.value, input.baselineValue);
  const evidenceKey = [
    input.kind,
    input.metric,
    input.scope.visibility,
    input.scope.provider ?? "all",
    input.scope.model ?? "all",
  ].join(":");
  const payload = UsageAnomalyInsightPayloadSchema.parse({
    detector: "usage-anomaly",
    evidenceSource: "usage_anomaly",
    evidenceKey,
    anomalyKind: input.kind,
    metric: input.metric,
    provider: input.scope.provider,
    model: input.scope.model,
    visibility: input.scope.visibility,
    current: {
      from: input.currentFrom,
      to: input.currentTo,
      requests: input.current.requests,
      totalTokens: input.current.totalTokens,
      failedRequests: input.current.failedRequests,
      missingUsageRequests: input.current.missingUsageRequests,
      p95LatencyMs: percentile(input.current.durations, 0.95),
    },
    baseline: input.baseline,
    ratio,
    absoluteFloor: input.absoluteFloor,
    drilldown: {
      startedAtFrom: input.currentFrom,
      startedAtTo: input.currentTo,
      visibility: input.scope.visibility,
      status: statusFilterForAnomaly(input.kind),
      provider: input.scope.provider,
      model: input.scope.model,
    },
    linkedSessionIds: topKeys(input.current.sessionCounts),
    linkedCommandNames: topKeys(input.current.commandCounts),
  });
  const fingerprint = ["openpond.insights", "usage-anomaly", evidenceKey].join(":");
  const item: InsightItem = {
    id: `insight_${hashId(fingerprint)}`,
    scopeType: "global",
    scopeId: "local",
    severity: severityForUsageAnomaly(input.kind, ratio),
    type: `usage.${input.kind}`,
    status: "active",
    fingerprint,
    title: titleForUsageAnomaly(input.kind, input.scope),
    summary: summaryForUsageAnomaly(input.kind, input.metric, input.value, input.baselineValue, ratio, input.scope),
    payload,
    lastRunId: null,
    lastRunSessionId: null,
    lastRunTurnId: null,
    createdAt: input.currentTo,
    updatedAt: input.currentTo,
    resolvedAt: null,
    dismissedAt: null,
  };
  return { item, payload };
}

function groupUsageRecords(records: ModelUsageRecord[]): Map<string, ModelUsageRecord[]> {
  const groups = new Map<string, ModelUsageRecord[]>();
  for (const record of records) {
    const visibilityKey = groupKey({
      scope: "visibility",
      provider: null,
      model: null,
      visibility: record.visibility,
    });
    groups.set(visibilityKey, [...(groups.get(visibilityKey) ?? []), record]);
    const modelKey = groupKey({
      scope: "model",
      provider: record.provider,
      model: record.model,
      visibility: record.visibility,
    });
    groups.set(modelKey, [...(groups.get(modelKey) ?? []), record]);
  }
  return groups;
}

function baselineForRecords(records: ModelUsageRecord[], baselineFrom: string, baselineTo: string): UsageBaseline {
  const daily = new Map<string, DailyUsageStats>();
  for (const record of records) {
    const day = dayKey(record.startedAt);
    const stats = daily.get(day) ?? { ...emptyUsageStats(), day };
    addUsageRecord(stats, record);
    daily.set(day, stats);
  }
  const days = [...daily.values()];
  return {
    from: baselineFrom,
    to: baselineTo,
    activeDays: days.length,
    medianRequests: median(days.map((day) => day.requests)),
    medianTotalTokens: median(days.map((day) => day.totalTokens)),
    medianFailedRequests: median(days.map((day) => day.failedRequests)),
    medianMissingUsageRequests: median(days.map((day) => day.missingUsageRequests)),
    medianP95LatencyMs: nullableMedian(days.map((day) => percentile(day.durations, 0.95)).filter((value): value is number => value !== null)),
  };
}

function emptyUsageStats(): UsageStats {
  return {
    requests: 0,
    totalTokens: 0,
    failedRequests: 0,
    missingUsageRequests: 0,
    durations: [],
    sessionCounts: new Map(),
    commandCounts: new Map(),
  };
}

function addUsageRecord(stats: UsageStats, record: ModelUsageRecord): void {
  stats.requests += 1;
  stats.totalTokens += record.totalTokens ?? 0;
  if (record.status === "failed" || record.status === "interrupted") stats.failedRequests += 1;
  if (record.source === "missing") stats.missingUsageRequests += 1;
  if (record.durationMs !== null) stats.durations.push(record.durationMs);
  if (record.sessionId) increment(stats.sessionCounts, record.sessionId);
  if (record.attribution.commandName) increment(stats.commandCounts, record.attribution.commandName);
}

function usageStatsForRecords(records: ModelUsageRecord[]): UsageStats {
  const stats = emptyUsageStats();
  for (const record of records) addUsageRecord(stats, record);
  return stats;
}

function scopeFromGroupKey(key: string): UsageGroupScope {
  const [scope, visibility, provider, model] = key.split("\u0000");
  if (scope === "model") {
    return {
      scope: "model",
      provider: provider || null,
      model: model || null,
      visibility,
    };
  }
  return {
    scope: "visibility",
    provider: null,
    model: null,
    visibility,
  };
}

function groupKey(scope: UsageGroupScope): string {
  return [scope.scope, scope.visibility, scope.provider ?? "", scope.model ?? ""].join("\u0000");
}

function eligibleUsageRecords(records: ModelUsageRecord[]): ModelUsageRecord[] {
  return records.filter((record) =>
    record.requestKind !== "insights_scan" &&
    record.requestKind !== "insights_question" &&
    record.attribution.surface !== "insights"
  );
}

function exceeds(current: number, baseline: number | null, ratio: number): boolean {
  if (baseline === null) return false;
  if (baseline === 0) return current > 0;
  return current / baseline >= ratio;
}

function ratioValue(current: number, baseline: number | null): number | null {
  if (baseline === null) return null;
  if (baseline === 0) return current > 0 ? null : 0;
  return Number((current / baseline).toFixed(2));
}

function requestFloor(scope: UsageGroupScope): number {
  return scope.scope === "model" ? 10 : 20;
}

function tokenFloor(scope: UsageGroupScope): number {
  return scope.scope === "model" ? 5_000 : 10_000;
}

function severityForUsageAnomaly(kind: UsageAnomalyInsightKind, ratio: number | null): InsightSeverity {
  if (kind === "failure_cluster") return "blocker";
  if (kind === "missing_usage_frames") return "concern";
  if (ratio !== null && ratio >= 5) return "blocker";
  return "concern";
}

function statusFilterForAnomaly(kind: UsageAnomalyInsightKind): string {
  if (kind === "failure_cluster") return "failed";
  if (kind === "missing_usage_frames") return "missing";
  return "all";
}

function titleForUsageAnomaly(kind: UsageAnomalyInsightKind, scope: UsageGroupScope): string {
  const target = scope.model ? `${scope.provider}/${scope.model}` : `${visibilityLabel(scope.visibility)} usage`;
  if (kind === "latency_regression") return `${target} latency increased`;
  if (kind === "failure_cluster") return `${target} failures increased`;
  if (kind === "missing_usage_frames") return `${target} is missing usage frames`;
  return `${target} spiked`;
}

function summaryForUsageAnomaly(
  kind: UsageAnomalyInsightKind,
  metric: UsageAnomalyMetric,
  value: number,
  baseline: number | null,
  ratio: number | null,
  scope: UsageGroupScope,
): string {
  const target = scope.model ? `${scope.provider}/${scope.model}` : `${visibilityLabel(scope.visibility)} model usage`;
  const baselineText = baseline === null ? "no baseline" : formatMetric(metric, baseline);
  const ratioText = ratio === null ? "above a zero baseline" : `${ratio}x baseline`;
  if (kind === "latency_regression") {
    return `${target} p95 latency reached ${formatMetric(metric, value)} versus ${baselineText} over the baseline (${ratioText}).`;
  }
  if (kind === "failure_cluster") {
    return `${target} had ${formatMetric(metric, value)} in the last 24 hours versus ${baselineText} over the baseline (${ratioText}).`;
  }
  if (kind === "missing_usage_frames") {
    return `${target} had ${formatMetric(metric, value)} in the last 24 hours versus ${baselineText} over the baseline (${ratioText}).`;
  }
  return `${target} reached ${formatMetric(metric, value)} in the last 24 hours versus ${baselineText} over the baseline (${ratioText}).`;
}

function formatMetric(metric: UsageAnomalyMetric, value: number): string {
  if (metric === "total_tokens") return `${Math.round(value).toLocaleString("en-US")} tokens`;
  if (metric === "p95_latency_ms") return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s` : `${Math.round(value)}ms`;
  if (metric === "failed_requests") return `${Math.round(value).toLocaleString("en-US")} failed requests`;
  if (metric === "missing_usage_requests") return `${Math.round(value).toLocaleString("en-US")} missing usage requests`;
  return `${Math.round(value).toLocaleString("en-US")} requests`;
}

function visibilityLabel(visibility: string): string {
  if (visibility === "user_facing") return "User-facing";
  return visibility
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function dayKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[midpoint]!;
  return ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2;
}

function nullableMedian(values: number[]): number | null {
  return values.length === 0 ? null : median(values);
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1));
  return sorted[index] ?? null;
}

function topKeys(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, TOP_LINK_LIMIT)
    .map(([key]) => key);
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function severityRank(severity: InsightSeverity | undefined): number {
  if (severity === "blocker") return 3;
  if (severity === "concern") return 2;
  if (severity === "nit") return 1;
  return 0;
}

function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
