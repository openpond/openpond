import {
  type GradeComponent,
  type GradeResult,
} from "@openpond/contracts";
import { contentHash, gradeAttempt } from "@openpond/taskset-sdk";

const CROSS_SYSTEM_OUTCOMES = new Set([
  "correct",
  "incorrect",
  "parse_failure",
  "budget_exhausted",
  "tool_schema_violation",
  "infrastructure_failure",
  "cancelled",
] as const);

type CrossSystemOutcome =
  | "correct"
  | "incorrect"
  | "parse_failure"
  | "budget_exhausted"
  | "tool_schema_violation"
  | "infrastructure_failure"
  | "cancelled";

type CrossSystemEvaluationGrade = {
  outcome: CrossSystemOutcome;
  reward: number | null;
  rewardEligible: boolean;
};

export async function gradeTasksetEvaluationAttempt(
  input: Parameters<typeof gradeAttempt>[0],
): Promise<GradeResult> {
  const verified = crossSystemGrade(input.attempt.metadata);
  if (!verified) return gradeAttempt(input);

  const graderSetHash = contentHash(input.graders);
  const score = verified.rewardEligible
    ? verified.outcome === "correct"
      ? 1
      : 0
    : null;
  const passed = verified.outcome === "correct";
  const failureClass = failureClassFor(verified.outcome);
  const feedback =
    `Cross-System trajectory verifier outcome: ${verified.outcome}.`;
  const components: GradeComponent[] = input.graders.map((grader) => ({
    graderId: grader.id,
    graderVersion: grader.version,
    score: score ?? 0,
    passed,
    hardGate: grader.hardGate,
    rewardEligible: verified.rewardEligible && grader.rewardEligible,
    feedback,
    evidenceRefs: input.attempt.artifactRefs,
    judge: grader.kind === "model_judge" ? grader.judge : null,
    calibrationStatus:
      grader.kind === "model_judge"
        ? grader.calibrationStatus
        : "not_applicable",
  }));
  return {
    schemaVersion: "openpond.gradeResult.v1",
    id: `grade_${contentHash([
      input.attempt.id,
      graderSetHash,
      verified,
    ]).slice(0, 24)}`,
    attemptId: input.attempt.id,
    graderSetHash,
    score,
    passed,
    components,
    failureClass,
    feedback: [feedback],
    rewardEligible: verified.rewardEligible,
    createdAt: input.now?.() ?? new Date().toISOString(),
  };
}

function crossSystemGrade(
  metadata: Record<string, unknown>,
): CrossSystemEvaluationGrade | null {
  if (metadata.execution !== "post_training_evaluation_tool_loop") return null;
  const outcome = metadata.verifierOutcome;
  const reward = metadata.verifierReward;
  const rewardEligible = metadata.verifierRewardEligible;
  if (
    typeof outcome !== "string"
    || !CROSS_SYSTEM_OUTCOMES.has(outcome as CrossSystemOutcome)
    || typeof rewardEligible !== "boolean"
    || (reward !== null && typeof reward !== "number")
  ) {
    throw new Error(
      "Cross-System evaluation attempt is missing trusted verifier metadata.",
    );
  }
  const eligibleOutcome =
    outcome === "correct"
    || outcome === "incorrect"
    || outcome === "parse_failure";
  if (
    rewardEligible !== eligibleOutcome
    || (rewardEligible && typeof reward !== "number")
    || (!rewardEligible && reward !== null)
  ) {
    throw new Error(
      "Cross-System evaluation verifier metadata is internally inconsistent.",
    );
  }
  return {
    outcome: outcome as CrossSystemOutcome,
    reward,
    rewardEligible,
  };
}

function failureClassFor(
  outcome: CrossSystemOutcome,
): GradeResult["failureClass"] {
  if (outcome === "correct") return null;
  if (outcome === "infrastructure_failure") {
    return "infrastructure_failure";
  }
  if (outcome === "cancelled") return "cancelled";
  return "policy_failure";
}
