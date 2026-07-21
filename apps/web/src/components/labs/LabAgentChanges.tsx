import { useMemo, useState } from "react";
import type {
  CreateImproveCandidate,
  CreateImproveRun,
  WorkspaceDiffSummary,
} from "@openpond/contracts";

import { LabStatusBadge } from "./LabStatusBadge";
import { LabStatusDot } from "./LabStatusDot";

export function LabAgentChanges({
  candidate,
  diff,
  error,
  run,
  onApplyCandidate,
  onOpenFiles,
  onRejectCandidate,
}: {
  candidate: CreateImproveCandidate;
  diff: WorkspaceDiffSummary | null;
  error: string | null;
  run: CreateImproveRun;
  onApplyCandidate: (run: CreateImproveRun, candidateId: string) => Promise<void>;
  onOpenFiles: () => void;
  onRejectCandidate: (run: CreateImproveRun, candidateId: string) => Promise<void>;
}) {
  const [busyAction, setBusyAction] = useState<"apply" | "reject" | null>(null);
  const receipts = useMemo(
    () => run.evaluationReceipts.filter((receipt) => receipt.candidateId === candidate.id),
    [candidate.id, run.evaluationReceipts],
  );
  const candidateReceipts = receipts.filter((receipt) => receipt.subject === "candidate");
  const ready = candidateReceipts.length > 0 && candidateReceipts.every(
    (receipt) => receipt.status === "passed" && receipt.publishGate !== "failed",
  );
  const canApply =
    ready &&
    (run.state === "awaiting_promotion" || (run.state === "blocked" && Boolean(run.localProfileCommit)));
  const applying = run.state === "reconciling_release";
  const fileCount = diff?.filesChanged ?? candidate.git?.changedPaths.length ?? 0;

  async function runAction(
    action: "apply" | "reject",
    handler: () => Promise<void>,
  ) {
    if (busyAction) return;
    setBusyAction(action);
    try {
      await handler();
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="labs-change-page">
      {run.blockedReason ? (
        <div className="labs-change-message negative">{run.blockedReason}</div>
      ) : null}

      <div className="labs-change-timeline">
        <article className="labs-change-timeline-item">
          <div className="labs-change-card">
            <header className="labs-change-card-header">
              <span className="labs-change-timeline-label">Request</span>
            </header>
            <div className="labs-change-card-body">
              <h3>{run.objective}</h3>
              <p>This is the behavior the Agent update should improve.</p>
            </div>
          </div>
        </article>

        <article className="labs-change-timeline-item">
          <div className="labs-change-card">
            <header className="labs-change-card-header">
              <span className="labs-change-timeline-label">Changes</span>
              <span>{fileCountLabel(fileCount)}</span>
            </header>
            <div className="labs-change-card-body">
              <h3>Drafted update</h3>
              <p>{candidateChangeSummary(candidate, diff, error)}</p>
            </div>
            <footer className="labs-change-card-footer end">
              <button
                className="training-button secondary"
                disabled={Boolean(error)}
                title={error ?? undefined}
                type="button"
                onClick={onOpenFiles}
              >
                {error ? "Files unavailable" : `Files${fileCount ? ` (${fileCount})` : ""}`}
              </button>
            </footer>
          </div>
        </article>

        <article className="labs-change-timeline-item">
          <div className="labs-change-card">
            <header className="labs-change-card-header">
              <span className="labs-change-timeline-label">Checks</span>
              <span>{evalSummary(candidateReceipts)}</span>
            </header>
            <div className="labs-change-evals">
              {candidateReceipts.length ? candidateReceipts.map((receipt) => (
                <div className="labs-change-eval" key={receipt.id}>
                  <div>
                    <strong>{receipt.summary ?? "Agent checks"}</strong>
                    <span>
                      {receipt.summaryCounts
                        ? `${receipt.summaryCounts.passed}/${receipt.summaryCounts.total} passed`
                        : receipt.status}
                    </span>
                  </div>
                  <LabStatusBadge label={receipt.status} value={receipt.status} />
                </div>
              )) : (
                <div className="labs-change-empty">Agent checks have not finished yet.</div>
              )}
            </div>
          </div>
        </article>

        <article className="labs-change-timeline-item">
          <div className="labs-change-card">
            <header className="labs-change-card-header">
              <span className="labs-change-timeline-label">Apply</span>
            </header>
            <div className="labs-change-card-body">
              <h3>Save this Agent update</h3>
              <p>Applying the update changes the Agent in your Profile, then runs its checks again.</p>
            </div>
            <footer className="labs-change-card-footer">
              <span className="labs-change-footer-status">
                <LabStatusDot
                  label={changeStatusLabel(run)}
                  value={run.state}
                />
                {changeStatusLabel(run)}
              </span>
              <div className="labs-change-actions">
                <button
                  className="training-button secondary"
                  disabled={Boolean(busyAction) || applying || run.state !== "awaiting_promotion"}
                  type="button"
                  onClick={() => void runAction(
                    "reject",
                    () => onRejectCandidate(run, candidate.id),
                  )}
                >
                  {busyAction === "reject" ? "Keeping current version" : "Keep current version"}
                </button>
                <button
                  className="training-button"
                  disabled={!canApply || Boolean(busyAction) || applying}
                  type="button"
                  onClick={() => void runAction(
                    "apply",
                    () => onApplyCandidate(run, candidate.id),
                  )}
                >
                  {applying || busyAction === "apply"
                    ? "Applying"
                    : run.state === "blocked"
                      ? "Re-run checks"
                      : "Apply update"}
                </button>
              </div>
            </footer>
          </div>
        </article>
      </div>
    </div>
  );
}

function fileCountLabel(fileCount: number): string {
  return `${fileCount} ${fileCount === 1 ? "file" : "files"}`;
}

function candidateChangeSummary(
  candidate: CreateImproveCandidate,
  diff: WorkspaceDiffSummary | null,
  error: string | null,
): string {
  if (error) return error;
  const fileCount = diff?.filesChanged ?? candidate.git?.changedPaths.length ?? 0;
  if (!fileCount) return "The drafted Agent update is ready, but no file summary is available yet.";
  if (!diff) return `${fileCountLabel(fileCount)} drafted for this Agent. Open Files to review the changes.`;
  return `${fileCountLabel(fileCount)} drafted · +${diff.additions} −${diff.deletions}`;
}

function evalSummary(receipts: CreateImproveRun["evaluationReceipts"]): string {
  if (!receipts.length) return "Waiting for Agent checks";
  const counts = receipts.reduce(
    (total, receipt) => ({
      passed: total.passed + (receipt.summaryCounts?.passed ?? 0),
      tests: total.tests + (receipt.summaryCounts?.total ?? 0),
    }),
    { passed: 0, tests: 0 },
  );
  if (counts.tests > 0) return `${counts.passed}/${counts.tests} checks passed`;
  const passed = receipts.filter((receipt) => receipt.status === "passed").length;
  return `${passed}/${receipts.length} check results passed`;
}

function changeStatusLabel(run: CreateImproveRun): string {
  if (run.state === "awaiting_promotion") return "Ready to apply";
  if (run.state === "reconciling_release") return "Applying update";
  if (run.state === "released") return "Update applied";
  if (run.state === "rejected") return "Current version kept";
  if (run.state === "blocked") return run.localProfileCommit ? "Needs verification" : "Blocked";
  return run.state.replaceAll("_", " ");
}
