import { z } from "zod";
import { LearningJsonObjectSchema, LearningRevisionRefSchema, LearningSourceSchema, TaskEvidenceSchema, TaskFeedbackSchema } from "@openpond/evals/learning";
import { ReleaseIdSchema } from "@openpond/harness";

export const ModelBatchReviewRequestSchema = z.object({
  schemaVersion: z.literal("openpond.modelBatchReviewRequest.v1"),
  operationId: ReleaseIdSchema,
  modelId: ReleaseIdSchema,
  expectedModelRevision: z.number().int().positive(),
  tasksetRef: LearningRevisionRefSchema,
  rewardBindingRef: LearningRevisionRefSchema.nullable(),
  definition: z.object({
    name: z.string().trim().min(1).max(500).optional(),
    instructions: z.string().trim().min(1).max(20_000).optional(),
    inputSchema: LearningJsonObjectSchema.optional(),
    outputSchema: LearningJsonObjectSchema.optional(),
  }).strict(),
  examples: z.array(z.object({
    evidence: LearningRevisionRefSchema,
    input: LearningJsonObjectSchema.optional(),
    expected: LearningJsonObjectSchema.nullable().optional(),
    evaluatorContext: LearningJsonObjectSchema.nullable().optional(),
    proposedTarget: LearningJsonObjectSchema.nullable().optional(),
  }).strict()).max(10_000),
}).strict();
export type ModelBatchReviewRequest = z.infer<typeof ModelBatchReviewRequestSchema>;

/** These are editable evidence and unapproved proposals, never admissions. */
export const ModelBatchReviewReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.modelBatchReviewReceipt.v1"),
  operationId: ReleaseIdSchema,
  modelId: ReleaseIdSchema,
  source: LearningSourceSchema,
  evidence: z.array(TaskEvidenceSchema).min(1).max(10_000),
  proposals: z.array(TaskFeedbackSchema).max(10_000),
}).strict();
export type ModelBatchReviewReceipt = z.infer<typeof ModelBatchReviewReceiptSchema>;
