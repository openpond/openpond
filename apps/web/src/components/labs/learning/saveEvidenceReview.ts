import { learningRef, TaskAdmissionDecisionSchema, TaskFeedbackSchema, type LearningCommand, type TaskFeedbackSubmission } from "openpond-sdk/learning";
import type { OpenPondLearningClient as LearningClient } from "openpond-sdk/learning";

/** A review is several retained operations. Reuse this closure and its IDs on retry. */
export function createEvidenceReviewSave(input: {
  feedback: TaskFeedbackSubmission;
  correction: TaskFeedbackSubmission | null;
  review: Extract<LearningCommand, { action: "review" }>;
  feedbackResolutionId: string;
  correctionResolutionId: string;
}) {
  let feedback: ReturnType<typeof TaskFeedbackSchema.parse> | null = null;
  let correction: ReturnType<typeof TaskFeedbackSchema.parse> | null = null;
  let decision: ReturnType<typeof TaskAdmissionDecisionSchema.parse> | null = null;
  return async (api: Pick<LearningClient, "submitFeedback" | "command">) => {
    feedback ??= TaskFeedbackSchema.parse((await api.submitFeedback(input.feedback)).resources[0]);
    if (input.correction) correction ??= TaskFeedbackSchema.parse((await api.submitFeedback(input.correction)).resources[0]);
    decision ??= TaskAdmissionDecisionSchema.parse((await api.command(input.review)).resources[0]);
    if (decision.taskAdmissibility !== "pending") {
      for (const [entry, operationId] of [[feedback, input.feedbackResolutionId], [correction, input.correctionResolutionId]] as const) {
        // A retained correction is not applied merely because the task was excluded.
        if (entry && (entry.submission.kind !== "target_correction" || decision.targetApproval === "approved")) {
          await api.command({ action: "resolve_feedback", operationId, feedbackId: entry.id, expectedRevision: entry.revision, disposition: "applied", decision: learningRef(decision), note: input.review.note });
        }
      }
    }
    return decision;
  };
}

export function reviewDisposition(input: { selected: "approved" | "rejected" | "pending"; cannotAssess: boolean; taskReady: boolean; hasCorrection: boolean; correctionPassed: boolean }) {
  return input.selected === "approved" && (input.cannotAssess || !input.taskReady || (input.hasCorrection && !input.correctionPassed)) ? "pending" : input.selected;
}
