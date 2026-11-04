import {decisionSourcePreference, type DecisionExperimentFormDraft, DecisionQuestionFormDraftSchema} from "openpond-sdk/training";
import type { z } from "zod";
type DecisionQuestionFormDraft = z.infer<typeof DecisionQuestionFormDraftSchema>;

export function initialDecisionForm(mode: "train" | "score" = "train"): DecisionExperimentFormDraft {
  const common = {baseModel: decisionSourcePreference(), name: "Decision experiment", maximumSpendUsd: "", parentArtifact: null};
  return mode === "train" ? {...common, mode, batch: null, training: {
    learningRate: "0.0001", weightDecay: "0", maxSteps: "16", gradientAccumulationSteps: "1",
    maximumPromptTokens: "2048", seed: "0", maxDurationSeconds: "3600", maxCheckpointBytes: "268435456",
  }} : {...common, mode, stateJson: "{}", questions: [newDecisionQuestion()], limits: {
    maximumPromptTokens: "2048", maximumForwardTokenWork: "16384", maximumDurationSeconds: "120",
  }};
}
function newDecisionQuestion(): DecisionQuestionFormDraft {
  return {id: "", type: "choice", description: "", choices: [{value: "", description: ""}, {value: "", description: ""}]};
}
