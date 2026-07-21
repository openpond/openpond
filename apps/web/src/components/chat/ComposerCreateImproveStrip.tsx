import { useEffect, useState } from "react";
import {
  createImproveActionShapeFromMetadata,
  type CreateImproveQuestion,
  type CreateImproveRun,
} from "@openpond/contracts";
import { Check, CircleAlert, FileText, HelpCircle, Loader2, Pause, Play, RefreshCw, X } from "../icons";
import type { CreateImproveReviewActionInput } from "./create-pipeline-types";

export type ComposerCreateImproveRuntime = {
  run: CreateImproveRun;
  onAnswerQuestion?: (
    input: CreateImproveReviewActionInput,
    questionId: string,
    answerValue: string,
  ) => Promise<void>;
  onApprove?: (input: CreateImproveReviewActionInput) => Promise<void>;
  onApplyCandidate?: (
    input: CreateImproveReviewActionInput,
    candidateId: string,
  ) => Promise<void>;
  onCancel?: (input: CreateImproveReviewActionInput) => Promise<void>;
  onOpenPullRequest?: (
    input: CreateImproveReviewActionInput,
    candidateId: string,
  ) => Promise<void>;
  onPause?: (input: CreateImproveReviewActionInput) => Promise<void>;
  onReconcilePullRequest?: (
    input: CreateImproveReviewActionInput,
    candidateId: string,
  ) => Promise<void>;
  onRejectCandidate?: (
    input: CreateImproveReviewActionInput,
    candidateId: string,
  ) => Promise<void>;
  onResume?: (input: CreateImproveReviewActionInput) => Promise<void>;
  onRevise?: (input: CreateImproveReviewActionInput, revision: string) => Promise<void>;
};

export type ComposerCreateImproveActions = Omit<
  ComposerCreateImproveRuntime,
  "run"
>;

