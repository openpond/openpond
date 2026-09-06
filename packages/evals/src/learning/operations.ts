import { z } from "zod";
import { ReleaseIdSchema } from "@openpond/harness";

import { LearningJsonObjectSchema, LearningRevisionRefSchema, LearningSourceContentSchema, TaskDefinitionContentSchema, TaskExampleSubmissionSchema, TaskFeedbackSubmissionSchema, LearningPolicyContentSchema } from "./contracts.js";
import { RewardBindingContentSchema, RewardReleaseContentSchema } from "../rewards.js";
import { AuthoringDraftInputSchema, AuthoringDraftFinalizationSchema } from "./authoring.js";
import { LearningTextAssetContentSchema } from "./assets.js";

const command = z.object({ operationId: ReleaseIdSchema });
const publish = command.extend({ action: z.literal("publish"), expectedRevision: z.number().int().nonnegative(), finalizeDraft: AuthoringDraftFinalizationSchema.optional() });
export const PublishLearningResourceCommandSchema = z.discriminatedUnion("kind", [
  publish.extend({ kind: z.literal("asset"), content: LearningTextAssetContentSchema }).strict(),
  publish.extend({ kind: z.literal("definition"), content: TaskDefinitionContentSchema }).strict(),
  publish.extend({ kind: z.literal("reward"), content: RewardReleaseContentSchema }).strict(),
  publish.extend({ kind: z.literal("binding"), content: RewardBindingContentSchema }).strict(),
  publish.extend({ kind: z.literal("source"), content: LearningSourceContentSchema }).strict(),
  publish.extend({ kind: z.literal("policy"), content: LearningPolicyContentSchema }).strict(),
]);
export const PublishLearningResourcesCommandSchema = command.extend({
  action: z.literal("publish_resources"),
  finalizeDraft: AuthoringDraftFinalizationSchema.optional(),
  resources: z.array(z.union(PublishLearningResourceCommandSchema.options.map((schema) => schema.omit({ operationId: true, action: true, finalizeDraft: true })))).min(1).max(20),
}).strict();
export const SubmitTaskExampleCommandSchema = command.extend({ action: z.literal("submit_example"), example: TaskExampleSubmissionSchema }).strict();
export const SubmitTaskFeedbackCommandSchema = command.extend({ action: z.literal("submit_feedback"), feedback: TaskFeedbackSubmissionSchema }).strict();
export const ApplyTaskCorrectionCommandSchema = command.extend({ action: z.literal("apply_correction"), feedbackId: ReleaseIdSchema, evidence: LearningRevisionRefSchema }).strict();
export const ResolveTaskFeedbackCommandSchema = command.extend({ action: z.literal("resolve_feedback"), feedbackId: ReleaseIdSchema, expectedRevision: z.number().int().positive(), disposition: z.enum(["applied", "rejected", "superseded"]), decision: LearningRevisionRefSchema.nullable(), note: z.string().max(20_000) }).strict();
export const QueueTaskGradeCommandSchema = command.extend({ action: z.literal("queue_grade"), evidence: LearningRevisionRefSchema, target: z.enum(["observed", "proposed_target"]), proposedTarget: LearningJsonObjectSchema.nullable(), timeoutMs: z.number().int().min(100).max(300_000).default(30_000), maximumSpendUsd: z.number().nonnegative().max(1_000).default(0) }).strict();
export const ReviewTaskEvidenceCommandSchema = command.extend({
  action: z.literal("review"), evidence: LearningRevisionRefSchema, expectedRevision: z.number().int().nonnegative(),
  disposition: z.enum(["approved", "rejected", "pending"]), targetApproval: z.enum(["approved", "rejected", "pending", "not_required"]),
  approvedTarget: LearningJsonObjectSchema.nullable(), observedGradeId: ReleaseIdSchema.nullable(), targetGradeId: ReleaseIdSchema.nullable(),
  note: z.string().max(20_000),
}).strict();
export const SealTaskBatchCommandSchema = command.extend({ action: z.literal("seal_batch"), batchId: ReleaseIdSchema, taskDefinition: LearningRevisionRefSchema, purpose: z.enum(["supervised_training", "reward_training", "evaluation"]), evidence: z.array(LearningRevisionRefSchema).min(1).max(10_000), decisions: z.array(LearningRevisionRefSchema).min(1).max(10_000) }).strict();
export const CancelTaskGradeCommandSchema = command.extend({ action: z.literal("cancel_grade"), gradeId: ReleaseIdSchema, expectedRevision: z.number().int().positive() }).strict();

export const SaveAuthoringDraftCommandSchema = command.extend({ action: z.literal("save_draft"), expectedRevision: z.number().int().nonnegative(), draft: AuthoringDraftInputSchema }).strict();
export const ArchiveAuthoringDraftCommandSchema = command.extend({ action: z.literal("archive_draft"), draft: LearningRevisionRefSchema }).strict();

export const LearningCommandSchema = z.union([SaveAuthoringDraftCommandSchema, ArchiveAuthoringDraftCommandSchema,PublishLearningResourceCommandSchema, PublishLearningResourcesCommandSchema, SubmitTaskExampleCommandSchema, SubmitTaskFeedbackCommandSchema, ApplyTaskCorrectionCommandSchema, ResolveTaskFeedbackCommandSchema, QueueTaskGradeCommandSchema, ReviewTaskEvidenceCommandSchema, SealTaskBatchCommandSchema, CancelTaskGradeCommandSchema]);
export type LearningCommand = z.infer<typeof LearningCommandSchema>;
export type PublishLearningResourceCommand = z.infer<typeof PublishLearningResourceCommandSchema>;
