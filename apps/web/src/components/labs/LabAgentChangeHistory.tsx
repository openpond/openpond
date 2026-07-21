import type { CreateImproveRun } from "@openpond/contracts";

import { formatDateTime } from "../training/training-model-data";
import { LabStatusBadge } from "./LabStatusBadge";

export function LabAgentChangeHistory({
  runs,
  onReview,
}: {
  runs: CreateImproveRun[];
  onReview: (run: CreateImproveRun) => void;
}) {
  return (
    runs.length ? (
      <div className="training-table-wrap">
        <table className="training-data-table labs-agent-change-history">
          <thead>
            <tr>
              <th>Change</th>
              <th>Status</th>
              <th>Checks</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>
                  <button type="button" onClick={() => onReview(run)}>
                    <strong>{run.objective}</strong>
                    <span>{changeKindLabel(run)}</span>
                  </button>
                </td>
                <td>
                  <LabStatusBadge
                    label={agentChangeStatusLabel(run)}
                    value={run.state}
                  />
                </td>
                <td>{candidateEvalSummary(run)}</td>
                <td>{formatDateTime(run.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <div className="training-run-placeholder">No changes yet.</div>
    )
  );
}

function candidateEvalSummary(run: CreateImproveRun): string {
  const candidate = [...run.candidates].reverse().find((item) => item.target.kind === run.target.kind);
  if (!candidate) return "—";
  const receipts = run.evaluationReceipts.filter(
    (receipt) => receipt.candidateId === candidate.id && receipt.subject === "candidate",
  );
  const counts = receipts.reduce(
    (total, receipt) => ({
      passed: total.passed + (receipt.summaryCounts?.passed ?? 0),
      tests: total.tests + (receipt.summaryCounts?.total ?? 0),
    }),
    { passed: 0, tests: 0 },
  );
  if (counts.tests > 0) return `${counts.passed}/${counts.tests} passed`;
  return receipts[0]?.status ?? "Not run";
}

function changeKindLabel(run: CreateImproveRun): string {
  const kind = `${run.target.kind[0]!.toUpperCase()}${run.target.kind.slice(1)}`;
  return `${kind} ${run.operation === "improve" ? "improvement" : "creation"}`;
}

function agentChangeStatusLabel(run: CreateImproveRun): string {
  const fallbackState: string = run.state;
  if (run.state === "planning") return "Planning";
  if (run.state === "awaiting_questions") return "Waiting for input";
  if (run.state === "awaiting_plan_approval") return "Plan ready";
  if (run.state === "applying_source") return "Saving Agent";
  if (run.state === "running_checks" || run.state === "evaluating") return "Running checks";
  if (run.state === "awaiting_promotion") return "Update ready";
  if (run.state === "opening_pull_request") return "Preparing review";
  if (run.state === "pull_request_open") return "Review open";
  if (run.state === "reconciling_release") return "Applying update";
  if (run.state === "released") return "Updated";
  if (run.state === "rejected") return "Current version kept";
  if (run.state === "paused") return "Paused";
  if (run.state === "ready" || run.state === "ready_local") return "Ready";
  if (run.state === "pushing_hosted") return "Saving to hosted Profile";
  if (run.state === "running_hosted_checks") return "Running hosted checks";
  if (run.state === "published_hosted") return "Published";
  if (run.state === "cancelled") return "Cancelled";
  if (run.state === "blocked") return "Blocked";
  if (run.state === "failed") return "Failed";
  return fallbackState.replaceAll("_", " ");
}
