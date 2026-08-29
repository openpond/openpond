import { z } from "zod";

import { MetricDefinitionSchema, type MetricDefinition, type MetricObservation } from "./telemetry.js";

const definition = (input: Omit<MetricDefinition, "schemaVersion">): MetricDefinition =>
  MetricDefinitionSchema.parse({ schemaVersion: "openpond.metricDefinition.v1", ...input });

export const CORE_METRIC_CATALOG = [
  definition({ id: "reward.mean", displayName: "Mean reward", description: "Mean composed reward for the cohort.", valueType: "gauge", unit: "scalar", direction: "higher", aggregation: "mean", visibility: "team_visible", boundedDimensions: ["split", "grader"] }),
  definition({ id: "reward.variance", displayName: "Reward variance", description: "Population variance of composed reward within a rollout group.", valueType: "gauge", unit: "scalar", direction: "neutral", aggregation: "mean", visibility: "team_visible", boundedDimensions: ["split"] }),
  definition({ id: "reward.constant_group_rate", displayName: "Constant group rate", description: "Fraction of rollout groups with no reward variation.", valueType: "gauge", unit: "ratio", direction: "lower", aggregation: "mean", visibility: "team_visible", boundedDimensions: ["split"] }),
  definition({ id: "attempt.valid_rate", displayName: "Valid attempt rate", description: "Fraction of attempts passing deterministic validity checks.", valueType: "gauge", unit: "ratio", direction: "higher", aggregation: "mean", visibility: "team_visible", boundedDimensions: ["split", "failureOwner"] }),
  definition({ id: "attempt.failure_count", displayName: "Attempt failures", description: "Count of failed Attempts.", valueType: "counter", unit: "count", direction: "lower", aggregation: "sum", visibility: "team_visible", boundedDimensions: ["split", "failureOwner", "failureClass"] }),
  definition({ id: "optimizer.loss", displayName: "Optimizer loss", description: "Policy optimizer loss after the step.", valueType: "gauge", unit: "scalar", direction: "neutral", aggregation: "mean", visibility: "team_visible", boundedDimensions: ["split"] }),
  definition({ id: "optimizer.learning_rate", displayName: "Learning rate", description: "Optimizer learning rate after the step.", valueType: "gauge", unit: "scalar", direction: "neutral", aggregation: "last", visibility: "team_visible", boundedDimensions: ["split"] }),
  definition({ id: "optimizer.kl", displayName: "Policy update KL", description: "Sampled approximate KL between the frozen pre-update policy and the policy after the optimizer step.", valueType: "gauge", unit: "scalar", direction: "lower", aggregation: "mean", visibility: "team_visible", boundedDimensions: ["split"] }),
  definition({ id: "optimizer.entropy", displayName: "Policy entropy", description: "Observed policy entropy for trainable tokens.", valueType: "gauge", unit: "scalar", direction: "neutral", aggregation: "mean", visibility: "team_visible", boundedDimensions: ["split"] }),
  definition({ id: "optimizer.gradient_norm", displayName: "Gradient norm", description: "Gradient norm reported by the optimizer.", valueType: "gauge", unit: "scalar", direction: "neutral", aggregation: "max", visibility: "team_visible", boundedDimensions: ["split"] }),
  definition({ id: "optimizer.clip_fraction", displayName: "Clip fraction", description: "Fraction of policy updates affected by clipping.", valueType: "gauge", unit: "ratio", direction: "neutral", aggregation: "mean", visibility: "team_visible", boundedDimensions: ["split"] }),
  definition({ id: "output.duplicate_rate", displayName: "Duplicate output rate", description: "Fraction of outputs duplicated within the measured cohort.", valueType: "gauge", unit: "ratio", direction: "lower", aggregation: "mean", visibility: "team_visible", boundedDimensions: ["split"] }),
  definition({ id: "output.unique_count", displayName: "Unique outputs", description: "Distinct output count in the measured cohort.", valueType: "gauge", unit: "count", direction: "higher", aggregation: "last", visibility: "team_visible", boundedDimensions: ["split"] }),
  definition({ id: "tokens.input", displayName: "Input tokens", description: "Input tokens processed.", valueType: "counter", unit: "tokens", direction: "neutral", aggregation: "sum", visibility: "team_visible", boundedDimensions: ["split", "source"] }),
  definition({ id: "tokens.output", displayName: "Output tokens", description: "Output tokens generated.", valueType: "counter", unit: "tokens", direction: "neutral", aggregation: "sum", visibility: "team_visible", boundedDimensions: ["split", "source"] }),
  definition({ id: "runtime.latency_ms", displayName: "Runtime latency", description: "Wall-clock latency of the measured operation.", valueType: "distribution", unit: "milliseconds", direction: "lower", aggregation: "p95", visibility: "team_visible", boundedDimensions: ["operation", "provider"] }),
  definition({ id: "runtime.throughput", displayName: "Token throughput", description: "Tokens processed per second.", valueType: "gauge", unit: "scalar", direction: "higher", aggregation: "mean", visibility: "team_visible", boundedDimensions: ["operation", "provider"] }),
  definition({ id: "gpu.memory_bytes", displayName: "GPU memory", description: "Peak allocated GPU memory.", valueType: "gauge", unit: "bytes", direction: "neutral", aggregation: "max", visibility: "host_private", boundedDimensions: ["provider", "gpuType"] }),
  definition({ id: "gpu.utilization", displayName: "GPU utilization", description: "Observed GPU utilization ratio.", valueType: "gauge", unit: "ratio", direction: "neutral", aggregation: "mean", visibility: "host_private", boundedDimensions: ["provider", "gpuType"] }),
  definition({ id: "cost.usd", displayName: "Run cost", description: "Accrued hosted execution cost.", valueType: "counter", unit: "usd", direction: "lower", aggregation: "sum", visibility: "team_visible", boundedDimensions: ["provider", "resource"] }),
] as const;

export type CoreMetricId = (typeof CORE_METRIC_CATALOG)[number]["id"];
const catalog = new Map<string, MetricDefinition>(CORE_METRIC_CATALOG.map((item) => [item.id, item]));

export function getCoreMetricDefinition(metricId: string): MetricDefinition | undefined {
  return catalog.get(metricId);
}

export function validateCoreMetricObservation(input: MetricObservation): MetricObservation {
  return validateMetricObservation(input, CORE_METRIC_CATALOG);
}

export function validateMetricObservation(input: MetricObservation, definitions: readonly MetricDefinition[]): MetricObservation {
  MetricCatalogSchema.parse(definitions);
  const metric = definitions.find((item) => item.id === input.metricId);
  if (!metric) throw new Error(`Unknown metric: ${input.metricId}`);
  const unexpected = Object.keys(input.dimensions).filter((dimension) => !metric.boundedDimensions.includes(dimension));
  if (unexpected.length) throw new Error(`Metric ${input.metricId} has unsupported dimensions: ${unexpected.join(", ")}`);
  if (metric.unit === "ratio" && (input.value < 0 || input.value > 1)) {
    throw new Error(`Ratio metric ${input.metricId} must be between zero and one.`);
  }
  return input;
}

export const MetricCatalogSchema = z.array(MetricDefinitionSchema).min(1).superRefine((items, context) => {
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    context.addIssue({ code: "custom", message: "Metric catalog contains duplicate ids." });
  }
});
