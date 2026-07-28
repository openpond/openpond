import {
  TrainingTacticRecommendationSchema,
  type TaskCandidateEvidence,
  type TaskCandidateScorecard,
  type TrainingTacticRecommendation,
} from "@openpond/contracts";

export function recommendTrainingTactic(input: {
  evidence: TaskCandidateEvidence[];
  scorecard: TaskCandidateScorecard;
  changingFacts?: boolean;
}): TrainingTacticRecommendation {
  const kinds = new Set(input.evidence.map((item) => item.kind));
  if (input.changingFacts) return recommendation("retrieval", true, ["The primary signal is changing factual context; keep it in retrieval rather than weights."], [], ["versioned documents"], "decision_table");
  if (input.scorecard.privacyRisk >= 0.8) return recommendation("no_training", false, ["Privacy risk exceeds the local training threshold."], ["Resolve consent and privacy findings."], [], "decision_table");
  if (input.scorecard.repeatability < 0.35 || input.evidence.length < 2) return recommendation("no_training", false, ["The workflow is not yet repeated enough to justify training."], ["Collect more independent successful executions."], [], "decision_table");
  if (kinds.has("runtime_feedback") && input.scorecard.verifiability >= 0.5) return recommendation("sdpo", true, ["Runtime or reviewer feedback is attached to policy attempts."], [], ["versioned attempt feedback"], "decision_table");
  if (kinds.has("accepted_correction")) return recommendation("preference", true, ["The evidence contains accepted corrections or chosen/rejected behavior."], [], ["approved correction or preference pair"], "decision_table");
  if (kinds.has("expert_label") && input.scorecard.verifiability >= 0.75) return recommendation("grpo_rft", true, ["Expert labels can define an exact executable reward."], [], ["stable label function", "executable environment"], "decision_table");
  return recommendation("sft", true, ["The selected successful outputs can serve as approved demonstrations."], [], ["approved demonstrations"], "decision_table");
}

function recommendation(
  tactic: TrainingTacticRecommendation["tactic"],
  eligible: boolean,
  reasons: string[],
  blockers: string[],
  requiredSignals: string[],
  generatedBy: TrainingTacticRecommendation["generatedBy"],
): TrainingTacticRecommendation {
  return TrainingTacticRecommendationSchema.parse({ tactic, eligible, reasons, blockers, requiredSignals, generatedBy });
}
