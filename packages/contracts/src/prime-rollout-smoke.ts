import { z } from "zod";

import {
  ImmutableReleaseRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
  VersionedReleaseRefSchema,
} from "./release-core.js";
import { OptimizerTrainingSampleSchema } from "./learning-signals.js";
import { TelemetrySpanSchema } from "./training-benchmark.js";

const ModelIdSchema = z.string().trim().min(1).max(500);
const ModelRevisionSchema = z.string().regex(/^[a-f0-9]{40,64}$/);

export const PrimeRolloutSmokeRequestSchema = z
  .object({
    tasksetId: ReleaseIdSchema,
    maximumSpendUsd: z.number().positive().max(13),
    approved: z.literal(true),
  })
  .strict();

export const PrimeRolloutAssignmentSchema = z
  .object({
    schemaVersion: z.literal("openpond.primeRolloutAssignment.v1"),
    runId: ReleaseIdSchema,
    resolvedBundleHash: ReleaseHashSchema,
    taskset: VersionedReleaseRefSchema,
    harnessRelease: ImmutableReleaseRefSchema,
    profileRelease: VersionedReleaseRefSchema,
    agentRelease: ImmutableReleaseRefSchema,
    taskId: ReleaseIdSchema,
    split: z.enum(["train", "validation", "frozen_eval"]),
    policyVersion: z.union([
      z.literal("base"),
      z.number().int().nonnegative(),
    ]),
    model: z
      .object({
        id: ModelIdSchema,
        revision: ModelRevisionSchema,
      })
      .strict(),
    inferencePort: z.number().int().min(1).max(65_535),
    createdAt: ReleaseTimestampSchema,
    assignmentHash: ReleaseHashSchema,
  })
  .strict();

export const MarketingPortfolioHarnessGradeSchema = z
  .object({
    schemaVersion: z.literal("openpond.marketingPortfolioGrade.v1"),
    benchmarkId: z.literal("marketing-portfolio-v1"),
    agentReleaseHash: ReleaseHashSchema,
    scorerImplementationHash: ReleaseHashSchema,
    terminalActionId: z.literal("submit-budget-decision"),
    decisionAccepted: z.boolean(),
    caseRef: ReleaseHashSchema,
    traceHash: ReleaseHashSchema,
    reward: z.number().min(0).max(1),
    components: z
      .object({
        constraints: z.number().min(0).max(1),
        portfolioValue: z.number().min(0).max(1),
        riskControls: z.number().min(0).max(1),
        rationale: z.number().min(0).max(1),
      })
      .strict(),
  })
  .strict();

