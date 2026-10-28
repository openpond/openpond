import { z } from "zod";
import { ToolLearningActionSchema } from "./actions.js";
import {
  TOOL_LEARNING_LIMITS,
  ToolLearningAssetSchema,
  ToolLearningEnvironmentSchema,
  ToolLearningHashSchema as Hash,
  ToolLearningIdSchema as Id,
  ToolLearningRefSchema as Ref,
  ToolLearningSanitizationSchema,
  ToolLearningTimestampSchema as Timestamp,
  boundedToolLearningSchema,
  toolLearningContentHash,
  toolLearningText,
} from "./primitives.js";

export const ToolEpisodeAttemptSchema = z
  .object({
    intent: toolLearningText(2_000),
    tool: z
      .object({
        name: z.string().min(1).max(200),
        version: z.string().max(200).nullable(),
        server: z.string().max(200).nullable(),
      })
      .strict(),
    action: ToolLearningActionSchema,
    actionHash: Hash,
    environment: ToolLearningEnvironmentSchema,
    contextAssets: z.array(ToolLearningAssetSchema).max(TOOL_LEARNING_LIMITS.assetsPerEpisode),
    selection: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("eligible_attempt") }).strict(),
      z
        .object({
          kind: z.literal("unchanged_control"),
          numerator: z.number().int().positive(),
          denominator: z.number().int().positive(),
          policyHash: Hash,
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((attempt, context) => {
    if (toolLearningContentHash(attempt.action) !== attempt.actionHash)
      context.addIssue({
        code: "custom",
        path: ["actionHash"],
        message: "Action bytes differ from their hash.",
      });
    if (
      attempt.selection.kind === "unchanged_control" &&
      attempt.selection.numerator > attempt.selection.denominator
    )
      context.addIssue({
        code: "custom",
        path: ["selection"],
        message: "Sampling probability cannot exceed one.",
      });
  });

export const ToolEpisodeFailureKindSchema = z.enum([
  "validation_failure",
  "execution_failure",
  "process_failure",
  "timeout",
  "cancelled",
  "infrastructure_failure",
  "authorization_denied",
  "outcome_failure",
  "unknown_failure",
]);
const ObservationBase = {
  attempt: Ref,
  actionHash: Hash,
  execution: z.enum(["not_executed", "executed", "unknown"]),
  sideEffects: z.enum(["none", "possible", "observed", "unknown"]),
  resultExcerpt: toolLearningText(TOOL_LEARNING_LIMITS.resultBytes),
  resultHash: Hash.nullable(),
  assets: z.array(ToolLearningAssetSchema).max(TOOL_LEARNING_LIMITS.assetsPerEpisode),
};
export const ToolEpisodeObservationSchema = z
  .discriminatedUnion("outcome", [
    z
      .object({
        ...ObservationBase,
        outcome: z.literal("succeeded"),
        exitCode: z.literal(0).nullable(),
      })
      .strict(),
    z
      .object({
        ...ObservationBase,
        outcome: z.literal("failed"),
        classification: ToolEpisodeFailureKindSchema,
        errorCode: z.string().min(1).max(200),
        message: toolLearningText(2_000),
        exitCode: z.number().int().min(-255).max(255).nullable(),
      })
      .strict(),
    z
      .object({
        ...ObservationBase,
        outcome: z.literal("incomplete"),
        reason: z.enum([
          "completion_not_observed",
          "observer_restarted",
          "transport_interrupted",
          "coverage_gap",
        ]),
      })
      .strict(),
  ])
  .superRefine((observation, context) => {
    if (observation.execution === "not_executed" && observation.sideEffects !== "none")
      context.addIssue({
        code: "custom",
        path: ["sideEffects"],
        message: "An unexecuted action cannot claim tool effects.",
      });
    if (observation.outcome === "succeeded" && observation.execution !== "executed")
      context.addIssue({
        code: "custom",
        path: ["execution"],
        message: "Successful execution requires an observed execution.",
      });
    if (observation.outcome !== "failed") return;
    if (
      observation.classification === "validation_failure" &&
      observation.execution !== "not_executed"
    )
      context.addIssue({
        code: "custom",
        path: ["execution"],
        message: "Pre-execution validation failure must be unexecuted.",
      });
    if (
      observation.classification === "process_failure" &&
      (observation.execution !== "executed" ||
        observation.exitCode === null ||
        observation.exitCode === 0)
    )
      context.addIssue({
        code: "custom",
        path: ["exitCode"],
        message: "Process failure requires a nonzero observed exit.",
      });
  });

export const ToolEpisodeRecoveryLinkSchema = z
  .object({
    failedAttempt: Ref,
    failedObservation: Ref,
    replacementAttempt: Ref,
    goalId: Id,
    basis: z.enum(["explicit_relation", "artifact_lineage", "unverified"]),
    attributionEvidence: z.array(Ref).max(16),
  })
  .strict()
  .superRefine((link, context) => {
    if (link.failedAttempt.id === link.replacementAttempt.id)
      context.addIssue({
        code: "custom",
        message: "A recovery must reference a different attempt.",
      });
    if (link.basis !== "unverified" && link.attributionEvidence.length === 0)
      context.addIssue({
        code: "custom",
        path: ["attributionEvidence"],
        message: "Recovery attribution needs retained evidence.",
      });
  });

/** A producer supplies a claim/reference. Intake must resolve its authentic owner
 * receipt; possession of an append credential never grants verifier authority. */
export const ToolEpisodeVerificationSchema = z
  .object({
    attempt: Ref,
    actionHash: Hash,
    outcome: z.enum(["passed", "failed", "unknown"]),
    verifierRelease: Ref.nullable(),
    verifierReceipt: Ref.nullable(),
    environmentFingerprint: Hash,
    resetStateHash: Hash.nullable(),
    outputArtifacts: z.array(ToolLearningAssetSchema).max(TOOL_LEARNING_LIMITS.assetsPerEpisode),
    reason: toolLearningText(2_000),
  })
  .strict()
  .superRefine((verification, context) => {
    if (
      verification.outcome !== "unknown" &&
      (!verification.verifierRelease || !verification.verifierReceipt)
    )
      context.addIssue({
        code: "custom",
        message: "A verification outcome requires an exact verifier and execution receipt.",
      });
  });

const Event = z
  .object({
    schemaVersion: z.literal("openpond.toolEpisodeEvent.v1"),
    operationId: Id,
    installationId: Id,
    episodeId: Id,
    eventId: Id,
    sessionId: Id,
    parentSessionId: Id.nullable(),
    turnId: Id.nullable(),
    callId: Id,
    occurredAt: Timestamp,
    sequence: z.number().int().nonnegative(),
    adapterVersion: z.string().min(1).max(200),
    sanitization: ToolLearningSanitizationSchema,
    contentHash: Hash,
  })
  .strict();

export const ToolEpisodeEventSchema = boundedToolLearningSchema(
  z
    .discriminatedUnion("eventKind", [
      Event.extend({ eventKind: z.literal("attempt"), payload: ToolEpisodeAttemptSchema }).strict(),
      Event.extend({
        eventKind: z.literal("observation"),
        payload: ToolEpisodeObservationSchema,
      }).strict(),
      Event.extend({
        eventKind: z.literal("recovery_link"),
        payload: ToolEpisodeRecoveryLinkSchema,
      }).strict(),
      Event.extend({
        eventKind: z.literal("verification"),
        payload: ToolEpisodeVerificationSchema,
      }).strict(),
      Event.extend({
        eventKind: z.literal("lineage"),
        payload: z
          .object({
            relation: z.enum(["fork", "split", "reopen"]),
            parentEpisode: Ref,
            parentSessionId: Id,
            reason: toolLearningText(1_000),
          })
          .strict(),
      }).strict(),
    ])
    .superRefine((event, context) => {
      const { contentHash, ...body } = event;
      if (toolLearningContentHash(body) !== contentHash)
        context.addIssue({
          code: "custom",
          path: ["contentHash"],
          message: "Episode event content hash mismatch.",
        });
    }),
  TOOL_LEARNING_LIMITS.eventBytes,
);
export type ToolEpisodeEvent = z.infer<typeof ToolEpisodeEventSchema>;

export function sealToolEpisodeEvent(value: unknown): ToolEpisodeEvent {
  const hash = toolLearningContentHash(value);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.hasOwn(value, "contentHash")
  )
    throw new Error("tool_episode_unsigned_envelope_required");
  return ToolEpisodeEventSchema.parse({ ...value, contentHash: hash });
}

export const ToolEpisodeAppendSchema = boundedToolLearningSchema(
  z
    .object({
      schemaVersion: z.literal("openpond.toolEpisodeAppend.v1"),
      operationId: Id,
      installationId: Id,
      events: z.array(ToolEpisodeEventSchema).min(1).max(TOOL_LEARNING_LIMITS.eventsPerAppend),
    })
    .strict()
    .superRefine((append, context) => {
      if (append.events.some((event) => event.installationId !== append.installationId))
        context.addIssue({
          code: "custom",
          path: ["events"],
          message: "Append events must belong to the exact installation.",
        });
      if (new Set(append.events.map((event) => event.eventId)).size !== append.events.length)
        context.addIssue({
          code: "custom",
          path: ["events"],
          message: "Append event IDs must be unique.",
        });
    }),
  TOOL_LEARNING_LIMITS.eventBytes * TOOL_LEARNING_LIMITS.eventsPerAppend,
);

export const ToolEpisodeAppendReceiptSchema = z
  .object({
    schemaVersion: z.literal("openpond.toolEpisodeAppendReceipt.v1"),
    operationId: Id,
    requestHash: Hash,
    installationId: Id,
    teamId: Id,
    projectId: Id,
    receivedAt: Timestamp,
    events: z
      .array(
        z
          .object({
            eventId: Id,
            contentHash: Hash,
            state: z.enum(["retained", "already_retained", "privacy_rejected"]),
            receiptId: Id,
            reason: z.string().max(200).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(TOOL_LEARNING_LIMITS.eventsPerAppend),
    learningEnrollment: z.literal(false),
  })
  .strict();
export type ToolEpisodeAppend = z.infer<typeof ToolEpisodeAppendSchema>;
export type ToolEpisodeAppendReceipt = z.infer<typeof ToolEpisodeAppendReceiptSchema>;
