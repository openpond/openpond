import {
  ChatModelRefSchema,
  ModelComparisonDecisionSchema,
  ModelComparisonEntryStatusSchema,
  ModelComparisonEvaluationLinkSchema,
} from "@openpond/contracts";

import type { createModelComparisonEvaluationService } from "./model-comparison-evaluation-service.js";
import type { createModelComparisonSeriesService } from "./model-comparison-series-service.js";

type ComparisonEvaluations = ReturnType<typeof createModelComparisonEvaluationService>;
type ComparisonSeries = ReturnType<typeof createModelComparisonSeriesService>;

export async function handleModelComparisonAction(input: {
  action: string;
  payload: Record<string, unknown>;
  evaluations: ComparisonEvaluations;
  series: ComparisonSeries;
}): Promise<{ handled: false } | { handled: true; value: unknown }> {
  const payload = input.payload;
  switch (input.action) {
    case "save_model_comparison_series":
      return handled(await input.series.saveSeries(payload.series));
    case "seal_model_comparison_series":
      return handled(await input.series.sealSeries({
        seriesId: requiredString(payload.seriesId, "seriesId"),
        expectedRevision: positiveInteger(payload.expectedRevision, "expectedRevision"),
      }));
    case "queue_model_comparison_release":
      return handled(await input.series.queueRelease({
        ...payload,
        seriesId: requiredString(payload.seriesId, "seriesId"),
      }));
    case "link_model_comparison_run":
      return handled(await input.series.linkRun({
        entryId: requiredString(payload.entryId, "entryId"),
        expectedStatus: ModelComparisonEntryStatusSchema.parse(payload.expectedStatus),
        status: ModelComparisonEntryStatusSchema.parse(payload.status),
        trainingPlanId: nullableString(payload.trainingPlanId),
        modelRunId: nullableString(payload.modelRunId),
        modelVersionId: nullableString(payload.modelVersionId),
        evaluations: payload.evaluations === undefined
          ? undefined
          : ModelComparisonEvaluationLinkSchema.array().parse(payload.evaluations),
      }));
    case "start_model_comparison_evaluation":
      return handled(await input.evaluations.start({
        entryId: requiredString(payload.entryId, "entryId"),
        cohortRole: cohortRole(payload.cohortRole),
        seeds: payload.seeds === undefined ? undefined : integerArray(payload.seeds, "seeds"),
        repetitions: payload.repetitions === undefined ? undefined : positiveInteger(payload.repetitions, "repetitions"),
        maximumSpendUsd: payload.maximumSpendUsd === undefined ? undefined : positiveNumber(payload.maximumSpendUsd, "maximumSpendUsd"),
        maxGpuSeconds: payload.maxGpuSeconds === undefined ? undefined : positiveInteger(payload.maxGpuSeconds, "maxGpuSeconds"),
      }));
    case "start_model_comparison_reference_evaluation":
      return handled(await input.evaluations.startReference({
        seriesId: requiredString(payload.seriesId, "seriesId"),
        cohortRole: cohortRole(payload.cohortRole),
        targetKind: payload.targetKind === "base_model" ? "base_model" : "external_reference",
        label: requiredString(payload.label, "label"),
        model: ChatModelRefSchema.parse(payload.model),
        seeds: payload.seeds === undefined ? undefined : integerArray(payload.seeds, "seeds"),
        repetitions: payload.repetitions === undefined ? undefined : positiveInteger(payload.repetitions, "repetitions"),
        maximumSpendUsd: payload.maximumSpendUsd === undefined ? undefined : positiveNumber(payload.maximumSpendUsd, "maximumSpendUsd"),
      }));
    case "retry_model_comparison_entry":
      return handled(await input.series.retryEntry({ entryId: requiredString(payload.entryId, "entryId") }));
    case "decide_model_comparison_entry":
      return handled(await input.series.decide({
        entryId: requiredString(payload.entryId, "entryId"),
        expectedSeriesRevision: positiveInteger(payload.expectedSeriesRevision, "expectedSeriesRevision"),
        decision: ModelComparisonDecisionSchema.parse(payload.decision),
      }));
    case "record_model_comparison_promotion":
      return handled(await input.series.recordPromotion({
        entryId: requiredString(payload.entryId, "entryId"),
        bindingId: requiredString(payload.bindingId, "bindingId"),
        expectedSeriesRevision: positiveInteger(payload.expectedSeriesRevision, "expectedSeriesRevision"),
      }));
    default:
      return { handled: false };
  }
}

function handled(value: unknown): { handled: true; value: unknown } {
  return { handled: true, value };
}
function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function requiredString(value: unknown, name: string): string {
  const parsed = string(value);
  if (!parsed) throw new Error(`${name} is required.`);
  return parsed;
}
function nullableString(value: unknown): string | null { return string(value); }
function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
  return value;
}
function integerArray(value: unknown, name: string): number[] {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "number" || !Number.isInteger(item))) {
    throw new Error(`${name} must contain at least one integer.`);
  }
  return value as number[];
}
function cohortRole(value: unknown): "current" | "development" | "retained" | "prior_disclosed" | "frozen_final" {
  if (value === "current" || value === "development" || value === "retained" || value === "prior_disclosed" || value === "frozen_final") return value;
  throw new Error("cohortRole is invalid.");
}
