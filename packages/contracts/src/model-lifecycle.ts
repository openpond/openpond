import { z } from "zod";

import {
  ImmutableReleaseRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
  VersionedReleaseRefSchema,
} from "./release-core.js";
import { BaseModelPreferenceSchema } from "./tasksets.js";
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
    ]),
    destinationId: ReleaseIdSchema,
    taskset: VersionedReleaseRefSchema,
    harnessRelease: ImmutableReleaseRefSchema.nullable().optional(),
    quote: z
      .object({
        maximumSpendUsd: z.number().nonnegative(),
        hourlyCostUsd: z.number().nonnegative().nullable(),
      })
      .strict(),
    reward: z
      .object({
        raw: z.number(),
        components: z.record(z.string(), z.number()),
      })
      .strict()
      .nullable(),
    receipt: ModelRunReceiptSchema.nullable(),
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
export type ModelRun = z.infer<typeof ModelRunSchema>;
