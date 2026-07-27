import { z } from "zod";

import { ChatModelRefSchema } from "./providers.js";
import {
  ImmutableReleaseRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
  VersionedReleaseRefSchema,
} from "./release-core.js";

const NullableIdSchema = ReleaseIdSchema.nullable();
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const GitRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const MARKETING_BENCHMARK_MINIMUM_CANDIDATE_SCORE = 0.85;
export const MARKETING_BENCHMARK_MINIMUM_IMPROVEMENT = 0.02;

export const TelemetrySpanSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    startedAt: ReleaseTimestampSchema,
    completedAt: ReleaseTimestampSchema,
    durationMs: z.number().nonnegative(),
    clock: z.enum(["monotonic", "provider", "wall"]),
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
  })
  .strict();

export const CorrelatedTelemetryReceiptSchema = z
  .object({
    schemaVersion: z.literal("openpond.correlatedTelemetryReceipt.v1"),
    stage: z.enum(["training", "evaluation", "deployment", "inference"]),
    correlation: z
      .object({
        modelRunId: NullableIdSchema,
        modelVersionId: NullableIdSchema,
        policyVersion: NonNegativeIntegerSchema.nullable(),
        taskId: NullableIdSchema,
        rolloutGroupId: NullableIdSchema,
        providerResourceId: NullableIdSchema,
        deploymentId: NullableIdSchema,
        inferenceRequestId: NullableIdSchema,
      })
      .strict(),
    spans: z.array(TelemetrySpanSchema).max(10_000),
    usage: z
      .object({
        promptTokens: NonNegativeIntegerSchema.nullable(),
        generatedTokens: NonNegativeIntegerSchema.nullable(),
        gpuSeconds: z.number().nonnegative().nullable(),
        workerActiveSeconds: z.number().nonnegative().nullable(),
        optimizerSteps: NonNegativeIntegerSchema.nullable(),
        rolloutGroups: NonNegativeIntegerSchema.nullable(),
        successfulTrajectories: NonNegativeIntegerSchema.nullable(),
        failedTrajectories: NonNegativeIntegerSchema.nullable(),
        peakGpuMemoryBytes: NonNegativeIntegerSchema.nullable(),
        peakGpuUtilizationPercent: z.number().min(0).max(100).nullable(),
      })
      .strict(),
    resource: z
      .object({
        provider: ReleaseIdSchema,
        resourceIds: z.array(ReleaseIdSchema).max(1_000),
        gpuType: z.string().trim().min(1).max(300).nullable(),
        gpuCount: NonNegativeIntegerSchema.nullable(),
        baseProfileId: NullableIdSchema,
        baseRepository: z.string().trim().min(1).max(512).nullable(),
        baseRevision: GitRevisionSchema.nullable(),
        adapterContentHash: ReleaseHashSchema.nullable(),
      })
      .strict(),
    cost: z
      .object({
        currency: z.literal("USD"),
        providerReportedUsd: z.number().nonnegative().nullable(),
        quotedHourlyUsd: z.number().nonnegative().nullable(),
        estimatedUsd: z.number().nonnegative().nullable(),
        methodologyVersion: z.string().trim().min(1).max(160),
        pricingInputs: z.record(
          z.string().trim().min(1).max(160),
          z.number().finite(),
        ),
        unitEstimates: z.record(
          z.string().trim().min(1).max(160),
          z.number().nonnegative(),
        ),
      })
      .strict(),
    recordedAt: ReleaseTimestampSchema,
    contentHash: ReleaseHashSchema,
  })
  .strict();

export const MarketingBenchmarkArmSchema = z.enum([
  "base",
  "candidate",
  "frontier_reference",
]);

export const MarketingBenchmarkModelIdentitySchema = z
  .object({
    arm: MarketingBenchmarkArmSchema,
    model: ChatModelRefSchema,
    modelProjectId: NullableIdSchema,
    modelVersion: NonNegativeIntegerSchema.nullable(),
    modelVersionId: NullableIdSchema,
    baseRepository: z.string().trim().min(1).max(512).nullable(),
    baseRevision: GitRevisionSchema.nullable(),
    adapterContentHash: ReleaseHashSchema.nullable(),
    providerResponseIdentityRequired: z.boolean(),
  })
  .strict()
  .superRefine((identity, context) => {
    const localArm = identity.arm !== "frontier_reference";
    if (
      localArm
      && (
        !identity.modelProjectId
        || identity.modelVersion === null
        || !identity.baseRepository
        || !identity.baseRevision
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Base and candidate arms require immutable Model lineage.",
      });
    }
    if (
      identity.arm === "frontier_reference"
      && (
        identity.modelProjectId !== null
        || identity.modelVersion !== null
        || identity.modelVersionId !== null
        || !identity.providerResponseIdentityRequired
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The frontier arm must retain provider response identity without local Model lineage.",
      });
    }
  });

export const MarketingBenchmarkAttemptScheduleEntrySchema = z
  .object({
    taskId: ReleaseIdSchema,
    attempt: z.number().int().min(0).max(3),
    seed: z.number().int(),
  })
  .strict();

