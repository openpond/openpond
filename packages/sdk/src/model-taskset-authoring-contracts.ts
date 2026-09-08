import { z } from "zod";
import { LearningRevisionRefSchema } from "@openpond/evals/learning";

const IdSchema = LearningRevisionRefSchema.shape.id;
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ModelTasksetAuthoringOwnerSchema = z.object({ scopeId: IdSchema, modelId: IdSchema }).strict();

/** Ordinary authoring preserves its own lineage without inventing a Reward
 * binding or replacing an admitted learning graph. Hosts authorize the owner. */
export const ModelTasksetAuthoringSchema = z.object({
  schemaVersion: z.literal("openpond.modelTasksetAuthoring.v1"),
  owner: ModelTasksetAuthoringOwnerSchema,
  root: LearningRevisionRefSchema,
  parent: LearningRevisionRefSchema,
}).strict();

export const ModelTasksetDraftRequestSchema = z.object({
  schemaVersion: z.literal("openpond.modelTasksetDraftRequest.v1"),
  operationId: IdSchema,
  modelId: IdSchema,
  expectedModelRevision: z.number().int().positive(),
  sourcePackageHash: HashSchema,
}).strict();
export type ModelTasksetDraftRequest = z.infer<typeof ModelTasksetDraftRequestSchema>;

/** Persist this preparation before materializing the editable workspace. */
export const ModelTasksetDraftPreparationSchema = z.object({
  schemaVersion: z.literal("openpond.modelTasksetDraftPreparation.v1"),
  draftId: IdSchema,
  requestHash: HashSchema,
  sourcePackageHash: HashSchema,
  sourceTasksetRef: LearningRevisionRefSchema,
  tasksetId: IdSchema,
  tasksetRevision: z.number().int().positive(),
  lineage: ModelTasksetAuthoringSchema,
}).strict();
export type ModelTasksetDraftPreparation = z.infer<typeof ModelTasksetDraftPreparationSchema>;
