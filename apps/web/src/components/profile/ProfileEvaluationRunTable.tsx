import { useState } from "react";
import type { ProfileEvaluationDiscovery } from "../../api";
import { displayScore, displayTimestamp, modelLabel, targetLabel, type EvaluationRun } from "./profile-evaluation-display";

export function ProfileEvaluationRunTable({ runs, definitions, sourceRevision, onOpen, onSave, savingReportId }: {
  runs: EvaluationRun[];
  definitions: ProfileEvaluationDiscovery["definitions"];
  sourceRevision: string;
  onOpen: (run: EvaluationRun) => void;
  onSave: (id: string) => void;
  savingReportId: string | null;
}) {
  const [limit, setLimit] = useState(20);
  return <div className="profile-evaluations-history">
    <h4>Run history</h4>
    {runs.length ? <div className="profile-table-scroll"><table className="profile-evaluation-table">
      <thead><tr><th scope="col">Evaluation / target</th><th scope="col">Completed</th><th scope="col">Model</th>
        <th scope="col">Result</th><th scope="col">Score</th><th scope="col">Attempts</th><th scope="col">Source</th><th scope="col">Actions</th></tr></thead>
      <tbody>{runs.slice(0, limit).map(run => {
        const source = run.manifest.profileEvaluation;
        const definition = source?.sourceRevision === sourceRevision ? definitions.find(item => item.id === source.definitionId) : null;
        return <tr key={run.manifest.id}><th scope="row"><button type="button" onClick={() => onOpen(run)}>{definition?.label ?? source?.definitionId ?? run.manifest.id}</button>
          {source ? <small>{targetLabel(source.target)}</small> : null}</th>
          <td>{displayTimestamp(run.completedAt)}</td><td>{modelLabel(run)}</td><td>{run.passed ? "Passed" : "Did not pass"}</td>
          <td>{displayScore(run.metric.value)}</td><td>{run.receiptRefs.length}</td><td title={source?.sourceRevision}>{source?.sourceRevision.slice(0, 10) ?? "—"}</td>
          <td><button type="button" onClick={() => onOpen(run)}>View results</button> <button type="button" disabled={Boolean(savingReportId)} onClick={() => onSave(run.manifest.id)}>
            {savingReportId === run.manifest.id ? "Saving…" : "Save report"}</button></td></tr>;
      })}</tbody></table></div> : <p>No evaluation runs yet.</p>}
    {runs.length > limit ? <button type="button" onClick={() => setLimit(current => current + 20)}>Show more runs</button> : null}
  </div>;
}
