import {
  TrainingTacticRecommendationSchema,
  type BaselineReport,
  type TaskCandidateEvidence,
  type TaskCandidateScorecard,
  type TrainingTacticRecommendation,
} from "@openpond/contracts";

export function recommendTrainingTactic(input: {
  evidence: TaskCandidateEvidence[];
  scorecard: TaskCandidateScorecard;
  changingFacts?: boolean;
  baseline?: BaselineReport | null;
}): TrainingTacticRecommendation {
  const kinds = new Set(input.evidence.map((item) => item.kind));
  const baseline = input.baseline ?? null;
  if (input.changingFacts) return recommendation("retrieval", true, ["The primary signal is changing factual context; keep it in retrieval rather than weights."], [], ["versioned documents"], baseline ? "baseline_reassessment" : "decision_table");
  if (input.scorecard.privacyRisk >= 0.8) return recommendation("no_training", false, ["Privacy risk exceeds the local training threshold."], ["Resolve consent and privacy findings."], [], baseline ? "baseline_reassessment" : "decision_table");
  if (input.scorecard.repeatability < 0.35 || input.evidence.length < 2) return recommendation("no_training", false, ["The workflow is not yet repeated enough to justify training."], ["Collect more independent successful executions."], [], baseline ? "baseline_reassessment" : "decision_table");
  if (baseline && baseline.reward.count > 0 && (baseline.reward.variance ?? 0) > 0 && (baseline.reward.mean ?? 0) > 0.05 && (baseline.reward.mean ?? 0) < 0.95 && input.scorecard.verifiability >= 0.7) {
    return recommendation("grpo_rft", true, ["The frozen grader has non-trivial reward variance and the base policy reaches reward-bearing states."], [], ["frozen scalar reward", "executable environment"], "baseline_reassessment");
  }
  if (kinds.has("runtime_feedback") && input.scorecard.verifiability >= 0.5) return recommendation("sdpo", true, ["Runtime or reviewer feedback is attached to policy attempts."], [], ["versioned attempt feedback"], baseline ? "baseline_reassessment" : "decision_table");
  if (kinds.has("accepted_correction")) return recommendation("preference", true, ["The evidence contains accepted corrections or chosen/rejected behavior."], [], ["approved correction or preference pair"], baseline ? "baseline_reassessment" : "decision_table");
  if (kinds.has("expert_label") && input.scorecard.verifiability >= 0.75) return recommendation("grpo_rft", Boolean(baseline), [baseline ? "Expert labels and baseline variation support an exact reward." : "Expert labels may become exact rewards after baseline validation."], baseline ? [] : ["Run baselines before online RL."], ["stable label function"], baseline ? "baseline_reassessment" : "decision_table");
  return recommendation("sft", true, ["The selected successful outputs can serve as approved demonstrations."], [], ["approved demonstrations"], baseline ? "baseline_reassessment" : "decision_table");
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
