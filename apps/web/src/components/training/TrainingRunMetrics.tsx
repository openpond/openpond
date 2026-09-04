import { useMemo } from "react";
import type { PolicyOptimizationMetric, SftStepMetric, Taskset, TrainingRunDetail } from "@openpond/contracts";

import { useErrorToast } from "../../app/AppToastContext";
import { TrainingMetricWorkbench, type TrainingMetricSeries } from "./TrainingMetricWorkbench";
import { rolloutRewardGroups } from "./training-rollout-metrics";

type SeriesDefinition<T> = { key: keyof T; id: string; label: string; format?: TrainingMetricSeries["format"] };

const POLICY_SERIES: Array<SeriesDefinition<PolicyOptimizationMetric>> = [
  { key: "meanReward", id: "optimizer.reward", label: "Mean reward" },
  { key: "meanReturn", id: "optimizer.return", label: "Mean return" },
  { key: "learningRate", id: "optimizer.learning_rate", label: "Learning rate", format: "scientific" },
  { key: "policyLoss", id: "optimizer.policy_loss", label: "Policy loss" },
  { key: "valueLoss", id: "optimizer.value_loss", label: "Value loss" },
  { key: "gradientNorm", id: "optimizer.gradient_norm", label: "Gradient norm" },
  { key: "kl", id: "optimizer.kl", label: "Policy update KL" },
  { key: "behaviorPolicyKlPreUpdate", id: "optimizer.behavior_policy_kl", label: "Behavior-policy KL (pre-update)" },
  { key: "entropy", id: "optimizer.entropy", label: "Entropy" },
  { key: "policyClipFraction", id: "optimizer.policy_clip_fraction", label: "Post-update clip fraction", format: "percent" },
  { key: "behaviorPolicyClipFractionPreUpdate", id: "optimizer.behavior_policy_clip_fraction", label: "Behavior-policy clip fraction (pre-update)", format: "percent" },
  { key: "valueClipFraction", id: "optimizer.value_clip_fraction", label: "Value clip fraction", format: "percent" },
  { key: "explainedVariance", id: "optimizer.explained_variance", label: "Explained variance" },
];

const STEP_SERIES: Array<SeriesDefinition<SftStepMetric>> = [
  { key: "loss", id: "optimizer.loss", label: "Loss" },
  { key: "reward", id: "optimizer.reward", label: "Reward" },
  { key: "policyLoss", id: "optimizer.policy_loss", label: "Policy loss" },
  { key: "advantageLoss", id: "optimizer.advantage_loss", label: "Advantage loss" },
  { key: "learningRate", id: "optimizer.learning_rate", label: "Learning rate", format: "scientific" },
  { key: "gradientNorm", id: "optimizer.gradient_norm", label: "Gradient norm" },
  { key: "meanTokenAccuracy", id: "train.token_accuracy", label: "Token accuracy", format: "percent" },
  { key: "preferenceAccuracy", id: "train.preference_accuracy", label: "Preference accuracy", format: "percent" },
  { key: "preferenceMargin", id: "train.preference_margin", label: "Preference margin" },
  { key: "chosenReward", id: "train.chosen_reward", label: "Chosen reward" },
  { key: "rejectedReward", id: "train.rejected_reward", label: "Rejected reward" },
  { key: "entropy", id: "optimizer.entropy", label: "Entropy" },
];

export function TrainingRunMetrics({ detail, loading, error, taskset = null }: { detail: TrainingRunDetail | null; loading: boolean; error: string | null; taskset?: Taskset | null }) {
  useErrorToast(error, { prefix: "Training metrics" });
  const series = useMemo(() => detail ? metricSeries(detail) : [], [detail]);
  const groups = useMemo(() => {
    if (!detail) return null;
    const resolved = rolloutRewardGroups(detail.events, taskset?.tasks);
    return resolved.length || trainingMethod(detail) === "grpo" ? resolved : null;
  }, [detail, taskset]);
  if (error && !detail) return <div className="training-run-placeholder">Training metrics are unavailable.</div>;
  if (!detail && !loading) return <div className="training-run-placeholder">Select a training run to inspect its metrics.</div>;
  const live = detail
    ? ["queued", "starting", "running", "reconciling"].includes(detail.job.status)
    : false;
  return <TrainingMetricWorkbench live={live} loading={loading && !detail} rolloutGroups={groups} series={series} />;
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

function definedSeries<T extends { step: number }>(rows: T[], definitions: Array<SeriesDefinition<T>>): TrainingMetricSeries[] {
  return definitions.flatMap((definition) => {
    const points = rows.flatMap((row) => {
      const value = row[definition.key];
      return typeof value === "number" && Number.isFinite(value) ? [{ step: row.step, value }] : [];
    });
    return points.length ? [{ id: definition.id, label: definition.label, points, format: definition.format }] : [];
  });
}

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
      if (reward !== null) append("rollout.reward", "Rollout reward", step, reward);
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
    const mean = rewards.length ? rewards.reduce((sum, value) => sum + value, 0) / rewards.length : 0;
    const variance = rewards.length ? rewards.reduce((sum, value) => sum + (value - mean) ** 2, 0) / rewards.length : 0;
    const best = rewards.length ? Math.max(...rewards) : 0;
    append("attempt.valid_rate", "Valid attempt rate", step, rewards.length / resolved.length);
    append("attempt.failure_count", "Attempt failures", step, resolved.length - rewards.length);
    append("attempt.retry_count", "Attempt retries", step, resolved.reduce((sum, attempt) => sum + Math.max(0, attempt.attempt - 1), 0));
    append("reward.variance", "Reward variance", step, variance);
    append("reward.best", "Best reward", step, best);
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
