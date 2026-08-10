import { z } from "zod";

import {
  ImmutableReleaseRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
  VersionedReleaseRefSchema,
} from "./release-core.js";
import {
  BaseModelPreferenceSchema,
  TaskFailureClassSchema,
} from "./tasksets.js";
import { ChatModelRefSchema } from "./providers.js";
import { CorrelatedTelemetryReceiptSchema } from "./training-benchmark.js";

export const ModelVersionKindSchema = z.enum([
  "base_reference",
  "lora_adapter",
]);

export const ModelVersionSchema = z
  .object({
    schemaVersion: z.literal("openpond.modelVersion.v1"),
    id: ReleaseIdSchema,
    modelId: ReleaseIdSchema,
    profileId: ReleaseIdSchema,
    version: z.number().int().nonnegative(),
    kind: ModelVersionKindSchema,
    status: z.enum(["available", "failed"]),
    baseModel: BaseModelPreferenceSchema,
    taskset: VersionedReleaseRefSchema,
    releaseGraph: z
      .object({
        resolvedBundleHash: ReleaseHashSchema,
        profileRelease: VersionedReleaseRefSchema,
        harnessRelease: ImmutableReleaseRefSchema,
        agentRelease: ImmutableReleaseRefSchema.nullable(),
        grader: z
          .object({
            id: ReleaseIdSchema,
            contentHash: ReleaseHashSchema,
          })
          .strict(),
      })
      .strict(),
    artifactLineageId: ReleaseIdSchema.nullable(),
    adapterStatus: z.enum(["not_trained", "trained"]),
    createdAt: ReleaseTimestampSchema,
    contentHash: ReleaseHashSchema,
  })
  .strict()
  .superRefine((version, context) => {
    if (
      version.kind === "base_reference"
      && (
        version.version !== 0
        || version.adapterStatus !== "not_trained"
        || version.artifactLineageId !== null
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A base-reference Model Version must be version 0 without adapter lineage.",
      });
    }
    if (
      version.kind === "lora_adapter"
      && (
        version.version === 0
        || version.adapterStatus !== "trained"
        || !version.artifactLineageId
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A LoRA Model Version must be version 1+ with adapter lineage.",
      });
    }
  });

export const ModelRunReceiptSchema = z
  .object({
    schemaVersion: z.literal("openpond.modelRunReceipt.v1"),
    provider: ReleaseIdSchema,
    providerRunId: ReleaseIdSchema,
    assignmentHash: ReleaseHashSchema,
    resultHash: ReleaseHashSchema,
    transcriptHash: ReleaseHashSchema,
    traceHash: ReleaseHashSchema.nullable(),
    resolvedBundleHash: ReleaseHashSchema,
    artifactPath: z.string().trim().min(1).max(2_000),
    cleanup: z
      .object({
        computeReleased: z.boolean(),
        tunnelClosed: z.boolean(),
      })
      .strict(),
    telemetry: CorrelatedTelemetryReceiptSchema.nullable().default(null),
    contentHash: ReleaseHashSchema,
  })
  .strict();

const EvaluationUsageCategorySchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
}).strict();
const GitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const ModelEvaluationAttemptSchema = z.object({
  phase: z.enum(["baseline", "adaptation", "candidate"]),
  taskId: ReleaseIdSchema,
  attemptId: ReleaseIdSchema,
  sessionId: ReleaseIdSchema.nullable(),
  turnId: ReleaseIdSchema.nullable(),
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  failureClass: TaskFailureClassSchema.nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  startedAt: ReleaseTimestampSchema,
}).strict();

export const ModelEvaluationReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.modelEvaluationReceipt.v1"),
  benchmarkId: ReleaseIdSchema,
  resultManifest: z.object({
    id: ReleaseIdSchema,
    contentHash: ReleaseHashSchema,
    artifactPath: z.string().trim().min(1).max(2_000),
  }).strict(),
  stages: z.object({
    baseline: ImmutableReleaseRefSchema,
    adaptation: ImmutableReleaseRefSchema,
    refiner: ImmutableReleaseRefSchema,
    candidate: ImmutableReleaseRefSchema,
    comparison: ImmutableReleaseRefSchema,
  }).strict(),
  usage: z.object({
    baseline: EvaluationUsageCategorySchema,
    candidate: EvaluationUsageCategorySchema,
    refiner: EvaluationUsageCategorySchema,
    grader: EvaluationUsageCategorySchema,
  }).strict(),
  quality: z.object({
    baselinePassRate: z.number().min(0).max(1),
    candidatePassRate: z.number().min(0).max(1),
    passed: z.boolean(),
  }).strict(),
  foregroundTokenDelta: z.number().int(),
  foregroundTokenDeltaPercent: z.number().finite().nullable(),
  attempts: z.array(ModelEvaluationAttemptSchema).max(10_000).default([]),
  terminalClassification: z.enum([
    "improved",
    "no_improvement",
    "regressed",
    "inconclusive",
    "cancelled",
    "infrastructure_failure",
  ]),
  profileGit: z.object({
    ref: z.string().trim().min(1).max(2_000),
    commit: GitObjectIdSchema,
    baseCommit: GitObjectIdSchema,
  }).strict().nullable(),
  contentHash: ReleaseHashSchema,
}).strict();

