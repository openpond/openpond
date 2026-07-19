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
              <th>Evals</th>
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
                    label={run.state.replaceAll("_", " ")}
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
