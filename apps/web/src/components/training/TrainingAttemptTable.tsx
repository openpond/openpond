import { useState } from "react";
import type { RunStageEvidence } from "@openpond/contracts";

/** A keyboard-accessible alternative to the compact attempt cells. */
export function TrainingAttemptTable({ groups }: { groups: RunStageEvidence["groups"] }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const count = groups.reduce((total, group) => total + group.attempts.length, 0);
  if (!count) return null;
  const lastPage = Math.ceil(count / 100) - 1;
  const currentPage = Math.min(page, lastPage);
  const attempts = open ? groups.flatMap((group) => group.attempts.map((attempt) => ({ group: group.index, ...attempt }))).slice(currentPage * 100, (currentPage + 1) * 100) : [];
  return (
    <details className="training-rollout-attempts" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Recorded attempts · {count}</summary>
      {open ? <>
        <div className="training-table-wrap"><table className="training-data-table evaluation-workspace-table">
          <thead><tr><th>Group / slot</th><th>Attempt</th><th>State</th><th>Reward</th></tr></thead>
          <tbody>{attempts.map((attempt) => <tr key={attempt.id}>
            <td>{attempt.group + 1} / {attempt.slot + 1}</td><td>{attempt.attempt}</td>
            <td>{attempt.state.replaceAll("_", " ")}</td><td>{attempt.reward === null ? "—" : attempt.reward.toFixed(3)}</td>
          </tr>)}</tbody>
        </table></div>
        {lastPage > 0 ? <div className="training-rollout-pagination">
          <button type="button" className="training-button secondary" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</button>
          <span aria-live="polite">{currentPage * 100 + 1}–{Math.min(count, (currentPage + 1) * 100)} of {count}</span>
          <button type="button" className="training-button secondary" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next</button>
        </div> : null}
      </> : null}
    </details>
  );
}
