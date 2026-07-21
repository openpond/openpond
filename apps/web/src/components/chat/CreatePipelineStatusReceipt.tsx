import {
  createImproveActionShapeFromMetadata,
  type CreateImproveRun,
} from "@openpond/contracts";
import { FileText } from "../icons";

export function CreateImproveStatusReceipt({ run }: { run: CreateImproveRun }) {
  const plan = run.plan;
  const question = run.questions.find((item) => item.status === "pending") ?? null;
  const actionShape = createImproveActionShapeFromMetadata(plan?.metadata);
  const isAgent = run.target.kind === "agent";
  const source = isAgent ? null : run.sourceRefs[0] ?? plan?.sourcePlan[0]?.path ?? null;
  const checks = run.checkRefs.length || plan?.checks.length || 0;

  return (
    <section className="chat-create-receipt" aria-label="Create or improve status">
      <div className="chat-create-receipt-heading">
        <FileText size={14} />
        <span>{receiptTitle(run)}</span>
        <small>{run.target.kind}</small>
      </div>
      <p>{receiptText(run, plan?.summary ?? null, question?.prompt ?? null)}</p>
      {actionShape || source || checks ? (
        <div className="chat-create-receipt-facts">
          {actionShape ? <span title={actionShape.detail}>{actionShape.label}</span> : null}
          {source ? <span title={source}>{source}</span> : null}
          {checks ? <span>{checks} checks</span> : null}
        </div>
      ) : null}
    </section>
  );
}

function receiptTitle(run: CreateImproveRun): string {
  const isAgent = run.target.kind === "agent";
  if (run.state === "awaiting_questions") return "Question ready";
  if (run.state === "awaiting_plan_approval") return "Plan ready";
  if (run.state === "applying_source") return isAgent ? "Saving Agent" : "Applying source";
  if (run.state === "running_checks") return "Running checks";
  if (run.state === "evaluating") return isAgent ? "Checking Agent" : "Evaluating candidate";
  if (run.state === "awaiting_promotion") return isAgent ? "Update ready" : "Candidate ready";
  if (run.state === "opening_pull_request") return "Opening review";
  if (run.state === "pull_request_open") return "Review open";
  if (run.state === "reconciling_release") return isAgent ? "Applying update" : "Merging change";
  if (run.state === "released") return isAgent ? "Agent updated" : "Released";
  if (run.state === "rejected") return isAgent ? "Current Agent kept" : "Rejected";
  if (run.state === "ready" || run.state === "ready_local") return isAgent ? "Agent ready" : "Workproduct ready";
  if (run.state === "published_hosted") return "Published";
  if (run.state === "cancelled") return "Cancelled";
  if (run.state === "blocked") return "Blocked";
  if (run.state === "failed") return "Failed";
  return run.operation === "improve" ? "Planning improvement" : "Planning creation";
}

function receiptText(
  run: CreateImproveRun,
  planSummary: string | null,
  questionPrompt: string | null,
): string {
  if (run.state === "awaiting_questions" && questionPrompt) return questionPrompt;
  if (planSummary) return planSummary;
  if (run.blockedReason) return run.blockedReason;
  if (run.state === "ready" || run.state === "ready_local") {
    return run.target.kind === "agent"
      ? "The Agent and its actions are ready to use."
      : "The candidate and its checks are ready.";
  }
  if (run.state === "awaiting_promotion") {
    return run.target.kind === "agent"
      ? "The updated Agent passed its checks. Apply the update or keep the current version."
      : "The candidate has been committed and evaluated. Merge or reject it.";
  }
  if (run.state === "pull_request_open" && run.releaseOutcome.pullRequest) {
    return run.target.kind === "agent"
      ? "The Agent update review is waiting to finish or close."
      : "The external review is waiting for merge or closure.";
  }
  if (run.state === "released") {
    return run.target.kind === "agent"
      ? "The Agent update is saved and its checks passed."
      : "The change merged and the active Profile passed its post-merge Evals.";
  }
  if (run.state === "rejected") {
    return run.blockedReason ?? (run.target.kind === "agent" ? "The Agent update was not applied." : "The candidate was rejected.");
  }
  return `Preparing work for ${run.objective}.`;
}
