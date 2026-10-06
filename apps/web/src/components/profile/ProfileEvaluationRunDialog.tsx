import { useEffect, useRef, useState } from "react";
import type { ClientConnection } from "../../api";
import { inspectProfileEvaluation, type ProfileEvaluationCaseInspection } from "../../api/profile-evaluation-inspection";
import { displayScore, displayTimestamp, modelLabel, targetLabel, type EvaluationRun } from "./profile-evaluation-display";

export function ProfileEvaluationRunDialog({ connection, run, onClose }: {
  connection: ClientConnection;
  run: EvaluationRun;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [cases, setCases] = useState<ProfileEvaluationCaseInspection[]>([]);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProfileEvaluationCaseInspection | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [caseLimit, setCaseLimit] = useState(50);
  const [cursor, setCursor] = useState<string | null>(null);

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void inspectProfileEvaluation(connection, { runId: run.manifest.id }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setCases(result.cases); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [connection, run.manifest.id, retry]);
  useEffect(() => {
    if (!receiptId) return;
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    void inspectProfileEvaluation(connection, { runId: run.manifest.id, receiptId, ...(cursor ? { eventAfterId: cursor } : {}) }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setDetail(result.cases[0] ?? null); })
      .catch(cause => { if (!controller.signal.aborted) setDetailError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [connection, run.manifest.id, receiptId, cursor, retry]);
  const source = run.manifest.profileEvaluation;
  return <dialog ref={dialog} className="profile-evaluation-dialog" aria-labelledby="profile-run-title" onCancel={onClose}
    onClick={event => { if (event.target === event.currentTarget) {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    } }}>
    <div className="profile-evaluations-detail">
      <header className="profile-evaluation-dialog-header"><h2 id="profile-run-title">Evaluation results</h2><button type="button" autoFocus onClick={onClose}>Close</button></header>
      <strong>{source?.definitionId ?? run.manifest.id} · {run.passed ? "Passed" : "Did not pass"} · {displayScore(run.metric.value)}</strong>
      <p>{source ? targetLabel(source.target) : "Profile evaluation"} · {modelLabel(run)} · {displayTimestamp(run.completedAt)}</p>
      <p>Pass rate {displayScore(run.passRate)} · Source {source?.sourceRevision} · Run {run.manifest.id}</p>
      <details><summary>Frozen run configuration</summary><pre>{JSON.stringify(run.manifest, null, 2)}</pre></details>
      {loading ? <p role="status">Loading case results…</p> : null}
      {error ? <p role="alert">{error} <button type="button" onClick={() => setRetry(current => current + 1)}>Retry</button></p> : null}
      <div className="profile-table-scroll"><table className="profile-evaluation-table"><thead><tr>
        <th scope="col">Task</th><th scope="col">Seed</th><th scope="col">Result</th><th scope="col">Score</th><th scope="col">Grading</th><th scope="col">Latency</th><th scope="col">Cost</th>
      </tr></thead><tbody>{cases.slice(0, caseLimit).map(item => <tr key={item.receiptId}>
        <th scope="row"><button type="button" aria-pressed={receiptId === item.receiptId} onClick={() => {
          if (receiptId === item.receiptId && !cursor) return;
          setReceiptId(item.receiptId); setDetail(null); setCursor(null);
        }}>{item.taskId}</button></th><td>{item.seed}</td><td>{item.passed ? "Passed" : "Did not pass"}</td>
        <td>{displayScore(item.score)}</td><td>{item.gradingStatus}{item.failureClass ? ` · ${item.failureClass}` : ""}</td>
        <td>{item.latencyMs.toLocaleString()} ms</td><td>{item.costUsd === null ? "Unknown" : `$${item.costUsd.toFixed(4)}`}</td>
      </tr>)}</tbody></table></div>
      {cases.length > caseLimit ? <button type="button" onClick={() => setCaseLimit(current => current + 50)}>Show more cases</button> : null}
      {detailLoading ? <p role="status">Loading case evidence…</p> : null}
      {detailError ? <p role="alert">{detailError} <button type="button" onClick={() => setRetry(current => current + 1)}>Retry</button></p> : null}
      {detail ? <div className="profile-evaluations-detail" aria-label="Case evidence">
        <h3>{detail.taskId} · Seed {detail.seed}</h3>
        <h4>Grader feedback</h4>
        <p>Evaluations use the graders pinned by their Taskset. Each result below identifies the grader and version used for this case.</p>
        {detail.feedback.length ? detail.feedback.map(grader => <div key={`${grader.graderId}:${grader.graderVersion}`}>
          <strong>{grader.graderId} · {grader.graderVersion} · {displayScore(grader.score)} · {grader.passed ? "Passed" : "Did not pass"}</strong>
          <ul>{grader.feedback.map((message, index) => <li key={index}>{message}</li>)}</ul>
        </div>) : <p>No grader feedback retained for this case.</p>}
        {detail.evidence ? <>
          <h4>Input</h4><pre>{detail.evidence.prompt}</pre>
          <h4>Output</h4><pre>{detail.evidence.output?.text ?? detail.evidence.partialOutput?.text ?? "No output retained."}</pre>
          {detail.evidence.error ? <p role="alert">{detail.evidence.error}</p> : null}
          <details><summary>Trace · {detail.evidence.eventCount} events</summary>
            <pre>{JSON.stringify(detail.evidence.events, null, 2)}</pre>
            {cursor ? <button type="button" disabled={detailLoading} onClick={() => setCursor(null)}>First trace page</button> : null}
            {detail.evidence.nextEventCursor ? <button type="button" disabled={detailLoading} onClick={() => setCursor(detail.evidence!.nextEventCursor)}>Next trace page</button> : null}
          </details>
        </> : <p>No policy trace retained for this case. Scores and grader feedback are available above.</p>}
        <details><summary>Case receipt</summary><pre>{JSON.stringify(detail.receipt, null, 2)}</pre></details>
      </div> : null}
    </div>
  </dialog>;
}
