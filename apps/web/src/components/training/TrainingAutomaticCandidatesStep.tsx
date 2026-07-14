import type { TaskCandidate } from "@openpond/contracts";

export function TrainingAutomaticCandidatesStep({
  candidates,
  onRescan,
  onSelect,
}: {
  candidates: TaskCandidate[];
  onRescan: () => void;
  onSelect: (candidate: TaskCandidate) => void;
}) {
  return (
    <>
      <div className="training-dialog-scroll-body">
        <div className="training-run-step-heading">
          <h3>{candidates.length ? "Review repeated workflows" : "No repeated workflows found"}</h3>
          <p>{candidates.length ? "Choose a candidate to review its supporting chats before anything is disclosed." : "Nothing met the current recurrence and evidence thresholds. No empty model was created."}</p>
        </div>
        {candidates.length ? <div className="training-candidate-options">{candidates.map((candidate) => (
          <button key={candidate.id} type="button" onClick={() => onSelect(candidate)}>
            <span><strong>{candidate.title}</strong><small>{candidate.summary}</small></span>
            <dl>
              <div><dt>Supporting chats</dt><dd>{candidate.evidence.length}</dd></div>
              <div><dt>Confidence</dt><dd>{Math.round(candidate.scorecard.overall * 100)}%</dd></div>
              <div><dt>Preliminary</dt><dd>{candidate.recommendation.tactic.replaceAll("_", " ")}</dd></div>
            </dl>
          </button>
        ))}</div> : null}
      </div>
      <div className="training-dialog-actions">
        <button className="training-button secondary" type="button" onClick={onRescan}>{candidates.length ? "Scan again" : "Change scan"}</button>
      </div>
    </>
  );
}
