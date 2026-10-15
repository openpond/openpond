import type { TrainingJobEvent } from "openpond-sdk/training";
import type { TrainingMetricSeries } from "./TrainingMetricWorkbench";

/** Plot only numeric telemetry actually retained by the hosted job. */
export function hostedTrainingMetricSeries(events: TrainingJobEvent[]): TrainingMetricSeries[] {
  const series = new Map<string, TrainingMetricSeries>();
  for (const event of events) {
    const data = event.data;
    const fields =
      event.type === "rollout_metric"
        ? ([["rollout.reward", "Rollout reward", data.reward ?? data.rewardMean]] as const)
        : typeof data.metricId === "string"
          ? ([[data.metricId, data.metricId.replaceAll(/[._]/g, " "), data.value]] as const)
          : [];
    for (const [id, label, value] of fields) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const step =
        typeof data.step === "number"
          ? data.step
          : typeof data.rolloutGroupIndex === "number"
            ? data.rolloutGroupIndex + 1
            : event.sequence;
      const current = series.get(id) ?? { id, label, xLabel: "Recorded step", points: [] };
      current.points.push({ step, value });
      series.set(id, current);
    }
  }
  return [...series.values()];
}
