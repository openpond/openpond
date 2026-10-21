import "../../styles/training/training.css";
import "./run-flow-diagram.css";
import { createContext } from "react";
import { RetainedRunFeedback } from "./RetainedRunFeedback";
import type { RunStageEvidence, RunFeedbackTarget } from "@openpond/contracts";

export type RunEvidenceInspection = {
  title: string;
  status: string;
  facts?: RunStageEvidence["nodes"][number]["diagnostics"];
  feedback?: RunFeedbackTarget[];
  groupIndex?: number;
};
export const RunInspectionContext = createContext<
  ((selection: RunEvidenceInspection) => void) | null
>(null);

export function RunEvidencePanel({ title, status, facts, feedback }: RunEvidenceInspection) {
  return (
    <section aria-label={`${title} evidence`} className="run-evidence-panel">
      <header>
        <h3>{title} evidence</h3>
        <span className="training-muted">{status}</span>
      </header>
      <p className="training-muted">
        Execution records describe what ran. Task acceptance and learning quality come from retained
        grader evidence.
      </p>
      {facts?.length ? (
        <dl>
          {facts.map((fact, index) => (
            <div key={`${fact.label}:${index}`} data-severity={fact.severity}>
              <dt>{fact.label}</dt>
              <dd>
                {fact.value.length > 360 ? (
                  <details>
                    <summary>Inspect retained details</summary>
                    <pre>{fact.value}</pre>
                  </details>
                ) : (
                  <pre>{fact.value}</pre>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="training-muted">No additional diagnostic receipt retained for this stage.</p>
      )}
      <RetainedRunFeedback targets={feedback} />
    </section>
  );
}
