import { z } from "zod";

import {
  ImmutableReleaseRefSchema,
  MetadataSchema,
  ModelRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
  contentHash,
} from "@openpond/harness";

import { type AttemptReceipt, type EvaluationResult } from "./runs.js";
import { TaskSplitSchema } from "./tasksets.js";

export {
  harnessRefinerBenchmarkAssets,
  harnessRefinerBenchmarkRelease,
} from "./builtin-benchmarks/harness-refiner.js";
export {
  harnessRefinerBenchmarkV3Assets,
  harnessRefinerBenchmarkV3Release,
} from "./builtin-benchmarks/harness-refiner-v3.js";

export const BenchmarkMetricSchema = z.enum([
  "foreground_tokens",
  "success_rate",
  "latency_ms",
  "cost_usd",
]);
export const BenchmarkRunPhaseSchema = z.enum(["baseline", "candidate"]);

export const BenchmarkProtocolSchema = z.object({
  split: TaskSplitSchema,
  taskIds: z.array(ReleaseIdSchema).min(1).max(100_000),
  seeds: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
  repetitions: z.number().int().positive().max(20),
  runtimeTargetHash: ReleaseHashSchema,
  environmentHash: ReleaseHashSchema,
  toolContractHash: ReleaseHashSchema,
  limitsHash: ReleaseHashSchema,
}).strict();

export const BenchmarkDefinitionSchema = z.object({
  schemaVersion: z.literal("openpond.benchmarkDefinition.v1"),
  id: ReleaseIdSchema,
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1).max(5_000),
  tasksetRelease: ImmutableReleaseRefSchema,
  adaptationSplit: TaskSplitSchema,
  evaluationSplit: TaskSplitSchema,
  primaryMetric: BenchmarkMetricSchema,
  qualityGate: z.enum(["none", "non_regression", "all_pass"]),
  caseCounts: z.object({
    adaptation: z.number().int().nonnegative(),
    evaluation: z.number().int().positive(),
  }).strict(),
  metadata: MetadataSchema,
}).strict();

export const BenchmarkRunRequestSchema = z.object({
  schemaVersion: z.literal("openpond.benchmarkRunRequest.v1"),
  phase: BenchmarkRunPhaseSchema,
  model: ModelRefSchema,
  reasoningEffort: z.string().trim().min(1).max(100).nullable(),
  split: TaskSplitSchema,
  seeds: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
  repetitions: z.number().int().positive().max(20),
  metadata: MetadataSchema,
}).strict();

const BenchmarkUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict();

export const BenchmarkRunSummaryContentSchema = z.object({
  schemaVersion: z.literal("openpond.benchmarkRunSummary.v1"),
  id: ReleaseIdSchema,
  phase: BenchmarkRunPhaseSchema,
  tasksetRelease: ImmutableReleaseRefSchema,
  harnessRelease: ImmutableReleaseRefSchema,
  evaluationResult: ImmutableReleaseRefSchema,
  model: ModelRefSchema,
  reasoningEffort: z.string().trim().min(1).max(100).nullable(),
  protocol: BenchmarkProtocolSchema,
  attemptCount: z.number().int().positive(),
  passedCount: z.number().int().nonnegative(),
  terminalCount: z.number().int().nonnegative(),
  usage: BenchmarkUsageSchema,
  costUsd: z.number().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative(),
  createdAt: ReleaseTimestampSchema,
  metadata: MetadataSchema,
}).strict();
export const BenchmarkRunSummarySchema = BenchmarkRunSummaryContentSchema
  .extend({ contentHash: ReleaseHashSchema })
  .strict();

export const BenchmarkComparisonContentSchema = z.object({
  schemaVersion: z.literal("openpond.benchmarkComparison.v1"),
  id: ReleaseIdSchema,
  baseline: ImmutableReleaseRefSchema,
  candidate: ImmutableReleaseRefSchema,
  tasksetRelease: ImmutableReleaseRefSchema,
  primaryMetric: BenchmarkMetricSchema,
  qualityPassed: z.boolean(),
  baselinePassRate: z.number().min(0).max(1),
  candidatePassRate: z.number().min(0).max(1),
  foregroundTokenDelta: z.number().int(),
  foregroundTokenDeltaPercent: z.number().finite().nullable(),
  improved: z.boolean(),
  createdAt: ReleaseTimestampSchema,
  metadata: MetadataSchema,
}).strict();
export const BenchmarkComparisonSchema = BenchmarkComparisonContentSchema
  .extend({ contentHash: ReleaseHashSchema })
  .strict();

export function createBenchmarkDefinition(
  input: z.input<typeof BenchmarkDefinitionSchema>,
): BenchmarkDefinition {
  return BenchmarkDefinitionSchema.parse(input);
}

