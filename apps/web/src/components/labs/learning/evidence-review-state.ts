import { learningRef, sameLearningRef, TaskRatingSchema, type TaskAdmissionDecision, type TaskEvidence, type TaskFeedback } from "openpond-sdk/learning";

import { emptyTaskRating } from "./TaskRatingFields";

/** Restore only feedback for this exact attempt revision, never a source outcome or an older corrected task. */
export function evidenceReviewState(evidence: TaskEvidence, decisions: TaskAdmissionDecision[], feedback: TaskFeedback[]) {
  const decision = decisions.find(entry => sameLearningRef(entry.evidence, learningRef(evidence)) && entry.actor.kind === "human") ?? null;
  const current = feedback.filter(entry => entry.submission.expectedEvidenceHash === evidence.contentHash
    && entry.submittedBy?.role !== "source" && !["rejected", "superseded", "pending_example"].includes(entry.status)
    && (!decision || entry.createdAt <= decision.decidedAt)
    && (!entry.review?.decision || !decision || sameLearningRef(entry.review.decision, learningRef(decision))))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const outcome = current.find(entry => entry.submission.kind === "outcome");
  const correction = decision && ["not_required", "rejected"].includes(decision.targetApproval) ? undefined : current.find(entry => entry.submission.kind === "target_correction");
  const rating = TaskRatingSchema.safeParse(outcome?.submission.value);
  return {
    rating: rating.success ? rating.data : { ...emptyTaskRating(), score: Number.NaN },
    cannotAssess: outcome?.submission.value.assessment === "cannot_assess",
    correctAnswer: Boolean(correction || decision?.approvedTarget),
    target: JSON.stringify(correction?.submission.value ?? decision?.approvedTarget ?? evidence.submission.observedOutput ?? evidence.submission.expected ?? {}, null, 2),
    trainingUse: decision?.taskAdmissibility ?? "approved",
    note: decision?.note ?? outcome?.submission.note ?? "",
  };
}
