import { SavedSteeringExperimentSourceSchema } from "./steering-experiment-source.js";
import { z } from "zod";
import { ModelProjectBaseModelSchema } from "./model-projects.js";
import { NeuronSteeringNormalizationSchema, NeuronSteeringTokenScopeSchema } from "./neuron-steering.js";

/** Editable authoring, never an execution request. Strings preserve incomplete
 * numeric fields; runtime preparation must resolve the exact tensor identity,
 * tokenize prompts and enforce the complete execution/capture budget. */
export const ActivationExperimentFormDraftSchema = z.object({
  baseModel: ModelProjectBaseModelSchema.nullable(),
  startingProfile: SavedSteeringExperimentSourceSchema.optional(),
  prompts: z.array(z.object({ id: z.string().trim().min(1).max(240), text: z.string().max(16_000) }).strict()).max(8),
  coordinates: z.array(z.object({ id: z.string().trim().min(1).max(240),
    layer: z.string().max(100), neuron: z.string().max(100), dose: z.string().max(100),
  }).strict()).max(64),
  doseMultipliers: z.string().max(1000),
  normalization: NeuronSteeringNormalizationSchema,
  tokenScope: NeuronSteeringTokenScopeSchema,
  maxNewTokens: z.string().max(100),
  maximumCapturedValues: z.string().max(100),
  maximumForwardTokenWork: z.string().max(100),
  maximumDurationSeconds: z.string().max(100),
  maximumSpendUsd: z.string().max(100).optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.prompts.map(row => row.id)).size !== value.prompts.length ||
      new Set(value.coordinates.map(row => row.id)).size !== value.coordinates.length)
    ctx.addIssue({ code: "custom", message: "Authoring row identities must be unique." });
});
export type ActivationExperimentFormDraft = z.infer<typeof ActivationExperimentFormDraftSchema>;