export function createBenchmarkRunSummary(input: {
  id: string;
  phase: BenchmarkRunPhase;
  evaluation: EvaluationResult;
  receipts: AttemptReceipt[];
  reasoningEffort: string | null;
  protocol: BenchmarkProtocol;
  createdAt: string;
  metadata?: Record<string, unknown>;
}): BenchmarkRunSummary {
  if (input.receipts.length !== input.evaluation.attemptCount) {
    throw new Error("Benchmark receipt count does not match its Evaluation result.");
  }
  const usage = input.receipts.reduce(
    (total, receipt) => addUsage(total, providerUsage(receipt.metadata.usage)),
    emptyUsage(),
  );
  const costs = input.receipts.flatMap((receipt) =>
    typeof receipt.costUsd === "number" ? [receipt.costUsd] : [],
  );
  const content = BenchmarkRunSummaryContentSchema.parse({
    schemaVersion: "openpond.benchmarkRunSummary.v1",
    id: input.id,
    phase: input.phase,
    tasksetRelease: input.evaluation.tasksetRelease,
    harnessRelease: input.evaluation.harnessRelease,
    evaluationResult: {
      id: input.evaluation.id,
      contentHash: input.evaluation.contentHash,
    },
    model: input.evaluation.model,
    reasoningEffort: input.reasoningEffort,
    protocol: input.protocol,
    attemptCount: input.evaluation.attemptCount,
    passedCount: input.receipts.filter(
      (receipt) => receipt.metadata.passed === true,
    ).length,
    terminalCount: input.evaluation.terminalCount,
    usage,
    costUsd: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null,
    latencyMs: input.receipts.reduce((sum, receipt) => sum + receipt.latencyMs, 0),
    createdAt: input.createdAt,
    metadata: input.metadata ?? {},
  });
  return BenchmarkRunSummarySchema.parse({
    ...content,
    contentHash: contentHash(content),
  });
}

export function compareBenchmarkRuns(input: {
  id: string;
  baseline: BenchmarkRunSummary;
  candidate: BenchmarkRunSummary;
  primaryMetric: BenchmarkMetric;
  qualityGate: "none" | "non_regression" | "all_pass";
  createdAt: string;
  metadata?: Record<string, unknown>;
}): BenchmarkComparison {
  const { baseline, candidate } = input;
  if (
    baseline.tasksetRelease.contentHash !== candidate.tasksetRelease.contentHash
    || baseline.model.provider !== candidate.model.provider
    || baseline.model.model !== candidate.model.model
    || baseline.reasoningEffort !== candidate.reasoningEffort
    || contentHash(baseline.protocol) !== contentHash(candidate.protocol)
  ) {
    throw new Error("Benchmark runs are not comparable under the pinned protocol.");
  }
  const baselinePassRate = baseline.passedCount / baseline.attemptCount;
  const candidatePassRate = candidate.passedCount / candidate.attemptCount;
  const complete =
    baseline.terminalCount === baseline.attemptCount
    && candidate.terminalCount === candidate.attemptCount;
  const qualityPassed = complete && (input.qualityGate === "none"
    || (input.qualityGate === "all_pass"
      ? candidatePassRate === 1
      : (baseline.passedCount > 0 || candidate.passedCount > 0)
        && candidatePassRate >= baselinePassRate));
  const foregroundTokenDelta =
    candidate.usage.totalTokens - baseline.usage.totalTokens;
  const foregroundTokenDeltaPercent = baseline.usage.totalTokens > 0
    ? (foregroundTokenDelta / baseline.usage.totalTokens) * 100
    : null;
  const metricImproved = input.primaryMetric === "foreground_tokens"
    ? foregroundTokenDelta < 0
    : input.primaryMetric === "success_rate"
      ? candidatePassRate > baselinePassRate
      : input.primaryMetric === "latency_ms"
        ? candidate.latencyMs < baseline.latencyMs
        : candidate.costUsd !== null
          && baseline.costUsd !== null
          && candidate.costUsd < baseline.costUsd;
  const content = BenchmarkComparisonContentSchema.parse({
    schemaVersion: "openpond.benchmarkComparison.v1",
    id: input.id,
    baseline: { id: baseline.id, contentHash: baseline.contentHash },
    candidate: { id: candidate.id, contentHash: candidate.contentHash },
    tasksetRelease: baseline.tasksetRelease,
    primaryMetric: input.primaryMetric,
    qualityPassed,
    baselinePassRate,
    candidatePassRate,
    foregroundTokenDelta,
    foregroundTokenDeltaPercent,
    improved: qualityPassed && metricImproved,
    createdAt: input.createdAt,
    metadata: input.metadata ?? {},
  });
  return BenchmarkComparisonSchema.parse({
    ...content,
    contentHash: contentHash(content),
  });
}

function providerUsage(input: unknown): z.infer<typeof BenchmarkUsageSchema> {
  const records = Array.isArray(input) ? input : input ? [input] : [];
  return records.reduce(
    (total, value) => addUsage(total, usageRecord(value)),
    emptyUsage(),
  );
}

function usageRecord(value: unknown): z.infer<typeof BenchmarkUsageSchema> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyUsage();
  }
  const record = value as Record<string, unknown>;
  const inputTokens = token(record, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
  const outputTokens = token(record, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
  const reportedTotal = token(record, ["totalTokens", "total_tokens"]);
  return {
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal || inputTokens + outputTokens,
  };
}

function token(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.trunc(value);
    }
  }
  return 0;
}

function emptyUsage(): z.infer<typeof BenchmarkUsageSchema> {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(
  left: z.infer<typeof BenchmarkUsageSchema>,
  right: z.infer<typeof BenchmarkUsageSchema>,
): z.infer<typeof BenchmarkUsageSchema> {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

export type BenchmarkMetric = z.infer<typeof BenchmarkMetricSchema>;
export type BenchmarkRunPhase = z.infer<typeof BenchmarkRunPhaseSchema>;
export type BenchmarkProtocol = z.infer<typeof BenchmarkProtocolSchema>;
export type BenchmarkDefinition = z.infer<typeof BenchmarkDefinitionSchema>;
export type BenchmarkRunRequest = z.infer<typeof BenchmarkRunRequestSchema>;
export type BenchmarkRunSummary = z.infer<typeof BenchmarkRunSummarySchema>;
export type BenchmarkComparison = z.infer<typeof BenchmarkComparisonSchema>;
