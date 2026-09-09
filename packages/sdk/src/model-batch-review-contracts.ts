import { z } from "zod";
import { LearningJsonObjectSchema, LearningRevisionRefSchema, LearningSourceSchema, TaskEvidenceSchema, TaskFeedbackSchema, TaskDefinitionSchema, TaskAdmissionDecisionSchema } from "@openpond/evals/learning";
import { RewardBindingSchema } from "@openpond/evals/rewards";
// Reuse the canonical release ID already exposed by Evals without bundling a
// second copy of Harness's schema graph into the browser contract entrypoint.
const ReleaseIdSchema = LearningRevisionRefSchema.shape.id;

/** Editor data from a server-validated package; excludes portable file bytes. */
export const ModelBatchReviewInspectionSchema = z.object({
  schemaVersion: z.literal("openpond.modelBatchReviewInspection.v1"),
  packageHash: z.string().regex(/^[a-f0-9]{64}$/),
  definition: TaskDefinitionSchema,
  binding: RewardBindingSchema,
  evidence: z.array(TaskEvidenceSchema).min(1).max(10_000),
  decisions: z.array(TaskAdmissionDecisionSchema).min(1).max(10_000),
}).strict();
export type ModelBatchReviewInspection = z.infer<typeof ModelBatchReviewInspectionSchema>;

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
    requiredOutputs: TaskDefinitionSchema.shape.requiredOutputs,
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
