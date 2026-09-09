import { useEffect, useState } from "react";
import type { TrainingCandidateDecision, TrainingCandidateDecisionRequest } from "openpond-sdk/training";
import { api, type ClientConnection, type ManagedCandidateReview as Review } from "../../api";

export function ManagedCandidateReview({ connection, lineageId, jobId, onSaved }: {
  connection: ClientConnection | null;
  onSaved: () => Promise<unknown>;
} & ({ lineageId: string; jobId?: never } | { lineageId?: never; jobId: string })) {
  const reviewId = jobId ?? lineageId;
  const scope = jobId ? "jobs" : "models";
  const [view, setView] = useState<Review | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"accepted" | "rejected" | null>(null);
  const [reason, setReason] = useState("");
  const [attempt, setAttempt] = useState<TrainingCandidateDecisionRequest | null>(null);
  const [history, setHistory] = useState<TrainingCandidateDecision[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    if (!connection) { setLoading(false); setReady(false); setError("Connect to OpenPond to review this candidate."); return; }
    let active = true;
    setLoading(true); setReady(false); setError(null); setHistory([]);
    void (async () => {
      try {
        if (scope === "models") {
          const cached = await api.candidateReview(connection, reviewId);
          if (active && cached) setView(cached);
        }
        const current = await api.candidateReview(connection, reviewId, true, scope);
        if (active) { setView(current); setReady(Boolean(current)); }
      } catch (caught) { if (active) setError(message(caught)); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [connection, reviewId, scope, refresh]);

  function begin(value: "accepted" | "rejected") { setOutcome(value); setReason(""); setAttempt(null); }
  async function save() {
    if (!connection || !view || !outcome || !reason.trim()) return;
    const request = attempt && attempt.reason === reason.trim() && attempt.decision === outcome ? attempt : {
      schemaVersion: "openpond.trainingCandidateDecisionRequest.v1" as const,
      ...view.target, decision: outcome, reason: reason.trim(), idempotencyKey: crypto.randomUUID(),
      expectedDecision: view.decision ? { id: view.decision.id, contentHash: view.decision.contentHash } : null,
    };
    setAttempt(request); setSaving(true); setError(null);
    try {
      setView(await api.recordCandidateReview(connection, reviewId, request, scope));
      setOutcome(null); setAttempt(null); setHistory([]);
      await onSaved();
    } catch (caught) { setError(message(caught)); }
    finally { setSaving(false); }
  }
  const earlier = (history.at(-1) ?? view?.decision)?.request.expectedDecision;
  async function readEarlier() {
    if (!connection || !earlier) return;
    setHistoryLoading(true); setError(null);
    try { const value = await api.candidateReviewHistory(connection, reviewId, earlier, scope); setHistory(values => [...values, value]); }
    catch (caught) { setError(message(caught)); }
    finally { setHistoryLoading(false); }
  }
  const decision = view?.decision;
  return (
    <section className="training-run-evaluation" aria-label="Candidate review">
      <h3>Candidate review</h3>
      {decision ? <>
        <strong>{decision.request.decision === "accepted" ? "Accepted" : "Rejected"}</strong>
        <p>{decision.request.reason}</p>
        <p className="training-muted">Review {decision.revision} · {new Date(decision.decidedAt).toLocaleString()}</p>
      </> : <p className="training-muted">{loading ? "Loading candidate review…" : view ? "No candidate decision recorded." : "Candidate review unavailable."}</p>}
      {view ? <p className="training-muted">Last synced {new Date(view.syncedAt).toLocaleString()}. Acceptance keeps this candidate for later use; serving is activated separately.</p> : null}
      {error ? <p role="alert" className="training-error">{error}</p> : null}
      <div className="training-dialog-actions">
        <button className="training-button secondary" type="button" disabled={loading || saving} onClick={() => setRefresh(value => value + 1)}>Refresh review</button>
        <button className="training-button" type="button" disabled={!ready || loading || saving || decision?.request.decision === "accepted"} onClick={() => begin("accepted")}>Accept candidate</button>
        <button className="training-button danger" type="button" disabled={!ready || loading || saving || decision?.request.decision === "rejected"} onClick={() => begin("rejected")}>Reject candidate</button>
      </div>
      {history.map(value => <details key={value.id} className="training-evidence"><summary>Review {value.revision} · {value.request.decision}</summary><p>{value.request.reason}</p><p>{new Date(value.decidedAt).toLocaleString()}</p></details>)}
      {earlier ? <button className="training-button secondary" type="button" disabled={historyLoading || saving} onClick={() => void readEarlier()}>{historyLoading ? "Loading…" : "Earlier review"}</button> : null}
      {outcome ? <div className="training-dialog-backdrop" role="presentation" onMouseDown={() => !saving && setOutcome(null)}>
        <section className="training-dialog training-promotion-dialog" role="dialog" aria-modal="true" aria-label="Review candidate" onMouseDown={event => event.stopPropagation()}>
          <div className="training-dialog-header"><h2>{outcome === "accepted" ? "Accept this candidate?" : "Reject this candidate?"}</h2></div>
          <p>The adapter and its recorded evaluation remain in the candidate’s history.</p>
          <label className="training-promotion-reason"><span>Reason</span><textarea autoFocus maxLength={5000} value={reason} onChange={event => setReason(event.target.value)} /></label>
          {error ? <p role="alert" className="training-error">{error}</p> : null}
          <div className="training-dialog-actions">
            <button className="training-button secondary" type="button" disabled={saving} onClick={() => setOutcome(null)}>Cancel</button>
            <button className={`training-button ${outcome === "rejected" ? "danger" : ""}`} type="button" disabled={saving || !reason.trim()} onClick={() => void save()}>{saving ? "Saving…" : attempt ? "Retry save" : "Save decision"}</button>
          </div>
        </section>
      </div> : null}
    </section>
  );
}
function message(value: unknown) { return value instanceof Error ? value.message : "Candidate review could not be loaded."; }
