import { useMemo } from "react";
import type { Taskset, TrainingRunDetail } from "@openpond/contracts";

import { useErrorToast } from "../../app/AppToastContext";
import { TrainingMetricWorkbench, type TrainingMetricSeries } from "./TrainingMetricWorkbench";
import { POLICY_SERIES, STEP_SERIES, definedSeries } from "./training-metric-definitions";
import { rolloutRewardGroups } from "./training-rollout-metrics";

const REWARD_SERIES_IDS = new Set(["optimizer.reward", "rollout.reward"]);

export function TrainingRunMetrics({ detail, loading, refreshing, error, onRefresh, taskset = null }: {
  detail: TrainingRunDetail | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  onRefresh(): Promise<unknown>;
  taskset?: Taskset | null;
}) {
  useErrorToast(error, { prefix: "Training metrics" });
  const groups = useMemo(() => {
    return detail ? rolloutRewardGroups(detail.events, taskset?.tasks) : [];
  }, [detail, taskset]);
  const series = useMemo(() => {
    if (!detail) return [];
    return mergeRolloutRewardSeries(metricSeries(detail), groups);
  }, [detail, groups]);
  const live = detail
    ? ["queued", "starting", "running", "reconciling"].includes(detail.job.status)
    : false;
  return (
    <>
      <div className="model-build-actions">
        <button type="button" className="training-button secondary" disabled={loading || refreshing}
          onClick={() => { void onRefresh(); }}>Refresh metrics</button>
      </div>
      {detail || loading ? <TrainingMetricWorkbench
        live={live}
        loading={loading && !detail}
        series={series}
      /> : null}
    </>
  );
}

export function rolloutRewardSeries(
  groups: ReturnType<typeof rolloutRewardGroups>,
): TrainingMetricSeries | null {
  const points = groups.flatMap((group, index) =>
    group.mean === null ? [] : [{ step: index + 1, value: group.mean }],
  );
  return points.length
    ? {
        id: "optimizer.reward",
        label: "Mean reward",
        points,
        xLabel: "rollout group",
      }
    : null;
}

export function mergeRolloutRewardSeries(
  metrics: TrainingMetricSeries[],
  groups: ReturnType<typeof rolloutRewardGroups>,
): TrainingMetricSeries[] {
  const rolloutReward = rolloutRewardSeries(groups);
  return rolloutReward
    ? [
        rolloutReward,
        ...metrics.filter((metric) => !REWARD_SERIES_IDS.has(metric.id)),
      ]
    : metrics;
}

export function metricSeries(detail: TrainingRunDetail): TrainingMetricSeries[] {
  const rolloutProgress = record(detail.job.metadata.rolloutProgress);
  const observedUpdates =
    finiteNumber(detail.job.metadata.optimizerUpdatesObserved)
    ?? finiteNumber(rolloutProgress.optimizerUpdatesApplied);
  const committedUpdates = trainingMethod(detail) === "grpo" && observedUpdates !== null
    ? Math.max(0, observedUpdates)
    : null;
  const stepRows = uniqueByStep(detail.stepMetrics).filter((row) =>
    committedUpdates === null || row.step <= committedUpdates,
  );
  const series = [...definedSeries(uniqueByStep(detail.policyMetrics), POLICY_SERIES), ...definedSeries(stepRows, STEP_SERIES), ...eventSeries(detail.events)];
  const byId = new Map<string, TrainingMetricSeries>();
  for (const candidate of series) {
    const current = byId.get(candidate.id);
    if (!current || candidate.points.length > current.points.length) byId.set(candidate.id, candidate);
  }
  const priority = ["optimizer.reward", "rollout.reward", "optimizer.kl", "optimizer.loss", "optimizer.learning_rate"];
  return [...byId.values()].sort((left, right) => order(left.id, priority) - order(right.id, priority) || left.label.localeCompare(right.label));
}

function order(id: string, priority: string[]) { const index = priority.indexOf(id); return index < 0 ? 999 : index; }


