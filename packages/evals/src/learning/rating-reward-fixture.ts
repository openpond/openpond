import { learningRef, sameLearningRef, TaskRatingSchema, type TaskEvidence, type TaskFeedback } from "./contracts.js";
import { type RewardFixtureAuthoringFields } from "./authoring.js";
import { LearningDomainError } from "./errors.js";

/** Copy a retained label into editable check data while preserving its exact origin. */
export function rewardFixtureFromRating(evidence: TaskEvidence, feedback: TaskFeedback, scale: { minimum: number; maximum: number } = { minimum: 0, maximum: 1 }): RewardFixtureAuthoringFields {
  if (!feedback.evidence || !sameLearningRef(feedback.evidence, learningRef(evidence)) || feedback.submission.expectedEvidenceHash !== evidence.contentHash || feedback.submission.kind !== "outcome" || !evidence.submission.observedOutput) throw new LearningDomainError("rating_fixture_evidence_mismatch", 422);
  const rating = TaskRatingSchema.parse(feedback.submission.value);
  if (!Number.isFinite(scale.minimum) || !Number.isFinite(scale.maximum) || scale.minimum >= scale.maximum) throw new LearningDomainError("rating_fixture_scale_invalid", 422);
  const score = scale.minimum + (rating.score - rating.scale.minimum) / (rating.scale.maximum - rating.scale.minimum) * (scale.maximum - scale.minimum);
  return {
    id: `label-${feedback.id}-${feedback.revision}`, name: evidence.submission.exampleId,
    input: JSON.stringify(evidence.submission.input, null, 2), output: JSON.stringify(evidence.submission.observedOutput, null, 2),
    expectedOutput: evidence.submission.expected ? JSON.stringify(evidence.submission.expected, null, 2) : "",
    evaluatorContext: evidence.submission.evaluatorContext ? JSON.stringify(evidence.submission.evaluatorContext, null, 2) : "",
    artifactRefs: [], runtimeEventRefs: [], infrastructureError: "", expectedStatus: "scored", minimumScore: String(score), maximumScore: String(score), expectedPassed: "any",
    sourceLabel: { evidence: learningRef(evidence), feedback: { id: feedback.id, revision: feedback.revision } },
  };
}
