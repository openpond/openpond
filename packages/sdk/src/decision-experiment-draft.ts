import { z } from "zod";
import { ModelProjectBaseModelSchema, ModelProjectVersionedRefSchema } from "./model-projects.js";
import { DecisionArtifactReferenceSchema } from "./decision-model-data.js";
import {
  DECISION_CHAT_TEMPLATE_SHA256, DECISION_SOURCE_REPOSITORY, DECISION_SOURCE_REVISION,
} from "./decision-model.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Field = z.string().max(100);
export const SavedDecisionExperimentSourceSchema = z.object({
  modelProjectId: z.string().min(1).max(240), versionHash: Hash,
  artifact: DecisionArtifactReferenceSchema, modelHash: Hash,
}).strict();
export type SavedDecisionExperimentSource = z.infer<typeof SavedDecisionExperimentSourceSchema>;
export const DecisionTrainingFormDraftSchema = z.object({
  learningRate: Field, weightDecay: Field, maxSteps: Field, gradientAccumulationSteps: Field,
  maximumPromptTokens: Field, seed: Field, maxDurationSeconds: Field, maxCheckpointBytes: Field,
}).strict();
export const DecisionScoringLimitsFormDraftSchema = z.object({
  maximumPromptTokens: Field, maximumForwardTokenWork: Field, maximumDurationSeconds: Field,
}).strict();
export const DecisionQuestionFormDraftSchema = z.object({
  id: z.string().max(80), type: z.enum(["choice", "boolean", "integer_levels"]),
  description: z.string().max(2000),
  choices: z.array(z.object({ value: z.string().max(256), description: z.string().max(2000) }).strict()).max(26),
}).strict();
const common = {
  baseModel: ModelProjectBaseModelSchema.nullable(),
  name: z.string().max(500), maximumSpendUsd: Field,
  parentArtifact: DecisionArtifactReferenceSchema.nullable(),
  startingDecision: SavedDecisionExperimentSourceSchema.optional(),
};

/** Incomplete authoring is retained verbatim, including unfinished JSON and
 * numeric fields. A train draft references an owned reviewed batch; a score
 * draft contains unlabeled input only and grants no Dataset/training authority. */
export const DecisionExperimentFormDraftSchema = z.discriminatedUnion("mode", [
  z.object({ ...common, mode: z.literal("train"), batch: ModelProjectVersionedRefSchema.nullable(),
    training: DecisionTrainingFormDraftSchema }).strict(),
  z.object({ ...common, mode: z.literal("score"), stateJson: z.string().max(131_072),
    questions: z.array(DecisionQuestionFormDraftSchema).max(8), limits: DecisionScoringLimitsFormDraftSchema }).strict(),
]);
export type DecisionExperimentFormDraft = z.infer<typeof DecisionExperimentFormDraftSchema>;

/** Selects the actual adapter release and its own tokenizer. The hosted
 * compiler resolves the complete verified source manifest and runtime. */
export function decisionSourcePreference() {
  return ModelProjectBaseModelSchema.parse({
    schemaVersion: "openpond.baseModelPreference.v1", modelId: DECISION_SOURCE_REPOSITORY,
    revision: DECISION_SOURCE_REVISION, tokenizerRevision: DECISION_SOURCE_REVISION,
    chatTemplateHash: DECISION_CHAT_TEMPLATE_SHA256, modelAssetId: null, source: "managed",
  });
}
