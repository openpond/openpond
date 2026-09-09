import { z } from "zod";

import { LearningSignalEnvelopeSchema } from "./learning-signals.js";
import {
  ImmutableReleaseRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
} from "./release-core.js";

export { HarnessRuntimeTargetBindingSchema, ComputeTargetBindingSchema, TrainingEngineBindingSchema, HarnessRunManifestContentSchema, HarnessRunManifestSchema, ResolvedTrainingBundleContentSchema, ResolvedTrainingBundleManifestSchema, type HarnessRuntimeTargetBinding, type ComputeTargetBinding, type TrainingEngineBinding, type HarnessRunManifest, type ResolvedTrainingBundleManifest } from "openpond-sdk/training-bundle";

export const ModelActionSchema = z
  .object({
    id: ReleaseIdSchema,
    turn: z.number().int().nonnegative(),
    kind: z.enum(["message", "tool_call", "terminal"]),
    name: ReleaseIdSchema.nullable(),
    arguments: z.record(z.string(), z.unknown()),
    content: z.string().max(1_000_000).nullable(),
    contentHash: ReleaseHashSchema,
  })
  .strict();

export const ToolObservationSchema = z
  .object({
    actionId: ReleaseIdSchema,
    turn: z.number().int().nonnegative(),
    terminal: z.boolean(),
    output: z.record(z.string(), z.unknown()),
    artifactRefs: z.array(z.string().trim().min(1).max(2_000)),
    contentHash: ReleaseHashSchema,
  })
  .strict();

export const HarnessRuntimeEventReceiptSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    type: z.enum([
      "created",
      "reset",
      "action",
      "observation",
      "terminal",
      "graded",
      "feedback",
      "failure",
      "collected",
      "destroyed",
    ]),
    timestamp: ReleaseTimestampSchema,
    payloadHash: ReleaseHashSchema,
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const HarnessGraderEvidenceSchema = z
  .object({
    graderId: ReleaseIdSchema,
    graderVersion: z.string().trim().min(1).max(200),
    score: z.number().finite().nullable(),
    passed: z.boolean(),
    rewardEligible: z.boolean(),
    failureClass: z
      .enum([
        "policy_failure",
        "grader_failure",
        "environment_failure",
        "infrastructure_failure",
        "timeout",
        "cancelled",
      ])
      .nullable(),
    feedback: z.array(z.string().max(500_000)),
    visibleEvidenceRefs: z.array(z.string().trim().min(1).max(2_000)),
    privilegedEvidenceRefs: z.array(z.string().trim().min(1).max(2_000)),
    contentHash: ReleaseHashSchema,
  })
  .strict();

export const HarnessRunTraceSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessRunTrace.v1"),
    manifest: ImmutableReleaseRefSchema,
    taskId: ReleaseIdSchema,
    seed: z.string().trim().min(1).max(500),
    events: z.array(HarnessRuntimeEventReceiptSchema).max(1_000_000),
    actions: z.array(ModelActionSchema).max(100_000),
    observations: z.array(ToolObservationSchema).max(100_000),
    graderEvidence: z.array(HarnessGraderEvidenceSchema).max(10_000),
    learningSignals: z.array(LearningSignalEnvelopeSchema).max(100_000),
    terminal: z.boolean(),
    failureClass: HarnessGraderEvidenceSchema.shape.failureClass,
    artifactHash: ReleaseHashSchema,
    contentHash: ReleaseHashSchema,
  })
  .strict();

export type ModelAction = z.infer<typeof ModelActionSchema>;
export type ToolObservation = z.infer<typeof ToolObservationSchema>;
export type HarnessRuntimeEventReceipt = z.infer<
  typeof HarnessRuntimeEventReceiptSchema
>;
export type HarnessGraderEvidence = z.infer<
  typeof HarnessGraderEvidenceSchema
>;
export type HarnessRunTrace = z.infer<typeof HarnessRunTraceSchema>;
