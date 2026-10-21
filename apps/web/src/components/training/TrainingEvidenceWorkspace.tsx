import "../../styles/labs/evaluation-workspace.css";
import type { RunStageEvidence } from "@openpond/contracts";
import { TrainingRecoveryLineage } from "./TrainingRecoveryLineage";
import { ErrorToast } from "../common/ErrorToast";
import { RunEvidencePanel, type RunEvidenceInspection } from "./RunEvidencePanel";
import { TrainingAttemptTable } from "./TrainingAttemptTable";
import { formatDateTime } from "./training-model-data";

export function TrainingEvidenceWorkspace({
  evidence,
  stage,
  onStage,
  inspection,
  groupIndex,
  logs = [],
  logsLoading,
  logsError,
}: {
  evidence: RunStageEvidence;
  stage: string;
  onStage: (stage: string) => void;
  inspection?: RunEvidenceInspection | null;
  groupIndex?: number;
  logs?: RunStageEvidence["logs"];
  logsLoading?: boolean;
  logsError?: unknown;
}) {
  const tabs = ["Logs", ...evidence.nodes.map((node) => node.label)];
  if (!tabs.includes(stage)) tabs.push(stage);
  const node =
    evidence.nodes.find((node) => node.label === stage) ??
    (evidence.inference?.label === stage ? evidence.inference : undefined);
  const runWide = groupIndex !== undefined && !node?.inLoop;
  const group = evidence.groups.find(group => group.index === groupIndex);
  const inherited = group?.inherited;
  const replay = group?.replay;
  return (
    <section className="training-evidence-workspace">
      <nav className="evaluation-workspace-tabs" aria-label="Run evidence tabs">
        {tabs.map((label) => (
          <button
            key={label}
            type="button"
            aria-pressed={stage === label}
            onClick={() => onStage(label)}
          >
            {label}
          </button>
        ))}
      </nav>
      {stage === "Logs" ? (
        <section aria-label="Run-wide logs">
          <p className="training-muted">Run-wide logs · entries retain their recorded context.</p>
          <ErrorToast error={logsError} />
          {logsLoading ? <p role="status">Loading retained logs…</p> : null}
          {!logs.length && !logsLoading ? (
            <p className="training-muted">No retained log entries loaded.</p>
          ) : null}
          <ol className="training-evidence-logs">
            {logs.map((entry, index) => (
              <li key={`${entry.id}:${index}`} data-level={entry.level}>
                <time>{formatDateTime(entry.at)}</time>
                <strong>{entry.source}</strong>
                <span>{entry.message}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : (
        <>
          <p className="training-muted">
            {runWide
              ? "Run-wide evidence. Baseline and final evaluations assess the run; they are not attributed to an individual group."
              : groupIndex === undefined
                ? "All retained groups"
                : `Group ${groupIndex + 1} retained evidence`}
          </p>
          {replay && evidence.recovery && node?.inLoop ? <><p className="training-muted">Replaying after checkpoint restore. Prior undurable output was not restored; current records belong to this attempt.</p><TrainingRecoveryLineage recovery={evidence.recovery} sourceJobId={replay.sourceJobId} compact /></> : null}
          {inherited && evidence.recovery && node?.inLoop ? <><p className="training-muted">Inherited source evidence. Attempts and optimizer records were not re-executed in this recovery run.</p><TrainingRecoveryLineage recovery={evidence.recovery} sourceJobId={inherited.sourceJobId} compact /></> : null}
          {inspection ? (
            <RunEvidencePanel {...inspection} />
          ) : node ? (
            <RunEvidencePanel
              title={node.label}
              status={node.status}
              facts={[
                ...(node.diagnostics ?? []),
                ...(node.error
                  ? [
                      {
                        label: "Recorded stage failure",
                        value: node.error,
                        severity: "error" as const,
                      },
                    ]
                  : []),
              ]}
              feedback={node.feedback}
            />
          ) : (
            <p className="training-muted">No retained evidence for this selection.</p>
          )}
          {stage === "Rollouts" ? <TrainingAttemptTable groups={evidence.groups} /> : null}
        </>
      )}
    </section>
  );
}
