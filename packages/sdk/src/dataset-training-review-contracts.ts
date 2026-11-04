import { z } from "zod";
import { LearningRevisionRefSchema } from "@openpond/evals/learning";
import { ModelBatchReviewRequestSchema } from "./model-batch-review-contracts.js";

const Id = LearningRevisionRefSchema.shape.id;
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const DatasetTrainingReviewRequestSchema = z.object({
  schemaVersion: z.literal("openpond.datasetTrainingReviewRequest.v1"),
  teamId: Id,
  operationId: Id,
  dataset: LearningRevisionRefSchema,
  packageHash: Hash,
  taskIds: z.array(Id).min(1).max(10_000).nullable().default(null),
  purpose: z.enum(["supervised_training", "reward_training"]),
  rewardBindingRef: LearningRevisionRefSchema.nullable().default(null),
  definition: ModelBatchReviewRequestSchema.shape.definition.default({}),
  targetSource: z.enum(["none", "expected_output", "approved_parent"]).default("none"),
  /** Learning examples use workspace scope. Import is an explicit copy, not a
   * silent widening of the source Dataset's visibility. */
  shareWithWorkspace: z.literal(true),
}).strict().superRefine((value, context) => {
  if (value.taskIds && new Set(value.taskIds).size !== value.taskIds.length)
    context.addIssue({ code: "custom", path: ["taskIds"], message: "Select each Dataset task once." });
  if (value.purpose !== "supervised_training" && value.targetSource !== "none")
    context.addIssue({ code: "custom", path: ["targetSource"], message: "Target proposals require a supervised review." });
});
export type DatasetTrainingReviewRequest = z.input<typeof DatasetTrainingReviewRequestSchema>;

/** Policy/task-format metadata only; original example answers, private context,
 * grader code and package files are deliberately absent from this projection. */
export const DatasetTrainingReviewSourceSchema = z.object({
  schemaVersion: z.literal("openpond.datasetTrainingReviewSource.v1"),
  dataset: LearningRevisionRefSchema,
  packageHash: Hash,
  taskCount: z.number().int().nonnegative(),
  definition: ModelBatchReviewRequestSchema.shape.definition,
  rewardBinding: LearningRevisionRefSchema.nullable(),
  hasParentTargets: z.boolean(),
}).strict();
export type DatasetTrainingReviewSource = z.infer<typeof DatasetTrainingReviewSourceSchema>;

/** Metadata only; read the newly created evidence through the learning owner.
 * The host retains the exact package before returning this committed receipt. */
export const DatasetTrainingReviewReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.datasetTrainingReviewReceipt.v1"),
  id: Id, teamId: Id, actorId: Id, operationId: Id, requestHash: Hash,
  dataset: LearningRevisionRefSchema, packageHash: Hash,
  purpose: z.enum(["supervised_training", "reward_training"]),
  shareWithWorkspace: z.literal(true),
  source: LearningRevisionRefSchema, definition: LearningRevisionRefSchema,
  evidence: z.array(LearningRevisionRefSchema).min(1).max(10_000),
  // Feedback is a revisioned review record, not a content-addressed release.
  proposals: z.array(LearningRevisionRefSchema.pick({ id: true, revision: true })).max(10_000),
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export const DatasetTrainingReviewReceiptSchema = DatasetTrainingReviewReceiptContentSchema.extend({ contentHash: Hash }).strict();
export type DatasetTrainingReviewReceipt = z.infer<typeof DatasetTrainingReviewReceiptSchema>;
