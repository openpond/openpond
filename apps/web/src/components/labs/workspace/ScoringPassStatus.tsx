import type { ExperimentScoringPass } from "openpond-sdk/experiments";
import { EvaluationStatus } from "./EvaluationPresentation";

export function ScoringPassStatus({ pass, busy, onCancel }: {
  pass: ExperimentScoringPass; busy: boolean; onCancel: () => void;
}) {
  const active = ["queued", "running", "cancelling"].includes(pass.status);
  return <section aria-label="Selected scoring pass progress">
    <p>Scoring pass {pass.id} · <EvaluationStatus status={pass.status} /> · {pass.counts.scored}/{pass.totalCount} scored · {pass.counts.running} running · {pass.counts.pending} pending</p>
    <p>{pass.counts.unavailable} unavailable · {pass.counts.failed} failed · {pass.counts.cancelled} cancelled{pass.resultAvailable ? " · Retained result available" : ""}</p>
    {pass.error ? <p role="alert">{pass.error.code}: {pass.error.message}</p> : null}
    {active ? <button className="training-button secondary" disabled={busy || pass.status === "cancelling"} onClick={onCancel}>{pass.status === "cancelling" ? "Cancelling grading…" : "Cancel grading pass"}</button> : null}
  </section>;
}