export const RolloutSamplingTraceSchema = z
  .object({
    requestId: ReleaseIdSchema,
    servedModel: ModelIdSchema,
    startedAt: ReleaseTimestampSchema,
    completedAt: ReleaseTimestampSchema,
    durationMs: z.number().nonnegative(),
    requested: z
      .object({
        temperature: z.number().positive(),
        topP: z.number().positive().max(1),
        maxOutputTokens: z.number().int().positive(),
        logprobs: z.boolean(),
        tokenIds: z.boolean(),
      })
      .strict(),
    support: z
      .object({
        temperature: z.enum(["applied", "ignored", "unknown"]),
        topP: z.enum(["applied", "ignored", "unknown"]),
        logprobs: z.enum(["returned", "unsupported", "unknown"]),
        tokenIds: z.enum(["returned", "unsupported", "unknown"]),
      })
      .strict(),
    promptTokenIds: z.array(z.number().int().nonnegative()).max(32_768),
    generatedTokenIds: z.array(z.number().int().nonnegative()).max(32_768),
    generatedLogprobs: z.array(z.number().finite()).max(32_768),
    usage: z
      .object({
        promptTokens: z.number().int().nonnegative(),
        generatedTokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((trace, context) => {
    if (
      (
        trace.support.tokenIds === "returned"
        && (
          trace.usage.promptTokens !== trace.promptTokenIds.length
          || trace.usage.generatedTokens
            !== trace.generatedTokenIds.length
        )
      )
      || (
        trace.support.logprobs === "returned"
        && trace.generatedTokenIds.length
          !== trace.generatedLogprobs.length
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Sampling token IDs, logprobs, and usage counts must remain aligned.",
      });
    }
  });

export const PrimeRolloutResultSchema = z
  .object({
    schemaVersion: z.literal("openpond.primeRolloutResult.v1"),
    runId: ReleaseIdSchema,
    assignmentHash: ReleaseHashSchema,
    status: z.enum(["succeeded", "failed"]),
    taskId: ReleaseIdSchema,
    policyVersion: PrimeRolloutAssignmentSchema.shape.policyVersion,
    model: z
      .object({
        id: ModelIdSchema,
        revision: ModelRevisionSchema,
      })
      .strict(),
    samplingTraces: z.array(RolloutSamplingTraceSchema).max(64).default([]),
    optimizerSample: OptimizerTrainingSampleSchema.nullable().default(null),
    executionSpans: z.array(TelemetrySpanSchema).max(1_000).default([]),
    toolSequence: z.array(
      z.enum(["get_portfolio_snapshot", "submit_budget_decision"]),
    ).max(20),
    toolTrace: z
      .array(
        z
          .object({
            turn: z.number().int().nonnegative(),
            toolCallId: ReleaseIdSchema,
            toolName: z.enum([
              "get_portfolio_snapshot",
              "submit_budget_decision",
            ]),
            policyArguments: z.record(z.string(), z.unknown()),
            executedArguments: z.record(z.string(), z.unknown()),
            publicProjectionApplied: z.boolean(),
            observation: z.record(z.string(), z.unknown()),
            terminal: z.boolean(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    transcriptHash: ReleaseHashSchema,
    grade: MarketingPortfolioHarnessGradeSchema.nullable(),
    terminal: z.boolean(),
    failure: z.string().trim().min(1).max(2_000).nullable(),
    completedAt: ReleaseTimestampSchema,
    resultHash: ReleaseHashSchema,
  })
  .strict();

export const PrimeRolloutSmokeReportSchema = z
  .object({
    schemaVersion: z.literal("openpond.primeRolloutSmokeReport.v1"),
    runId: ReleaseIdSchema,
    provider: z.literal("prime"),
    nodeId: ReleaseIdSchema,
    hourlyCostUsd: z.number().nonnegative(),
    maximumSpendUsd: z.number().positive().max(13),
    model: PrimeRolloutAssignmentSchema.shape.model,
    upload: z
      .object({
        transport: z.literal("scp"),
        resolvedBundleHash: ReleaseHashSchema,
        uploaded: z.literal(true),
      })
      .strict(),
    assignment: PrimeRolloutAssignmentSchema,
    result: PrimeRolloutResultSchema,
    cleanup: z
      .object({
        podTerminated: z.boolean(),
        tunnelClosed: z.boolean(),
      })
      .strict(),
    startedAt: ReleaseTimestampSchema,
    completedAt: ReleaseTimestampSchema,
  })
  .strict();

export type PrimeRolloutSmokeRequest = z.infer<
  typeof PrimeRolloutSmokeRequestSchema
>;
export type PrimeRolloutAssignment = z.infer<
  typeof PrimeRolloutAssignmentSchema
>;
export type MarketingPortfolioHarnessGrade = z.infer<
  typeof MarketingPortfolioHarnessGradeSchema
>;
export type RolloutSamplingTrace = z.infer<
  typeof RolloutSamplingTraceSchema
>;
export type PrimeRolloutResult = z.infer<typeof PrimeRolloutResultSchema>;
export type PrimeRolloutSmokeReport = z.infer<
  typeof PrimeRolloutSmokeReportSchema
>;
