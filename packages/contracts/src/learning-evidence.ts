import {
  WorkEvidenceAuthoringInputSchema,
  WorkEvidenceUseSchema,
} from "@openpond/evals/evidence";
import { z } from "zod";

import {
  ContinuousLearningScopeSchema,
  ReviewConversationSchema,
  ReviewConversationSourceReferenceSchema,
  ReviewConversationsEmptyReasonSchema,
} from "./continuous-learning.js";

export const GET_LEARNING_EVIDENCE_CONTRACT_VERSION =
  "openpond.learningEvidenceView.v1" as const;
export const MAX_REVIEW_WORK_EVIDENCE = 12;

/**
 * Owner, workspace, consent, schedule, watermark, and lane budgets are bound by
 * the runtime. The model cannot choose or widen the evidence scope. This is
 * the versioned v2 result returned by the existing get_conversations tool.
 */
export const GetLearningEvidenceToolInputSchema = z.object({}).strict();

export const LearningEvidenceLaneCountsSchema = z
  .object({
    considered: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    selected: z.number().int().nonnegative(),
    revoked: z.number().int().nonnegative(),
  })
  .strict();

export const WorkEvidenceRecommendationWeightSchema = z.enum([
  "verified_work",
  "successful_work",
  "discovery_only",
]);

export const WorkEvidenceFeedbackSignalSchema = z.enum([
  "none",
  "accepted",
  "needs_correction",
  "rejected",
  "mixed",
]);

export const LearningWorkEvidenceSchema = z
  .object({
    sourceReference: ReviewConversationSourceReferenceSchema,
    authoringInput: WorkEvidenceAuthoringInputSchema,
    eligibleUses: z.array(WorkEvidenceUseSchema).max(5),
    recommendationWeight: WorkEvidenceRecommendationWeightSchema,
    terminalStatus: z.enum(["completed", "failed", "cancelled", "timeout"]),
    failureClass: z.string().trim().min(1).max(120).nullable(),
    outputCount: z.number().int().nonnegative(),
    validationEvidenceCount: z.number().int().nonnegative(),
    feedbackSignal: WorkEvidenceFeedbackSignalSchema,
    rewardCandidate: z.literal(false),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (
      evidence.recommendationWeight === "verified_work" &&
      (!evidence.authoringInput.evalCandidate ||
        evidence.terminalStatus !== "completed" ||
        evidence.validationEvidenceCount === 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "verified Work requires completed, validation-backed eval evidence",
        path: ["recommendationWeight"],
      });
    }
    if (
      evidence.terminalStatus !== "completed" &&
      evidence.recommendationWeight !== "discovery_only"
    ) {
      context.addIssue({
        code: "custom",
        message: "non-completed Work is discovery-only",
        path: ["recommendationWeight"],
      });
    }
    if (evidence.eligibleUses.includes("reward_candidate")) {
      context.addIssue({
        code: "custom",
        message: "continuous-learning evidence never exposes reward candidates",
        path: ["eligibleUses"],
      });
    }
  });

export const LearningChatEvidenceSchema = z
  .object({
    purpose: z.literal("recurrence_context"),
    conversation: ReviewConversationSchema,
  })
  .strict();

export const GetLearningEvidenceToolResultSchema = z
  .object({
    schemaVersion: z.literal(GET_LEARNING_EVIDENCE_CONTRACT_VERSION),
    scope: ContinuousLearningScopeSchema,
    inputWatermark: z.string().trim().min(1).max(1_000).nullable(),
    proposedWatermark: z.string().trim().min(1).max(1_000),
    lanes: z
      .object({
        work: z
          .object({
            counts: LearningEvidenceLaneCountsSchema,
            evidence: z
              .array(LearningWorkEvidenceSchema)
              .max(MAX_REVIEW_WORK_EVIDENCE),
          })
          .strict(),
        chat: z
          .object({
            counts: LearningEvidenceLaneCountsSchema,
            evidence: z.array(LearningChatEvidenceSchema).max(12),
          })
          .strict(),
      })
      .strict(),
    emptyReason: ReviewConversationsEmptyReasonSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const selected =
      result.lanes.work.evidence.length + result.lanes.chat.evidence.length;
    if (result.lanes.work.counts.selected !== result.lanes.work.evidence.length) {
      context.addIssue({
        code: "custom",
        message: "Work selected count must match returned evidence",
        path: ["lanes", "work", "counts", "selected"],
      });
    }
    if (result.lanes.chat.counts.selected !== result.lanes.chat.evidence.length) {
      context.addIssue({
        code: "custom",
        message: "chat selected count must match returned evidence",
        path: ["lanes", "chat", "counts", "selected"],
      });
    }
    if ((selected === 0) === (result.emptyReason === null)) {
      context.addIssue({
        code: "custom",
        message:
          "emptyReason is required exactly when neither evidence lane returns evidence",
        path: ["emptyReason"],
      });
    }
    const references = [
      ...result.lanes.work.evidence.map(
        (item) => item.sourceReference.referenceId,
      ),
      ...result.lanes.chat.evidence.map(
        (item) => item.conversation.sourceReference.referenceId,
      ),
    ];
    if (new Set(references).size !== references.length) {
      context.addIssue({
        code: "custom",
        message: "learning evidence source references must be unique",
        path: ["lanes"],
      });
    }
  });

export type LearningEvidenceLaneCounts = z.infer<
  typeof LearningEvidenceLaneCountsSchema
>;
export type LearningWorkEvidence = z.infer<typeof LearningWorkEvidenceSchema>;
export type LearningChatEvidence = z.infer<typeof LearningChatEvidenceSchema>;
export type GetLearningEvidenceToolResult = z.infer<
  typeof GetLearningEvidenceToolResultSchema
>;
