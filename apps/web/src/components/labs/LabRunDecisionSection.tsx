import type { CreateImproveRun } from "@openpond/contracts";

import { ComposerCreateImproveStrip } from "../chat/ComposerCreateImproveStrip";
import type { CreateImproveReviewActionInput } from "../chat/create-pipeline-types";

export function LabRunDecisionSection({
  run,
  onAnswerQuestion,
  onApplyCandidate,
  onApprove,
  onCancel,
  onOpenPullRequest,
  onPause,
  onOpenConversation,
  onReconcilePullRequest,
  onRejectCandidate,
  onRetry,
  onResume,
  onRevise,
}: {
  run: CreateImproveRun;
  onAnswerQuestion: (
    input: CreateImproveReviewActionInput,
    questionId: string,
    answerValue: string,
  ) => Promise<void>;
  onApprove: (input: CreateImproveReviewActionInput) => Promise<void>;
  onApplyCandidate: (
    input: CreateImproveReviewActionInput,
    candidateId: string,
  ) => Promise<void>;
  onCancel: (input: CreateImproveReviewActionInput) => Promise<void>;
  onOpenPullRequest: (
    input: CreateImproveReviewActionInput,
    candidateId: string,
  ) => Promise<void>;
  onPause: (input: CreateImproveReviewActionInput) => Promise<void>;
  onOpenConversation: (conversationId: string) => void;
  onReconcilePullRequest: (
    input: CreateImproveReviewActionInput,
    candidateId: string,
  ) => Promise<void>;
  onRejectCandidate: (
    input: CreateImproveReviewActionInput,
    candidateId: string,
  ) => Promise<void>;
  onRetry: () => void;
  onResume: (input: CreateImproveReviewActionInput) => Promise<void>;
  onRevise: (input: CreateImproveReviewActionInput, revision: string) => Promise<void>;
}) {
  const conversationLabel = run.state === "blocked"
    ? "Review blocker"
    : run.state === "failed"
      ? "Review failure"
      : "View progress";
  const retryAvailable = run.target.kind === "agent" && ["blocked", "failed", "cancelled"].includes(run.state);
  return (
    <div className="labs-run-decision">
      <ComposerCreateImproveStrip
        runtime={{
          run,
          onAnswerQuestion,
          onApplyCandidate,
          onApprove,
          onCancel,
          onOpenPullRequest,
          onPause,
          onReconcilePullRequest,
          onRejectCandidate,
          onResume,
          onRevise,
        }}
      />
      {run.scope.conversationId || retryAvailable ? (
        <div className="labs-run-decision-actions">
          {run.scope.conversationId ? (
            <button
              className="training-button secondary"
              type="button"
              onClick={() => onOpenConversation(run.scope.conversationId!)}
            >
              {conversationLabel}
            </button>
          ) : null}
          {retryAvailable ? (
            <button className="training-button" type="button" onClick={onRetry}>
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function runNeedsDecision(run: CreateImproveRun | null): run is CreateImproveRun {
  return Boolean(
    run &&
      (
        ["awaiting_questions", "awaiting_plan_approval", "pull_request_open", "paused"].includes(run.state) ||
        (run.state === "blocked" && run.candidates.some((candidate) => candidate.git?.pullRequest?.state === "merged"))
      ),
  );
}
