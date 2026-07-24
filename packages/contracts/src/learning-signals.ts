import { z } from "zod";

import {
  ImmutableReleaseRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
} from "./release-core.js";

export const LearningSignalKindSchema = z.enum([
  "trajectory",
  "reward",
  "demonstration",
  "preference",
  "correction",
  "critique",
  "targeted_feedback",
  "grader_evidence",
  "infrastructure_failure",
]);

export const LearningSignalLineageSchema = z
  .object({
    datasetRelease: ImmutableReleaseRefSchema,
    harnessRelease: ImmutableReleaseRefSchema,
    evidenceSetRelease: ImmutableReleaseRefSchema.nullable(),
    profileRelease: ImmutableReleaseRefSchema.nullable(),
    model: z
      .object({
        source: z.string().trim().min(1).max(200),
        revision: z.string().trim().min(1).max(500),
        artifactHash: ReleaseHashSchema.nullable(),
      })
      .strict(),
    environmentHash: ReleaseHashSchema,
    graderHash: ReleaseHashSchema,
    toolContractHash: ReleaseHashSchema,
    verificationReceiptHash: ReleaseHashSchema.nullable(),
  })
  .strict();

const LearningSignalBaseSchema = z
  .object({
    schemaVersion: z.literal("openpond.learningSignal.v1"),
    id: ReleaseIdSchema,
    taskId: ReleaseIdSchema.nullable(),
    episodeId: ReleaseIdSchema.nullable(),
    policyVersion: z.number().int().nonnegative().nullable(),
    lineage: LearningSignalLineageSchema,
    approved: z.boolean(),
    verifier: z.enum(["deterministic", "model_judge", "human", "none"]),
    createdAt: ReleaseTimestampSchema,
    contentHash: ReleaseHashSchema,
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const OptimizerTrainingSampleSchema = z
  .object({
    schemaVersion: z.literal("openpond.optimizerTrainingSample.v1"),
    tokenIds: z.array(z.number().int().nonnegative()).min(2).max(32_768),
    mask: z.array(z.boolean()).min(2).max(32_768),
    logprobs: z.array(z.number().finite()).min(2).max(32_768),
    temperatures: z
      .array(z.number().positive().finite())
      .min(2)
      .max(32_768),
    envName: z.string().trim().min(1).max(200),
    modelRequestId: z.string().trim().min(1).max(1_000),
    promptTokenCount: z.number().int().positive(),
    completionTokenCount: z.number().int().positive(),
    servedPolicyVersion: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((sample, context) => {
    const length = sample.tokenIds.length;
    for (const [name, values] of [
      ["mask", sample.mask],
      ["logprobs", sample.logprobs],
      ["temperatures", sample.temperatures],
    ] as const) {
      if (values.length !== length) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: `${name} must align with tokenIds`,
        });
      }
    }
    if (sample.promptTokenCount + sample.completionTokenCount !== length) {
      context.addIssue({
        code: "custom",
        path: ["completionTokenCount"],
        message: "prompt and completion token counts must span tokenIds",
      });
    }
    if (
      sample.mask
        .slice(0, sample.promptTokenCount)
        .some((trainable) => trainable)
    ) {
      context.addIssue({
        code: "custom",
        path: ["mask"],
        message: "prompt tokens cannot be trainable",
      });
    }
    if (
      sample.mask
        .slice(sample.promptTokenCount)
        .some((trainable) => !trainable)
    ) {
      context.addIssue({
        code: "custom",
        path: ["mask"],
        message: "completion tokens must be trainable",
      });
    }
  });

export const TrajectoryLearningSignalSchema = LearningSignalBaseSchema.extend({
  kind: z.literal("trajectory"),
  payload: z
    .object({
      traceRef: z.string().trim().min(1).max(2_000),
      traceHash: ReleaseHashSchema,
      terminal: z.boolean(),
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
      optimizerSample: OptimizerTrainingSampleSchema.nullable().optional(),
    })
    .strict(),
}).strict();

export const RewardLearningSignalSchema = LearningSignalBaseSchema.extend({
  kind: z.literal("reward"),
  payload: z
    .object({
      reward: z.number().finite(),
      components: z.record(z.string(), z.number().finite()),
      eligible: z.boolean(),
      graderEvidenceRefs: z.array(ReleaseIdSchema).max(1_000),
    })
    .strict(),
}).strict();

export const DemonstrationLearningSignalSchema =
  LearningSignalBaseSchema.extend({
    kind: z.literal("demonstration"),
    payload: z
      .object({
        prompt: z.string().max(500_000),
        response: z.string().max(1_000_000),
      })
      .strict(),
  }).strict();

export const PreferenceLearningSignalSchema = LearningSignalBaseSchema.extend({
  kind: z.literal("preference"),
  payload: z
    .object({
      prompt: z.string().max(500_000),
      chosen: z.string().max(1_000_000),
      rejected: z.string().max(1_000_000),
      rationale: z.string().max(500_000).nullable(),
    })
    .strict(),
}).strict();

export const CorrectionLearningSignalSchema = LearningSignalBaseSchema.extend({
  kind: z.literal("correction"),
  payload: z
    .object({
      original: z.string().max(1_000_000),
      corrected: z.string().max(1_000_000),
      rationale: z.string().max(500_000).nullable(),
    })
    .strict(),
}).strict();

export const CritiqueLearningSignalSchema = LearningSignalBaseSchema.extend({
  kind: z.literal("critique"),
  payload: z
    .object({
      response: z.string().max(1_000_000),
      critique: z.string().max(500_000),
      severity: z.enum(["note", "warning", "error"]),
    })
    .strict(),
}).strict();

export const TargetedFeedbackLearningSignalSchema =
  LearningSignalBaseSchema.extend({
    kind: z.literal("targeted_feedback"),
    payload: z
      .object({
        turnIndex: z.number().int().nonnegative(),
        target: z.enum(["reasoning", "tool", "answer", "policy"]),
        feedback: z.string().max(500_000),
      })
      .strict(),
  }).strict();

export const GraderEvidenceLearningSignalSchema =
  LearningSignalBaseSchema.extend({
    kind: z.literal("grader_evidence"),
    payload: z
      .object({
        graderId: ReleaseIdSchema,
        score: z.number().finite().nullable(),
        passed: z.boolean(),
        privilegedArtifactRefs: z.array(z.string().trim().min(1).max(2_000)),
      })
      .strict(),
  }).strict();

export const InfrastructureFailureLearningSignalSchema =
  LearningSignalBaseSchema.extend({
    kind: z.literal("infrastructure_failure"),
    approved: z.literal(false),
    verifier: z.literal("none"),
    payload: z
      .object({
        code: ReleaseIdSchema,
        phase: ReleaseIdSchema,
        retryable: z.boolean(),
        rewardEligible: z.literal(false),
      })
      .strict(),
  }).strict();

export const LearningSignalEnvelopeSchema = z.discriminatedUnion("kind", [
  TrajectoryLearningSignalSchema,
  RewardLearningSignalSchema,
  DemonstrationLearningSignalSchema,
  PreferenceLearningSignalSchema,
  CorrectionLearningSignalSchema,
  CritiqueLearningSignalSchema,
  TargetedFeedbackLearningSignalSchema,
  GraderEvidenceLearningSignalSchema,
  InfrastructureFailureLearningSignalSchema,
]);

export const LearningSignalBatchSchema = z
  .object({
    schemaVersion: z.literal("openpond.learningSignalBatch.v1"),
    manifestId: ReleaseIdSchema,
    manifestHash: ReleaseHashSchema,
    sequence: z.number().int().nonnegative(),
    signals: z.array(LearningSignalEnvelopeSchema).min(1).max(100_000),
    contentHash: ReleaseHashSchema,
  })
  .strict();

export type LearningSignalKind = z.infer<typeof LearningSignalKindSchema>;
export type OptimizerTrainingSample = z.infer<
  typeof OptimizerTrainingSampleSchema
>;
export type LearningSignalLineage = z.infer<
  typeof LearningSignalLineageSchema
>;
export type LearningSignalEnvelope = z.infer<
  typeof LearningSignalEnvelopeSchema
>;
export type LearningSignalBatch = z.infer<typeof LearningSignalBatchSchema>;
