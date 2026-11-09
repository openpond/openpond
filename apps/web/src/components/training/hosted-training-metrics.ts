import type { TrainingJobEvent } from "openpond-sdk/training";
import type { TrainingMetricSeries } from "./TrainingMetricWorkbench";
import { POLICY_SERIES, STEP_SERIES } from "./training-metric-definitions";

/** Plot only numeric telemetry actually retained by the hosted job. */
export function hostedTrainingMetricSeries(events: TrainingJobEvent[]): TrainingMetricSeries[] {
  const series = new Map<string, TrainingMetricSeries>();
  for (const event of events) {
    const data = event.data;
    const definitions = data.metricKind === "policy_optimization" ? POLICY_SERIES
      : ["sft_step", "dpo_step", "training_step"].includes(String(data.metricKind)) ? STEP_SERIES : [];
    const named = typeof data.metricId === "string"
      ? [...POLICY_SERIES, ...STEP_SERIES].find(definition => definition.id === data.metricId) : undefined;
    const fields =
      event.type === "rollout_metric"
        ? (data.rewardEligible === true ? [["rollout.reward", "Rollout reward", data.reward ?? data.rewardMean, undefined]] as const : [])
        : definitions.length
          ? definitions.map(definition => [definition.id, definition.label, data[definition.key], definition.format] as const)
        : typeof data.metricId === "string"
          ? ([[data.metricId, named?.label ?? data.metricId.replaceAll(/[._]/g, " "), data.value, named?.format]] as const)
          : [];
    for (const [id, label, value, format] of fields) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const step =
        event.type === "rollout_metric" && typeof data.rolloutIndex === "number"
          ? data.rolloutIndex
          : typeof data.step === "number"
          ? data.step
          : typeof data.rolloutGroupIndex === "number"
            ? data.rolloutGroupIndex + 1
            : event.sequence;
      if (!Number.isFinite(step) || step < 0) continue;
      const current = series.get(id) ?? { id, label, format, xLabel: "Recorded step", points: [] };
      current.points.push({ step, value });
      series.set(id, current);
    }
  }
  return [...series.values()].map(metric => ({ ...metric,
    points: [...new Map(metric.points.map(point => [point.step, point])).values()].sort((left, right) => left.step - right.step),
  }));
}