export const MarketingBenchmarkSpecificationSchema = z
  .object({
    schemaVersion: z.literal("openpond.marketingBenchmarkSpecification.v1"),
    id: ReleaseIdSchema,
    profileId: ReleaseIdSchema,
    benchmarkId: z.literal("marketing-portfolio-v1"),
    taskset: VersionedReleaseRefSchema,
    harnessRelease: ImmutableReleaseRefSchema,
    policyHarnessContractHash: ReleaseHashSchema,
    profileRelease: VersionedReleaseRefSchema,
    agentRelease: ImmutableReleaseRefSchema,
    grader: z
      .object({
        id: ReleaseIdSchema,
        contentHash: ReleaseHashSchema,
      })
      .strict(),
    actions: z
      .array(
        z
          .object({
            id: ReleaseIdSchema,
            name: z.enum([
              "get_portfolio_snapshot",
              "submit_budget_decision",
            ]),
            schemaHash: ReleaseHashSchema,
            implementationHash: ReleaseHashSchema,
          })
          .strict(),
      )
      .length(2),
    frozenTaskIds: z.array(ReleaseIdSchema).length(8),
    attemptsPerTask: z.literal(4),
    attemptSchedule: z
      .array(MarketingBenchmarkAttemptScheduleEntrySchema)
      .length(32),
    sampling: z
      .object({
        maxOutputTokens: z.number().int().positive().max(32_768),
        temperature: z.number().min(0).max(2),
        topP: z.number().positive().max(1),
      })
      .strict(),
    maxTurns: z.number().int().positive().max(64),
    timeoutMs: z.number().int().positive().max(3_600_000),
    privateCaseContractHash: ReleaseHashSchema,
    arms: z.array(MarketingBenchmarkModelIdentitySchema).length(3),
    promotionGate: z
      .object({
        primaryMetric: z.literal("unique_task_mean_deterministic_reward"),
        minimumCandidateScore: z.number().min(0).max(1),
        minimumImprovement: z.number().min(0).max(1),
        criticalConstraintHardGates: z.array(ReleaseIdSchema).min(1).max(100),
        frontierComparisonBlocksPromotion: z.literal(false),
      })
      .strict(),
    preregistration: z
      .object({
        baselineReport: ImmutableReleaseRefSchema,
        split: z.literal("train"),
        model: ChatModelRefSchema,
        observedMeanReward: z.number().min(0).max(1),
        observedRewardVariance: z.number().nonnegative(),
        mixedRewardGroups: NonNegativeIntegerSchema,
        rftSignalPassed: z.literal(true),
        thresholdsLockedBeforeTraining: z.literal(true),
      })
      .strict(),
    authoringModel: ChatModelRefSchema.nullable(),
    createdAt: ReleaseTimestampSchema,
    contentHash: ReleaseHashSchema,
  })
  .strict()
  .superRefine((specification, context) => {
    if (
      new Set(specification.frozenTaskIds).size !== 8
      || specification.actions[0]?.name !== "get_portfolio_snapshot"
      || specification.actions[1]?.name !== "submit_budget_decision"
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The marketing benchmark requires eight unique frozen tasks and the exact ordered actions.",
      });
    }
    const expectedSchedule = new Set(
      specification.frozenTaskIds.flatMap((taskId) =>
        Array.from(
          { length: specification.attemptsPerTask },
          (_, attempt) => `${taskId}:${attempt}`,
        ),
      ),
    );
    const observedSchedule = new Set(
      specification.attemptSchedule.map(
        (entry) => `${entry.taskId}:${entry.attempt}`,
      ),
    );
    if (
      observedSchedule.size !== expectedSchedule.size
      || [...expectedSchedule].some((entry) => !observedSchedule.has(entry))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The attempt schedule must cover each frozen task exactly four times.",
      });
    }
    const arms = new Set(specification.arms.map((arm) => arm.arm));
    if (
      arms.size !== 3
      || !arms.has("base")
      || !arms.has("candidate")
      || !arms.has("frontier_reference")
    ) {
      context.addIssue({
        code: "custom",
        message: "The benchmark requires exactly one identity for each arm.",
      });
    }
  });

export const MarketingBenchmarkTrajectoryReceiptSchema = z
  .object({
    arm: MarketingBenchmarkArmSchema,
    taskId: ReleaseIdSchema,
    attempt: z.number().int().min(0).max(3),
    seed: z.number().int(),
    attemptRef: ReleaseIdSchema,
    gradeRef: ReleaseIdSchema,
    reward: z.number().min(0).max(1).nullable(),
    passed: z.boolean(),
    toolSequence: z.array(z.string().trim().min(1).max(160)).max(64),
    terminalDecision: z.boolean(),
    constraintViolations: z.array(ReleaseIdSchema).max(100),
    failureClass: ReleaseIdSchema.nullable(),
    providerSamplingSupport: z
      .object({
        seed: z.boolean(),
        temperature: z.boolean(),
        topP: z.boolean(),
      })
      .strict(),
    providerResponseIdentity: z.string().trim().min(1).max(2_000),
    telemetry: CorrelatedTelemetryReceiptSchema,
  })
  .strict()
  .superRefine((trajectory, context) => {
    const validToolLoop =
      trajectory.toolSequence[0] === "get_portfolio_snapshot"
      && trajectory.toolSequence.includes("submit_budget_decision");
    if (!trajectory.failureClass && (!validToolLoop || !trajectory.terminalDecision)) {
      context.addIssue({
        code: "custom",
        message:
          "A successful marketing benchmark trajectory requires the two-action terminal tool loop.",
      });
    }
  });