export function ComposerCreateImproveStrip({
  runtime,
}: {
  runtime: ComposerCreateImproveRuntime;
}) {
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revision, setRevision] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const run = runtime.run;
  const plan = run.plan;
  const question = activeCreateImproveQuestion(run);
  const actionInput = { run };
  const tone = createImproveTone(run.state);
  const candidate = latestAgentCandidate(run);
  const pullRequest = candidate?.git?.pullRequest ?? run.releaseOutcome.pullRequest;

  useEffect(() => {
    setRevisionOpen(false);
    setRevision("");
    setBusyAction(null);
  }, [run.id, run.revision, run.state, plan?.id, question?.id]);

  async function runAction(label: string, handler: (() => Promise<void>) | undefined) {
    if (!handler || busyAction) return;
    setBusyAction(label);
    try {
      await handler();
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section className={`composer-create-strip ${tone}`} aria-label="Create or improve status">
      <div className="composer-create-strip-heading">
        {tone === "danger" ? (
          <CircleAlert size={15} />
        ) : run.state === "awaiting_questions" ? (
          <HelpCircle size={15} />
        ) : isCreateImproveRunning(run.state) ? (
          <Loader2 className="composer-create-spin" size={15} />
        ) : (
          <FileText size={15} />
        )}
        <span>{createImproveTitle(run)}</span>
        <small>{run.target.kind}</small>
      </div>

      {run.state === "awaiting_questions" && question ? (
        <div className="composer-create-question">
          <p>{question.prompt}</p>
          <div className="composer-create-options">
            {question.options.map((option) => (
              <button
                type="button"
                key={option.id}
                disabled={Boolean(busyAction)}
                onClick={() =>
                  void runAction(`answer:${option.id}`, () =>
                    runtime.onAnswerQuestion
                      ? runtime.onAnswerQuestion(actionInput, question.id, option.value)
                      : Promise.resolve(),
                  )
                }
              >
                <span>{busyAction === `answer:${option.id}` ? "Saving" : option.label}</span>
                {option.description ? <small>{option.description}</small> : null}
              </button>
            ))}
          </div>
        </div>
      ) : run.state === "awaiting_plan_approval" && plan ? (
        <div className="composer-create-plan-summary">
          <p>{plan.summary}</p>
          <CreateImprovePlanFacts run={run} />
          {revisionOpen ? (
            <div className="composer-create-revision">
              <textarea
                rows={2}
                value={revision}
                placeholder="Describe the plan revision"
                onChange={(event) => setRevision(event.currentTarget.value)}
              />
              <div>
                <button
                  type="button"
                  disabled={!revision.trim() || Boolean(busyAction)}
                  onClick={() =>
                    void runAction("revise", () =>
                      runtime.onRevise
                        ? runtime.onRevise(actionInput, revision)
                        : Promise.resolve(),
                    )
                  }
                >
                  <FileText size={13} />
                  <span>{busyAction === "revise" ? "Saving" : "Save revision"}</span>
                </button>
                <button
                  type="button"
                  disabled={Boolean(busyAction)}
                  onClick={() => setRevisionOpen(false)}
                >
                  <X size={13} />
                  <span>Close</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="composer-create-actions">
              <button
                type="button"
                disabled={Boolean(busyAction)}
                onClick={() =>
                  void runAction("approve", () =>
                    runtime.onApprove ? runtime.onApprove(actionInput) : Promise.resolve(),
                  )
                }
              >
                <Check size={13} />
                <span>{busyAction === "approve" ? "Confirming" : "Confirm plan"}</span>
              </button>
              <button
                type="button"
                disabled={Boolean(busyAction)}
                onClick={() => setRevisionOpen(true)}
              >
                <FileText size={13} />
                <span>Edit plan</span>
              </button>
              <button
                type="button"
                disabled={Boolean(busyAction)}
                onClick={() =>
                  void runAction("cancel", () =>
                    runtime.onCancel ? runtime.onCancel(actionInput) : Promise.resolve(),
                  )
                }
              >
                <X size={13} />
                <span>{busyAction === "cancel" ? "Cancelling" : "Cancel"}</span>
              </button>
            </div>
          )}
        </div>
      ) : run.state === "paused" ? (
        <div className="composer-create-status-body">
          <p>This work is paused. Resume it when you are ready to continue.</p>
          <button
            type="button"
            disabled={Boolean(busyAction)}
            onClick={() =>
              void runAction("resume", () =>
                runtime.onResume ? runtime.onResume(actionInput) : Promise.resolve(),
              )
            }
          >
            <Play size={13} />
            <span>{busyAction === "resume" ? "Resuming" : "Resume"}</span>
          </button>
        </div>
      ) : run.state === "awaiting_promotion" && candidate ? (
        <div className="composer-create-status-body">
          <p>{candidateComparisonText(run, candidate.id)}</p>
          <div className="composer-create-actions">
            <button
              type="button"
              disabled={Boolean(busyAction) || !candidateCanApply(run, candidate.id)}
              onClick={() =>
                void runAction("apply-candidate", () =>
                  runtime.onApplyCandidate
                    ? runtime.onApplyCandidate(actionInput, candidate.id)
                    : Promise.resolve(),
                )
              }
            >
              <Check size={13} />
              <span>{busyAction === "apply-candidate" ? "Applying" : "Apply update"}</span>
            </button>
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() =>
                void runAction("reject-candidate", () =>
                  runtime.onRejectCandidate
                    ? runtime.onRejectCandidate(actionInput, candidate.id)
                    : Promise.resolve(),
                )
              }
            >
              <X size={13} />
              <span>{busyAction === "reject-candidate" ? "Keeping current version" : "Keep current version"}</span>
            </button>
          </div>
        </div>
      ) : run.state === "pull_request_open" && candidate && pullRequest ? (
        <div className="composer-create-status-body">
          <p>
            {run.target.kind === "agent"
              ? "An Agent update review is open. Finish or close it, then refresh its status."
              : "An external review is open. Merge or close it, then refresh its status."}
          </p>
          <div className="composer-create-actions">
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() =>
                void runAction("reconcile-pr", () =>
                  runtime.onReconcilePullRequest
                    ? runtime.onReconcilePullRequest(actionInput, candidate.id)
                    : Promise.resolve(),
                )
              }
            >
              <RefreshCw size={13} />
              <span>{busyAction === "reconcile-pr" ? "Checking" : "Refresh review"}</span>
            </button>
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() =>
                void runAction("reject-candidate", () =>
                  runtime.onRejectCandidate
                    ? runtime.onRejectCandidate(actionInput, candidate.id)
                    : Promise.resolve(),
                )
              }
            >
              <X size={13} />
              <span>{busyAction === "reject-candidate" ? "Closing" : "Close review"}</span>
            </button>
          </div>
        </div>
      ) : run.state === "blocked" || run.state === "failed" || run.state === "cancelled" ? (
        <div className="composer-create-status-body">
          <p>{run.blockedReason ?? "This work stopped before it was ready."}</p>
          {run.state === "blocked" && candidate?.git?.worktreePath && ["draft", "checking"].includes(candidate.status) ? (
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() =>
                void runAction("resume", () =>
                  runtime.onResume ? runtime.onResume(actionInput) : Promise.resolve(),
                )
              }
            >
              <Play size={13} />
              <span>{busyAction === "resume" ? "Continuing" : "Continue update"}</span>
            </button>
          ) : run.state === "blocked" && candidate?.git?.pullRequest?.state === "merged" ? (
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() =>
                void runAction("reconcile-pr", () =>
                  runtime.onReconcilePullRequest
                    ? runtime.onReconcilePullRequest(actionInput, candidate.id)
                    : Promise.resolve(),
                )
              }
            >
              <RefreshCw size={13} />
              <span>{busyAction === "reconcile-pr" ? "Checking" : "Re-run verification"}</span>
            </button>
          ) : null}
        </div>
      ) : run.state === "released" || run.state === "rejected" || run.state === "ready_local" || run.state === "ready" || run.state === "published_hosted" ? (
        <div className="composer-create-status-body composer-create-status-body-reveals">
          <p>
            {run.state === "released"
              ? "The Agent update is saved and its checks passed."
              : run.state === "rejected"
                ? "The Agent update was not applied."
                : run.state === "published_hosted"
                  ? "Published to the hosted Profile."
                  : "The Agent and its actions are ready to use."}
          </p>
          <div className="composer-create-hover-details">
            <CreateImprovePlanFacts run={run} />
          </div>
        </div>
      ) : (
        <div className="composer-create-status-body">
          <p>{createImproveProgressText(run)}</p>
          <CreateImprovePlanFacts run={run} />
          {run.executionPolicy.pauseAllowed && runtime.onPause ? (
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() =>
                void runAction("pause", () => runtime.onPause?.(actionInput) ?? Promise.resolve())
              }
            >
              <Pause size={13} />
              <span>{busyAction === "pause" ? "Pausing" : "Pause"}</span>
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function activeCreateImproveQuestion(run: CreateImproveRun): CreateImproveQuestion | null {
  return (
    run.questions.find((question) => question.status === "pending" && question.required) ??
    run.questions.find((question) => question.status === "pending") ??
    null
  );
}

function CreateImprovePlanFacts({ run }: { run: CreateImproveRun }) {
  const plan = run.plan;
  const isAgent = run.target.kind === "agent";
  const source = isAgent ? null : run.sourceRefs[0] ?? plan?.sourcePlan[0]?.path ?? null;
  const checks = run.checkRefs.length || plan?.checks.length || 0;
  const requirements = isAgent ? 0 : plan?.requirements.length ?? 0;
  const refs = isAgent ? [] : [...run.sourceRefs, ...run.checkRefs].slice(0, 4);
  const actionShape = createImproveActionShapeFromMetadata(plan?.metadata);
  if (!source && checks === 0 && requirements === 0 && refs.length === 0 && !actionShape) {
    return null;
  }
  return (
    <>
      <div className="composer-create-facts">
        {actionShape ? <span title={actionShape.detail}>{actionShape.label}</span> : null}
        {source ? <span title={source}>{source}</span> : null}
        {checks ? <span>{isAgent ? `${checks} checks` : run.checkRefs.length ? `${run.checkRefs.length} check refs` : `${checks} checks`}</span> : null}
        {requirements ? <span>{requirements} setup rows</span> : null}
      </div>
      {refs.length ? (
        <ul className="composer-create-refs" aria-label="Source and check refs">
          {refs.map((ref) => <li key={ref}><code title={ref}>{ref}</code></li>)}
        </ul>
      ) : null}
    </>
  );
}

function createImproveTitle(run: CreateImproveRun): string {
  const isAgent = run.target.kind === "agent";
  if (run.state === "awaiting_questions") return "Question";
  if (run.state === "awaiting_plan_approval") return "Plan";
  if (run.state === "applying_source") return isAgent ? "Saving Agent" : "Applying source";
  if (run.state === "running_checks") return "Running checks";
  if (run.state === "evaluating") return isAgent ? "Checking Agent" : "Evaluating";
  if (run.state === "awaiting_promotion") return isAgent ? "Update ready" : "Candidate ready";
  if (run.state === "opening_pull_request") return "Opening review";
  if (run.state === "pull_request_open") return "Review open";
  if (run.state === "reconciling_release") return isAgent ? "Applying update" : "Merging change";
  if (run.state === "released") return isAgent ? "Agent updated" : "Released";
  if (run.state === "rejected") return isAgent ? "Current Agent kept" : "Rejected";
  if (run.state === "paused") return "Paused";
  if (run.state === "ready" || run.state === "ready_local") return "Ready";
  if (run.state === "published_hosted") return "Published";
  if (run.state === "cancelled") return "Cancelled";
  if (run.state === "blocked") return "Blocked";
  if (run.state === "failed") return "Failed";
  return run.operation === "improve" ? "Improve" : "Create";
}

function createImproveProgressText(run: CreateImproveRun): string {
  const state = run.state;
  const isAgent = run.target.kind === "agent";
  if (state === "applying_source") return isAgent ? "Saving the approved Agent plan." : "Applying the approved source changes.";
  if (state === "running_checks") return isAgent ? "Running checks against the Agent." : "Running checks against the candidate.";
  if (state === "evaluating") return isAgent ? "Checking the Agent's behavior." : "Evaluating the candidate against its Evals.";
  if (state === "opening_pull_request") return isAgent ? "Preparing the Agent update review." : "Opening the candidate review.";
  if (state === "reconciling_release") return "Applying the change and verifying the active Profile.";
  if (state === "pushing_hosted") return "Pushing the Profile source.";
  if (state === "running_hosted_checks") return "Running hosted checks.";
  return "Preparing the work.";
}

function createImproveTone(
  state: CreateImproveRun["state"],
): "info" | "warning" | "success" | "danger" {
  if (["released", "ready", "ready_local", "published_hosted"].includes(state)) return "success";
  if (["rejected", "blocked", "failed", "cancelled"].includes(state)) return "danger";
  if (["awaiting_questions", "awaiting_plan_approval", "awaiting_promotion", "pull_request_open", "paused"].includes(state)) return "warning";
  return "info";
}

function isCreateImproveRunning(state: CreateImproveRun["state"]): boolean {
  return ["planning", "applying_source", "running_checks", "evaluating", "opening_pull_request", "reconciling_release", "pushing_hosted", "running_hosted_checks"].includes(state);
}

function latestAgentCandidate(run: CreateImproveRun) {
  return [...run.candidates].reverse().find((candidate) => candidate.target.kind === "agent") ?? null;
}

function candidateCanApply(run: CreateImproveRun, candidateId: string): boolean {
  const receipts = run.evaluationReceipts.filter(
    (receipt) => receipt.candidateId === candidateId && receipt.subject === "candidate",
  );
  return receipts.length > 0 && receipts.every(
    (receipt) => receipt.status === "passed" && receipt.publishGate !== "failed",
  );
}

function candidateComparisonText(run: CreateImproveRun, candidateId: string): string {
  const active = run.evaluationReceipts.find(
    (receipt) => receipt.candidateId === candidateId && receipt.subject === "active",
  );
  const candidate = run.evaluationReceipts.find(
    (receipt) => receipt.candidateId === candidateId && receipt.subject === "candidate",
  );
  const result = (receipt: typeof active) => receipt?.summaryCounts
    ? `${receipt.summaryCounts.passed}/${receipt.summaryCounts.total}`
    : receipt?.status ?? "not run";
  return run.target.kind === "agent"
    ? `Current Agent: ${result(active)} checks passed. Updated Agent: ${result(candidate)} checks passed.`
    : `Base Evals: ${result(active)} passed. Candidate Evals: ${result(candidate)} passed.`;
}
