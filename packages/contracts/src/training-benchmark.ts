import { z } from "zod";

import {
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
} from "./release-core.js";

const NullableIdSchema = ReleaseIdSchema.nullable();
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const GitRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/);

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

export type CorrelatedTelemetryReceipt = z.infer<
  typeof CorrelatedTelemetryReceiptSchema
>;
