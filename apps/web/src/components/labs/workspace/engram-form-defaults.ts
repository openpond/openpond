import {
  ENGRAM_TRAINING_DEFAULTS,
  EngramExperimentFormDraftSchema,
  type EngramExperimentFormDraft,
} from "openpond-sdk/training";

/** Defaults apply only to a new form. Retained authoring is parsed without
 * filling blank fields or replacing its exact source and parent references. */
export function initialEngramForm(): EngramExperimentFormDraft {
  const defaults = ENGRAM_TRAINING_DEFAULTS;
  return EngramExperimentFormDraftSchema.parse({
    baseModel: null,
    batch: null,
    name: "",
    maximumSpendUsd: "",
    training: {
      learningRate: String(defaults.learningRate),
      weightDecay: String(defaults.weightDecay),
      maxSteps: String(defaults.maxSteps),
      gradientAccumulationSteps: String(defaults.gradientAccumulationSteps),
      maxSequenceLength: String(defaults.maxSequenceLength),
      seed: String(defaults.seed),
      maxDurationSeconds: String(defaults.maxDurationSeconds),
      maxCheckpointBytes: String(defaults.maxCheckpointBytes),
    },
    parentArtifact: null,
  });
}