function uniqueByStep<T extends { step: number }>(rows: T[]): T[] {
  const latest = new Map<number, T>();
  for (const row of rows) latest.set(row.step, row);
  return [...latest.values()].sort((left, right) => left.step - right.step);
}

export function eventSeries(events: TrainingRunDetail["events"]): TrainingMetricSeries[] {
  const metrics = new Map<string, Array<{ step: number; value: number }>>();
  const labels = new Map<string, string>();
  const append = (id: string, label: string, step: number, value: number) => {
    metrics.set(id, [...(metrics.get(id) ?? []), { step, value }]); labels.set(id, label);
  };
  const groups = new Map<string, Array<{
    reward: number | null;
    eligible: boolean;
    resolved: boolean;
    attempt: number;
    input: number;
    output: number;
  }>>();
  for (const event of events) {
    if (event.type !== "metric") continue;
    if (event.payload.metricKind === "managed_telemetry") {
      const id = typeof event.payload.metricId === "string" ? event.payload.metricId : null;
      const value = finiteNumber(event.payload.value);
      const step = finiteNumber(event.payload.step) ?? event.sequence;
      if (id && value !== null) append(id, humanizeMetric(id), step, value);
    }
    if (event.payload.metricKind === "rollout_trajectory") {
      const step = finiteNumber(event.payload.rolloutIndex) ?? event.sequence;
      const reward = finiteNumber(event.payload.reward);
      if (reward !== null && event.payload.rewardEligible === true) append("rollout.reward", "Rollout reward", step, reward);
      const id = typeof event.payload.rolloutGroupId === "string" ? event.payload.rolloutGroupId : "group-0";
      const explicitlyFailed =
        event.payload.rewardEligible === false
        || typeof event.payload.failureClass === "string"
        || typeof event.payload.failureCode === "string";
      groups.set(id, [...(groups.get(id) ?? []), {
        reward,
        eligible: event.payload.rewardEligible === true,
        resolved: reward !== null || explicitlyFailed,
        attempt: finiteNumber(event.payload.attempt) ?? 1,
        input: finiteNumber(event.payload.inputTokens) ?? 0,
        output: finiteNumber(event.payload.outputTokens) ?? 0,
      }]);
    }
  }
  [...groups.values()].forEach((group, step) => {
    const resolved = group.filter((attempt) => attempt.resolved);
    if (!resolved.length) return;
    const rewards = resolved.flatMap((attempt) => attempt.eligible && attempt.reward !== null ? [attempt.reward] : []);
    append("attempt.valid_rate", "Valid attempt rate", step, rewards.length / resolved.length);
    append("attempt.failure_count", "Attempt failures", step, resolved.length - rewards.length);
    append("attempt.retry_count", "Attempt retries", step, resolved.reduce((sum, attempt) => sum + Math.max(0, attempt.attempt - 1), 0));
    if (rewards.length) {
      const mean = rewards.reduce((sum, value) => sum + value, 0) / rewards.length;
      append("reward.variance", "Reward variance", step, rewards.reduce((sum, value) => sum + (value - mean) ** 2, 0) / rewards.length);
      append("reward.best", "Best reward", step, Math.max(...rewards));
    }
    append("tokens.input", "Input tokens", step, group.reduce((sum, attempt) => sum + attempt.input, 0));
    append("tokens.output", "Output tokens", step, group.reduce((sum, attempt) => sum + attempt.output, 0));
  });
  return [...metrics].map(([id, points]) => ({ id, label: labels.get(id) ?? humanizeMetric(id), points, format: id.endsWith("rate") || id.includes("fraction") ? "percent" : "number" }));
}

function finiteNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function humanizeMetric(value: string) { return value.replaceAll(/[._]/g, " ").replace(/^./, (character) => character.toUpperCase()); }

function trainingMethod(detail: TrainingRunDetail): string | null {
  const direct = detail.job.metadata.trainingMethod;
  if (typeof direct === "string") return direct;
  const sourceSnapshot = record(detail.job.metadata.sourceSnapshot);
  return typeof sourceSnapshot.method === "string" ? sourceSnapshot.method : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