export const ModelEvaluationConfigurationSchema = z.object({
  benchmarkId: ReleaseIdSchema,
  mode: z.enum(["smoke", "full"]),
  model: ChatModelRefSchema,
  upstreamModel: z.object({
    providerId: ReleaseIdSchema,
    modelId: z.string().trim().min(1).max(300),
    revision: z.string().trim().min(1).max(300).nullable(),
  }).strict().nullable(),
  reasoningEffort: z.string().trim().min(1).max(100).nullable(),
  seeds: z.array(z.number().int()).min(1).max(100),
  repetitions: z.number().int().positive().max(20),
  maximumSpendUsd: z.number().nonnegative(),
}).strict();

export const ModelRunSchema = z
  .object({
    schemaVersion: z.literal("openpond.modelRun.v1"),
    id: ReleaseIdSchema,
    modelId: ReleaseIdSchema,
    modelVersionId: ReleaseIdSchema,
    profileId: ReleaseIdSchema,
    kind: z.enum(["rollout_smoke", "training", "evaluation"]),
    status: z.enum([
      "prepared",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ]),
    method: z.enum([
      "sft",
      "dpo",
      "grpo",
      "ppo",
      "sdft",
      "opd",
      "opsd",
      "sdpo",
    ]).nullable(),
    destinationId: ReleaseIdSchema.nullable(),
    taskset: VersionedReleaseRefSchema,
    harnessRelease: ImmutableReleaseRefSchema.nullable().optional(),
    quote: z
      .object({
        maximumSpendUsd: z.number().nonnegative(),
        hourlyCostUsd: z.number().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    evaluation: ModelEvaluationConfigurationSchema.nullable().default(null),
    evaluationProgress: z.object({
      stage: z.enum([
        "baseline",
        "adaptation",
        "refiner",
        "candidate",
        "comparison",
      ]),
      completedAttempts: z.number().int().nonnegative(),
      totalAttempts: z.number().int().positive(),
    }).strict().nullable().default(null),
    reward: z
      .object({
        raw: z.number(),
        components: z.record(z.string(), z.number()),
      })
      .strict()
      .nullable(),
    receipt: z.union([ModelRunReceiptSchema, ModelEvaluationReceiptSchema]).nullable(),
    adapterArtifactLineageId: ReleaseIdSchema.nullable(),
    failure: z.string().trim().min(1).max(5_000).nullable(),
    startedAt: ReleaseTimestampSchema,
    completedAt: ReleaseTimestampSchema.nullable(),
    updatedAt: ReleaseTimestampSchema,
  })
  .strict()
  .superRefine((run, context) => {
    if (run.status === "succeeded" && !run.receipt) {
      context.addIssue({
        code: "custom",
        message: "A successful Model Run requires a canonical receipt.",
      });
    }
    if (
      run.kind === "evaluation"
      && (
        run.method !== null
        || run.destinationId !== null
        || !run.evaluation
        || run.adapterArtifactLineageId !== null
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "An evaluation Model Run requires evaluation configuration and cannot claim training method, destination, or adapter lineage.",
      });
    }
    if (
      run.kind === "evaluation"
      && run.receipt
      && run.receipt.schemaVersion !== "openpond.modelEvaluationReceipt.v1"
    ) {
      context.addIssue({
        code: "custom",
        message: "An evaluation Model Run requires an evaluation receipt.",
      });
    }
    if (
      run.kind !== "evaluation"
      && (run.method === null || run.destinationId === null || run.quote === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A training or rollout Model Run requires method, destination, and quote.",
      });
    }
    if (
      run.kind === "rollout_smoke"
      && run.adapterArtifactLineageId !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "A rollout smoke cannot claim adapter artifacts.",
      });
    }
  });

export type ModelVersionKind = z.infer<typeof ModelVersionKindSchema>;
export type ModelVersion = z.infer<typeof ModelVersionSchema>;
export type ModelRunReceipt = z.infer<typeof ModelRunReceiptSchema>;
export type ModelEvaluationReceipt = z.infer<typeof ModelEvaluationReceiptSchema>;
export type ModelEvaluationConfiguration = z.infer<typeof ModelEvaluationConfigurationSchema>;
export type ModelRun = z.infer<typeof ModelRunSchema>;
