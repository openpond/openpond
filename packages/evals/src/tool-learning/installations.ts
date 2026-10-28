import { z } from "zod";
import {
  TOOL_LEARNING_LIMITS,
  ToolLearningClientSchema,
  ToolLearningHashSchema as Hash,
  ToolLearningIdSchema as Id,
  ToolLearningRefSchema as Ref,
  ToolLearningScopeSchema,
  ToolLearningTimestampSchema as Timestamp,
  boundedToolLearningSchema,
} from "./primitives.js";

export const ToolLearningCapturePolicySchema = z
  .object({
    revision: z.number().int().positive(),
    permittedTools: z.array(z.string().min(1).max(200)).min(1).max(100),
    workspaceRootHashes: z.array(Hash).min(1).max(32),
    permittedFields: z
      .array(z.enum(["action", "intent", "state", "result_excerpt", "artifact_reference"]))
      .min(1)
      .max(5),
    unchangedControls: z
      .object({
        numerator: z.number().int().nonnegative(),
        denominator: z.number().int().positive(),
      })
      .strict(),
    maximumEventBytes: z.number().int().positive().max(TOOL_LEARNING_LIMITS.eventBytes),
    maximumEpisodeBytes: z.number().int().positive().max(TOOL_LEARNING_LIMITS.episodeBytes),
    maximumEpisodeEvents: z.number().int().positive().max(TOOL_LEARNING_LIMITS.eventsPerEpisode),
    maximumQueueBytes: z.number().int().positive().max(TOOL_LEARNING_LIMITS.queueBytes),
    maximumQueueEvents: z.number().int().positive().max(TOOL_LEARNING_LIMITS.queueEvents),
    maximumQueueAgeSeconds: z.number().int().positive().max(TOOL_LEARNING_LIMITS.queueAgeSeconds),
    rawRetentionDays: z.number().int().min(1).max(30),
    purposes: z
      .array(z.enum(["capture", "consultation"]))
      .min(1)
      .max(2),
    modelUpdates: z.literal("requires_separate_review"),
    variantGeneration: z.literal("disabled"),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.unchangedControls.numerator > policy.unchangedControls.denominator)
      context.addIssue({
        code: "custom",
        path: ["unchangedControls"],
        message: "Sampling probability cannot exceed one.",
      });
    for (const key of [
      "permittedTools",
      "workspaceRootHashes",
      "permittedFields",
      "purposes",
    ] as const)
      if (new Set(policy[key]).size !== policy[key].length)
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Policy entries must be unique.",
        });
    if (
      policy.maximumEpisodeBytes < policy.maximumEventBytes ||
      policy.maximumQueueBytes < policy.maximumEventBytes
    )
      context.addIssue({
        code: "custom",
        message: "Episode and queue capacities must fit one permitted event.",
      });
  });

export const ToolLearningCoverageSchema = z
  .object({
    receipt: Ref.nullable(),
    start: z.enum(["observed", "documented", "unsupported", "unqualified"]),
    resume: z.enum(["observed", "documented", "unsupported", "unqualified"]),
    compaction: z.enum(["observed", "documented", "unsupported", "unqualified"]),
    executionFailure: z.enum(["observed", "documented", "unsupported", "unqualified"]),
    processFailure: z.enum(["observed", "documented", "unsupported", "unqualified"]),
    validationFailure: z.enum(["observed", "documented", "unsupported", "unqualified"]),
    nestedCalls: z.enum(["observed", "documented", "unsupported", "unqualified"]),
    contextRefresh: z.enum([
      "session_start",
      "start_resume",
      "start_resume_compaction",
      "revision_aware_turn",
      "unqualified",
    ]),
    gaps: z.array(z.string().min(1).max(500)).max(32),
  })
  .strict()
  .superRefine((coverage, context) => {
    if (Object.values(coverage).includes("observed") && !coverage.receipt)
      context.addIssue({
        code: "custom",
        path: ["receipt"],
        message: "Observed coverage requires a qualification receipt.",
      });
  });

export const ToolLearningRegistrationSchema = boundedToolLearningSchema(
  z
    .object({
      schemaVersion: z.literal("openpond.toolLearningRegistration.v1"),
      operationId: Id,
      installationId: Id,
      projectId: Id,
      machineSourceId: Id,
      client: ToolLearningClientSchema,
      clientVersion: z.string().min(1).max(200),
      adapterRelease: Ref,
      collectionPolicy: ToolLearningCapturePolicySchema,
    })
    .strict(),
  TOOL_LEARNING_LIMITS.eventBytes,
);

/** Status deliberately exposes capability/expiry metadata, never the credential. */
export const ToolLearningInstallationSchema = z
  .object({
    schemaVersion: z.literal("openpond.toolLearningInstallation.v1"),
    id: Id,
    revision: z.number().int().positive(),
    scope: ToolLearningScopeSchema,
    ownerUserId: Id,
    machineSourceId: Id,
    client: ToolLearningClientSchema,
    clientVersion: z.string().min(1).max(200),
    adapterRelease: Ref,
    state: z.enum(["pending_client_trust", "enabled", "disabled", "revoked"]),
    collectionPolicy: ToolLearningCapturePolicySchema,
    collectionPolicyHash: Hash,
    coverage: ToolLearningCoverageSchema,
    credential: z
      .object({
        id: Id,
        expiresAt: Timestamp,
        revokedAt: Timestamp.nullable(),
        capabilities: z
          .array(
            z.enum(["episode_append", "manifest_read", "consultation_submit", "consultation_read"]),
          )
          .min(1)
          .max(4),
      })
      .strict()
      .nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();

export const ToolLearningInstallationUpdateSchema = z
  .object({
    operationId: Id,
    expectedRevision: z.number().int().positive(),
    state: z.enum(["enabled", "disabled", "revoked"]),
  })
  .strict();

export const ToolEpisodeOriginSchema = z
  .object({
    schemaVersion: z.literal("openpond.toolEpisodeOrigin.v1"),
    installationId: Id,
    projectId: Id,
    ownerUserId: Id,
    episode: Ref,
    event: Ref,
    appendReceipt: Ref,
    purpose: z.literal("private_dataset_evidence"),
    trainingConsent: z.literal("not_granted"),
  })
  .strict();

export type ToolLearningCapturePolicy = z.infer<typeof ToolLearningCapturePolicySchema>;
export type ToolLearningCoverage = z.infer<typeof ToolLearningCoverageSchema>;
export type ToolLearningRegistration = z.infer<typeof ToolLearningRegistrationSchema>;
export type ToolLearningInstallation = z.infer<typeof ToolLearningInstallationSchema>;
export type ToolEpisodeOrigin = z.infer<typeof ToolEpisodeOriginSchema>;