export const MarketingBenchmarkReceiptSchema = z
  .object({
    schemaVersion: z.literal("openpond.marketingBenchmarkReceipt.v1"),
    id: ReleaseIdSchema,
    specificationId: ReleaseIdSchema,
    specificationHash: ReleaseHashSchema,
    candidateModelVersionId: ReleaseIdSchema,
    trajectories: z
      .array(MarketingBenchmarkTrajectoryReceiptSchema)
      .length(96),
    aggregate: z.record(
      MarketingBenchmarkArmSchema,
      z
        .object({
          uniqueTaskCount: z.literal(8),
          trajectoryCount: z.literal(32),
          meanReward: z.number().min(0).max(1),
          passRate: z.number().min(0).max(1),
          validToolCompletionRate: z.number().min(0).max(1),
          terminalDecisionRate: z.number().min(0).max(1),
          latencyMs: z.number().nonnegative(),
          promptTokens: NonNegativeIntegerSchema,
          generatedTokens: NonNegativeIntegerSchema,
          costUsd: z.number().nonnegative().nullable(),
        })
        .strict(),
    ),
    pairedComparison: z
      .object({
        candidateMinusBase: z.number().min(-1).max(1),
        candidateMinusFrontier: z.number().min(-1).max(1),
        taskLevelStandardError: z.number().nonnegative(),
        candidatePromotionPassed: z.boolean(),
        frontierWinnerClaimPassed: z.boolean(),
      })
      .strict(),
    disclosure: z.string().trim().min(1).max(20_000),
    createdAt: ReleaseTimestampSchema,
    contentHash: ReleaseHashSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    for (const arm of MarketingBenchmarkArmSchema.options) {
      const armTrajectories = receipt.trajectories.filter(
        (trajectory) => trajectory.arm === arm,
      );
      const schedule = new Set(
        armTrajectories.map(
          (trajectory) => `${trajectory.taskId}:${trajectory.attempt}`,
        ),
      );
      if (
        armTrajectories.length !== 32
        || schedule.size !== 32
        || new Set(armTrajectories.map((trajectory) => trajectory.taskId))
          .size !== 8
      ) {
        context.addIssue({
          code: "custom",
          message: `Benchmark arm ${arm} must contain 32 trajectories over eight unique tasks.`,
        });
      }
    }
  });

export const MarketingBenchmarkRunSchema = z
  .object({
    schemaVersion: z.literal("openpond.marketingBenchmarkRun.v1"),
    id: ReleaseIdSchema,
    profileId: ReleaseIdSchema,
    tasksetId: ReleaseIdSchema,
    specificationId: ReleaseIdSchema,
    specificationHash: ReleaseHashSchema,
    candidateModelVersionId: NullableIdSchema,
    status: z.enum([
      "prepared",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ]),
    progress: z
      .object({
        completedTrajectories: NonNegativeIntegerSchema,
        totalTrajectories: z.literal(96),
      })
      .strict(),
    receipt: MarketingBenchmarkReceiptSchema.nullable(),
    error: z.string().trim().min(1).max(20_000).nullable(),
    createdAt: ReleaseTimestampSchema,
    startedAt: ReleaseTimestampSchema.nullable(),
    completedAt: ReleaseTimestampSchema.nullable(),
    updatedAt: ReleaseTimestampSchema,
  })
  .strict()
  .superRefine((run, context) => {
    if (
      (run.status === "succeeded") !== Boolean(run.receipt)
      || (
        run.receipt
        && (
          run.receipt.specificationId !== run.specificationId
          || run.receipt.specificationHash !== run.specificationHash
          || run.receipt.candidateModelVersionId
            !== run.candidateModelVersionId
        )
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A successful benchmark run requires the matching immutable receipt.",
      });
    }
  });

export type CorrelatedTelemetryReceipt = z.infer<
  typeof CorrelatedTelemetryReceiptSchema
>;
export type MarketingBenchmarkArm = z.infer<
  typeof MarketingBenchmarkArmSchema
>;
export type MarketingBenchmarkModelIdentity = z.infer<
  typeof MarketingBenchmarkModelIdentitySchema
>;
export type MarketingBenchmarkSpecification = z.infer<
  typeof MarketingBenchmarkSpecificationSchema
>;
export type MarketingBenchmarkTrajectoryReceipt = z.infer<
  typeof MarketingBenchmarkTrajectoryReceiptSchema
>;
export type MarketingBenchmarkReceipt = z.infer<
  typeof MarketingBenchmarkReceiptSchema
>;
export type MarketingBenchmarkRun = z.infer<
  typeof MarketingBenchmarkRunSchema
>;
