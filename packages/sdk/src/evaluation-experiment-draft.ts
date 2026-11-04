import { z } from "zod";
import { TasksetCatalogReleaseRefSchema } from "./taskset-catalog.js";
import { ModelStarterAttemptPolicySchema } from "./model-starter-attempts.js";
import { ExperimentDefinitionSchema, ExperimentGraderSelectionSchema } from "./experiment-contracts.js";
export * from "./hosted-evaluation-experiment-draft.js";

/** Authoring state, not execution admission. Cleared numeric controls stay
 * null until the user supplies a value; saving never supplies a spend cap. */
export const EvaluationExperimentFormDraftSchema = z.object({
  mode: z.enum(["model", "model_harness", "model_harness_profile"]),
  localRuntime: ModelStarterAttemptPolicySchema.options[0].shape.localRuntime,
  sourceId: z.string().max(500), profileChoiceId: z.string().max(500),
  temperature: z.number().finite().nullable().optional(),
  topP: z.number().finite().nullable().optional(),
  name: z.string().max(500), release: TasksetCatalogReleaseRefSchema.nullable(),
  modelId: z.string().max(500), budget: z.number().finite().nullable(),
  outputTokens: z.number().finite().nullable(), prompt: z.string().max(100_000),
  targetId: z.string().max(500), seed: z.string().max(10_000),
  graderChoices: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.array(ExperimentGraderSelectionSchema).max(100)),
}).strict();
export const EvaluationExperimentSelectionSchema = z.object({
  release: TasksetCatalogReleaseRefSchema, mode: z.enum(["all", "subset"]),
  ids: z.array(z.string().min(1).max(500)).max(10_000),
}).strict();
export const EvaluationExperimentSourceSchema = ExperimentDefinitionSchema
  .pick({ id: true, request: true, graders: true, maximumCostUsd: true })
  .extend({ packageHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const EvaluationExperimentDraftSchema = z.object({
  form: EvaluationExperimentFormDraftSchema,
  selection: EvaluationExperimentSelectionSchema.nullable(),
  source: EvaluationExperimentSourceSchema.nullable(),
  executionLocation: z.enum(["local", "hosted"]),
}).strict();
export type EvaluationExperimentFormDraft = z.infer<typeof EvaluationExperimentFormDraftSchema>;
export type EvaluationExperimentSelection = z.infer<typeof EvaluationExperimentSelectionSchema>;
export type EvaluationExperimentSource = z.infer<typeof EvaluationExperimentSourceSchema>;
export type EvaluationExperimentDraft = z.infer<typeof EvaluationExperimentDraftSchema>;
