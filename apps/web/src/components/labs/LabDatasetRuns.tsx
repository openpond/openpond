import type { Taskset, TasksetBaselineRun } from "@openpond/contracts";

import { DetailSection } from "../training/DetailSection";
import { LabStatusBadge } from "./LabStatusBadge";

const ACTIVE_STATUSES = new Set<TasksetBaselineRun["status"]>([
  "queued",
  "preparing",
  "running",
  "cancelling",
]);

export function LabDatasetRuns({
  runs,
  taskset,
  onCancel,
}: {
  runs: TasksetBaselineRun[];
  taskset: Taskset;
  onCancel: (runId: string) => Promise<unknown>;
}) {
  return (
    <DetailSection title="Checks">
      {runs.length ? (
        <div className="training-table-wrap">
          <table className="training-data-table" aria-label="Dataset checks">
            <thead>
              <tr>
                <th>Check</th>
                <th>Version</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Provider</th>
                <th>Updated</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const active = ACTIVE_STATUSES.has(run.status);
                return (
                  <tr key={run.id}>
                    <td>
                      <strong>{run.configuration.split === "train" ? "Train signal" : "Baseline"}</strong>
                      <span>{run.configuration.taskLimit} prompts × {run.configuration.attemptsPerTask}</span>
                      {run.error ? <span className="training-field-error" role="alert">{run.error}</span> : null}
                    </td>
                    <td>{run.tasksetHash === taskset.contentHash ? "Current" : "Earlier"}</td>
                    <td>
                      <LabStatusBadge
                        label={run.status.replaceAll("_", " ")}
                        value={run.status}
                      />
                    </td>
                    <td>{runProgress(run)}</td>
                    <td>{providerStatus(run)}</td>
                    <td>{formatDateTime(run.updatedAt)}</td>
                    <td>
                      {active ? (
                        <button
                          className="training-button secondary"
                          disabled={run.status === "cancelling"}
                          type="button"
                          onClick={() => void onCancel(run.id)}
                        >
                          {run.status === "cancelling" ? "Cancelling…" : "Cancel"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="training-run-placeholder">No checks have been run for this Dataset yet.</div>
      )}
    </DetailSection>
  );
}

function runProgress(run: TasksetBaselineRun): string {
  const { completedAttempts, totalAttempts, stage } = run.progress;
  if (run.status === "succeeded") return `${completedAttempts}/${totalAttempts} complete`;
  if (run.status === "failed" || run.status === "cancelled") {
    return completedAttempts
      ? `${completedAttempts}/${totalAttempts} before ${run.status}`
      : stage.replaceAll("_", " ");
  }
  if (stage === "running") return `${completedAttempts}/${totalAttempts}`;
  return stage.replaceAll("_", " ");
}

function providerStatus(run: TasksetBaselineRun): string {
  if (!run.provider) return "Not started";
  if (run.provider.statusCode) return run.provider.statusCode;
  if (run.provider.state) return run.provider.state;
  return run.provider.phase.replaceAll("_", " ");
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
