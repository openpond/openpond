import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  HarnessEvaluationReviewReceipt,
  HarnessEvaluationReviewSchedule,
  HarnessHistoryChange,
  HarnessHistoryPayload,
  HarnessHistoryPendingReview,
  HarnessHistoryReleaseSummary,
  RefinerHistoryPayload,
  RefinerRelease,
} from "@openpond/contracts";

import { api, type ClientConnection } from "../../api";
import { ConfirmDialog, useConfirmDialog } from "../common/ConfirmDialog";
import { AppDialog } from "../dialogs/AppDialog";
import { Check, Columns2, Eye, MessageSquare, RotateCcw, X } from "../icons";
import { HarnessEvaluationReviewSettings } from "./HarnessEvaluationReviewSettings";
import type { HarnessReleaseDiffSelection } from "./HarnessReleaseDiffSidebar";
import { RefinerProfileSettings } from "./RefinerProfileSettings";

export type HarnessSettingsPage = "overview" | "refiner" | "continuous-review" | "contents" | "releases";

type Props = {
  connection: ClientConnection | null;
  enabled: boolean;
  page: HarnessSettingsPage;
  onError: (message: string | null) => void;
  onDefaultReleaseDiff: (selection: HarnessReleaseDiffSelection) => void;
  onOpenReleaseDiff: (selection: HarnessReleaseDiffSelection) => void;
  onOpenSourceSession?: (sessionId: string) => void;
  onStartRefinerAuthoring?: (objective: string) => void;
  onAcceptEvaluationReview: (
    workspaceId: string,
    review: { id: string; contentHash: string },
  ) => Promise<boolean>;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
};

const DEFAULT_EVALUATION_REVIEW_SCHEDULE: HarnessEvaluationReviewSchedule = {
  enabled: false,
  activityEnabled: false,
  activityBatchSize: 10,
  cadence: "manual",
  maxEstimatedCostUsd: 0.1,
  nextRunAt: null,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
  updatedAt: null,
};

const PAGE_COPY: Record<HarnessSettingsPage, { title: string; description: string }> = {
  overview: {
    title: "Harness overview",
    description: "Current state, items needing attention, and recent learning activity.",
  },
  refiner: {
    title: "Refiner",
    description: "Validated per-turn improvements and recommendations routed outside the Harness.",
  },
  "continuous-review": {
    title: "Continuous Review",
    description: "Recurring patterns found across completed work and their immutable review receipts.",
  },
  contents: {
    title: "Harness contents",
    description: "The instructions, skills, agents, and memory available in the current release.",
  },
  releases: {
    title: "Harness releases",
    description: "Immutable versions, diffs, and rollback controls.",
  },
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function shortHash(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "none";
}

function releaseDiffSelection(
  workspaceId: string,
  baseRelease: HarnessHistoryReleaseSummary | null,
  targetRelease: HarnessHistoryReleaseSummary,
): HarnessReleaseDiffSelection {
  return {
    workspaceId,
    baseRelease: baseRelease ? { id: baseRelease.id, contentHash: baseRelease.contentHash } : null,
    targetRelease: { id: targetRelease.id, contentHash: targetRelease.contentHash },
    title: targetRelease.current ? "Current Harness release" : `Harness release ${shortHash(targetRelease.contentHash)}`,
  };
}

function PendingReviewCard({
  review,
  busy,
  onReview,
}: {
  review: HarnessHistoryPendingReview;
  busy: boolean;
  onReview: (review: HarnessHistoryPendingReview, decision: "approve" | "decline") => void;
}) {
  return (
    <article className="harness-history-card harness-review-card">
      <header>
        <div>
          <div className="harness-history-kicker">
            <span className="harness-status harness-status-retained">review required</span>
            <span>{review.proposal.route} · {review.proposal.edits[0]?.operation ?? "change"}</span>
          </div>
          <h2>{review.proposal.expectedOutcome}</h2>
        </div>
        <time>{formatDate(review.proposal.createdAt)}</time>
      </header>
      <p>{review.proposal.edits.map((edit) => edit.summary).join(" ")}</p>
      <details className="harness-history-details">
        <summary>Exact edits ({review.proposal.edits.length})</summary>
        <div className="harness-edit-list">
          {review.proposal.edits.map((edit) => (
            <section className="harness-edit" key={edit.id}>
              <div><strong>{edit.operation} · {edit.target}</strong><span>{edit.summary}</span></div>
              {edit.content !== null ? <pre>{edit.content}</pre> : <p>File deleted.</p>}
            </section>
          ))}
        </div>
      </details>
      {review.validations.length ? (
        <details className="harness-history-details">
          <summary>Validation receipts ({review.validations.length})</summary>
          <div className="harness-validation-list">
            {review.validations.map((validation) => (
              <div key={validation.id}>
                <span className={`harness-validation-status ${validation.status}`}>{validation.status}</span>
                <strong>{validation.kind.replaceAll("_", " ")}</strong>
                <span>{validation.summary}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      <footer className="harness-review-actions">
        <button className="settings-secondary compact" disabled={busy} onClick={() => onReview(review, "decline")} type="button"><X size={13} /> Decline</button>
        <button
          className="settings-primary compact"
          disabled={busy || review.validations.some((item) => item.status !== "passed")}
          onClick={() => onReview(review, "approve")}
          type="button"
        >
          <Check size={13} /> Approve and release
        </button>
      </footer>
    </article>
  );
}

function RefinerChangeDetailsDialog({
  change,
  onClose,
}: {
  change: HarnessHistoryChange;
  onClose: () => void;
}) {
  const proposal = change.proposal;
  return (
    <AppDialog
      ariaLabel="Refiner change details"
      backdropClassName="harness-details-dialog-backdrop"
      className="harness-details-dialog"
      onClose={onClose}
    >
      <header>
        <div>
          <span className={`harness-status harness-status-${change.receipt.decision}`}>{change.receipt.decision.replaceAll("_", " ")}</span>
          <h2>{proposal?.expectedOutcome ?? change.receipt.reason}</h2>
          <p>{change.receipt.reason}</p>
        </div>
        <button aria-label="Close change details" onClick={onClose} type="button"><X size={16} /></button>
      </header>
      <div className="harness-details-dialog-body">
        {proposal?.edits.length ? (
          <section>
            <h3>Exact edits</h3>
            <div className="harness-edit-list">
              {proposal.edits.map((edit) => (
                <article className="harness-edit" key={edit.id}>
                  <div><strong>{edit.operation} · {edit.target}</strong><span>{edit.summary}</span></div>
                  {edit.content !== null ? <pre>{edit.content}</pre> : <p>File deleted.</p>}
                </article>
              ))}
            </div>
          </section>
        ) : null}
        {change.validations.length ? (
          <section>
            <h3>Validation</h3>
            <div className="harness-validation-list">
              {change.validations.map((validation) => (
                <div key={validation.id}>
                  <span className={`harness-validation-status ${validation.status}`}>{validation.status}</span>
                  <strong>{validation.kind.replaceAll("_", " ")}</strong>
                  <span>{validation.summary}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </AppDialog>
  );
}

function OverviewPage({
  history,
  reviewingProposalId,
  onReviewProposal,
}: {
  history: HarnessHistoryPayload;
  reviewingProposalId: string | null;
  onReviewProposal: (review: HarnessHistoryPendingReview, decision: "approve" | "decline") => void;
}) {
  const recent = useMemo(() => [
    ...history.changes.map((change) => ({
      id: `change:${change.receipt.id}`,
      at: change.receipt.createdAt,
      kind: "Refiner",
      title: change.proposal?.expectedOutcome ?? change.receipt.reason,
      detail: change.receipt.decision.replaceAll("_", " "),
    })),
    ...history.routes.map((route) => ({
      id: `route:${route.decision.id}`,
      at: route.decision.createdAt,
      kind: "Routed",
      title: route.decision.reason,
      detail: route.decision.route,
    })),
    ...history.evaluationReviews.map((review) => ({
      id: `review:${review.id}`,
      at: review.createdAt,
      kind: "Continuous Review",
      title: review.claim?.statement ?? review.reason,
      detail: review.classification.replaceAll("_", " "),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6), [history]);

  return (
    <div className="harness-page-sections">
      {history.pendingReviews.length ? (
        <section className="harness-history-section">
          <div className="harness-section-heading"><div><h2>Needs review</h2><p>Sensitive or high-impact proposals require your approval.</p></div><span>{history.pendingReviews.length}</span></div>
          {history.pendingReviews.map((review) => (
            <PendingReviewCard busy={reviewingProposalId !== null} key={`${review.proposal.id}:${review.proposal.contentHash}`} onReview={onReviewProposal} review={review} />
          ))}
        </section>
      ) : null}

      <section className="harness-history-section">
        <div className="harness-section-heading"><div><h2>Recent activity</h2><p>The latest events from both learning loops.</p></div><span>{recent.length}</span></div>
        {recent.length ? (
          <div className="harness-activity-list">
            {recent.map((item) => (
              <article key={item.id}><span>{item.kind}</span><div><strong>{item.title}</strong><small>{item.detail}</small></div><time>{formatDate(item.at)}</time></article>
            ))}
          </div>
        ) : <div className="harness-empty compact">No Harness learning activity yet.</div>}
      </section>
    </div>
  );
}

function RefinerPage({
  history,
  refiner,
  busyReleaseHash,
  onRequestRefinerRelease,
  onStartRefinerAuthoring,
  onOpenChangeDiff,
  onOpenSourceSession,
}: {
  history: HarnessHistoryPayload;
  refiner: RefinerHistoryPayload;
  busyReleaseHash: string | null;
  onRequestRefinerRelease: (release: RefinerRelease, operation: "activate" | "rollback") => void;
  onStartRefinerAuthoring?: (objective: string) => void;
  onOpenChangeDiff: (change: HarnessHistoryChange) => void;
  onOpenSourceSession?: (sessionId: string) => void;
}) {
  const [detailsChange, setDetailsChange] = useState<HarnessHistoryChange | null>(null);
  return (
    <div className="harness-page-sections">
      <RefinerProfileSettings
        busyReleaseHash={busyReleaseHash}
        history={refiner}
        onRequestRelease={onRequestRefinerRelease}
        onStartAuthoring={onStartRefinerAuthoring}
      />
      <section className="harness-history-section">
        <div className="harness-section-heading"><div><h2>Applied changes</h2><p>Every release transition with exact edits and validation receipts.</p></div><span>{history.changes.length}</span></div>
        {history.changes.length ? (
          <div className="harness-table-wrap">
            <table className="harness-table harness-refiner-table">
              <thead><tr><th>Change</th><th>Target</th><th>Release</th><th>Created</th><th>Result</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {history.changes.map((change) => {
                  const sourceSession = change.trigger?.runRef ?? null;
                  const proposal = change.proposal;
                  return (
                    <tr key={`${change.receipt.id}:${change.receipt.contentHash}`}>
                      <td><strong>{proposal?.expectedOutcome ?? change.receipt.reason}</strong></td>
                      <td><code>{proposal?.edits[0]?.target ?? proposal?.route ?? "workspace"}</code></td>
                      <td><code>{shortHash(change.receipt.nextRelease?.contentHash)}</code></td>
                      <td>{formatDate(change.receipt.createdAt)}</td>
                      <td><span className={`harness-status harness-status-${change.receipt.decision}`}>{change.receipt.decision.replaceAll("_", " ")}</span></td>
                      <td>
                        <div className="harness-inline-actions">
                          <button aria-label="View evidence and exact edits" className="harness-table-icon-action" onClick={() => setDetailsChange(change)} title="View evidence and exact edits" type="button"><Eye size={14} /></button>
                          {change.receipt.nextRelease ? <button aria-label="View release diff" className="harness-table-icon-action" onClick={() => onOpenChangeDiff(change)} title="View release diff" type="button"><Columns2 size={14} /></button> : null}
                          {sourceSession && onOpenSourceSession ? <button aria-label="Open source conversation" className="harness-table-icon-action" onClick={() => onOpenSourceSession(sourceSession)} title="Open source conversation" type="button"><MessageSquare size={14} /></button> : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <div className="harness-empty compact">No Harness changes have been applied.</div>}
      </section>
      <section className="harness-history-section">
        <div className="harness-section-heading"><div><h2>Routed recommendations</h2><p>Observations sent to runtime, product, Tasksets, or training without mutating the Harness.</p></div><span>{history.routes.length}</span></div>
        {history.routes.length ? (
          <div className="harness-table-wrap"><table className="harness-table harness-route-table"><thead><tr><th>Recommendation</th><th>Source evidence</th><th>Created</th><th>Route</th></tr></thead><tbody>{history.routes.map((route) => <tr key={`${route.decision.id}:${route.decision.contentHash}`}><td><p>{route.decision.reason}</p></td><td><p>{route.trigger?.reason ?? "Completed work"}</p></td><td>{formatDate(route.decision.createdAt)}</td><td><span className="harness-status">{route.decision.route}</span></td></tr>)}</tbody></table></div>
        ) : <div className="harness-empty compact">No recommendations have been routed.</div>}
      </section>
      {detailsChange ? <RefinerChangeDetailsDialog change={detailsChange} onClose={() => setDetailsChange(null)} /> : null}
    </div>
  );
}

function contentKind(path: string): string {
  if (path.includes("/skills/") || path.startsWith("skills/")) return "Skill";
  if (path.includes("/agents/") || path.startsWith("agents/")) return "Agent";
  if (path.includes("memory")) return "Memory";
  if (path.endsWith(".md")) return "Instruction";
  return "File";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value < 10_240 ? 1 : 0)} KB`;
}

function ContentsPage({ history, onOpenCurrentRelease }: { history: HarnessHistoryPayload; onOpenCurrentRelease: () => void }) {
  const currentRelease = history.releases.find((release) => release.current) ?? history.releases[0] ?? null;
  return (
    <div className="harness-page-sections">
      <section className="harness-history-section">
        <div className="harness-section-heading">
          <div><h2>Current release</h2><p>Read-only source contents currently supplied by the Personal Harness.</p></div>
          {currentRelease ? <button className="settings-secondary compact" onClick={onOpenCurrentRelease} type="button">View release diff</button> : null}
        </div>
        {currentRelease?.files.length ? (
          <div className="harness-table-wrap">
            <table className="harness-table">
              <thead><tr><th>Type</th><th>Source</th><th>Size</th><th>Revision</th></tr></thead>
              <tbody>
                {currentRelease.files.map((file) => (
                  <tr key={file.id}><td><span className="harness-status">{contentKind(file.path)}</span></td><td><code>{file.path}</code></td><td>{formatBytes(file.sizeBytes)}</td><td><code>{shortHash(file.contentHash)}</code></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="harness-empty compact">The current release has no source files.</div>}
      </section>
      <section className="harness-history-section">
        <div className="harness-section-heading"><div><h2>Memory</h2><p>Bounded memory available through search; it is not copied into every prompt.</p></div><span>{history.memories.length}</span></div>
        <div className="harness-disclosure-list">
          {history.memories.length ? history.memories.map((entry) => (
            <details className="harness-disclosure-row" key={`${entry.id}:${entry.revision}`}>
              <summary><span className="harness-status">Memory</span><strong>{entry.key}</strong><small>revision {entry.revision}</small><time>{formatDate(entry.updatedAt)}</time></summary>
              <div className="harness-disclosure-body"><p>{entry.content}</p>{entry.tags.length ? <small>{entry.tags.join(" · ")}</small> : null}</div>
            </details>
          )) : <div className="harness-empty compact">No Harness memory has been saved.</div>}
        </div>
      </section>
    </div>
  );
}

function ReleasesPage({
  busy,
  history,
  onOpenDiff,
  onRequestRollback,
}: {
  busy: boolean;
  history: HarnessHistoryPayload;
  onOpenDiff: (baseRelease: HarnessHistoryReleaseSummary | null, release: HarnessHistoryReleaseSummary) => void;
  onRequestRollback: (release: HarnessHistoryReleaseSummary) => void;
}) {
  return (
    <section className="harness-history-section">
      <div className="harness-section-heading"><div><h2>Release history</h2><p>New work uses the current release; active runs stay pinned to the version they started with.</p></div><span>{history.releases.length}</span></div>
      {history.releases.length ? (
        <div className="harness-table-wrap">
          <table className="harness-table harness-release-table">
            <thead><tr><th>Release</th><th>Contents</th><th>Created</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {history.releases.map((release, index) => (
                <tr key={`${release.id}:${release.contentHash}`}>
                  <td><div className="harness-release-identity"><strong>{release.id}</strong><code>{shortHash(release.contentHash)}</code></div></td>
                  <td>{release.files.length} files</td>
                  <td>{formatDate(release.createdAt)}</td>
                  <td>{release.current ? <span className="harness-current-pill">Current</span> : <span className="harness-status">Previous</span>}</td>
                  <td>
                    <div className="harness-inline-actions">
                      <button aria-label="View release changes" className="harness-table-icon-action" onClick={() => onOpenDiff(history.releases[index + 1] ?? null, release)} title="View release changes" type="button"><Columns2 size={14} /></button>
                      {!release.current ? <button aria-label="Roll back to release" className="harness-table-icon-action" disabled={busy} onClick={() => onRequestRollback(release)} title="Roll back to release" type="button"><RotateCcw size={14} /></button> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="harness-empty compact">No Harness releases exist yet.</div>}
    </section>
  );
}

export function HarnessHistorySettingsSection({
  connection,
  enabled,
  onAcceptEvaluationReview,
  onError,
  onDefaultReleaseDiff,
  onOpenReleaseDiff,
  onOpenSourceSession,
  onStartRefinerAuthoring,
  onToast,
  page,
}: Props) {
  const [history, setHistory] = useState<HarnessHistoryPayload | null>(null);
  const [refinerHistory, setRefinerHistory] = useState<RefinerHistoryPayload | null>(null);
  const [refinerRollbackHash, setRefinerRollbackHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rollbackHash, setRollbackHash] = useState<string | null>(null);
  const [reviewingProposalId, setReviewingProposalId] = useState<string | null>(null);
  const [savingLoopSettings, setSavingLoopSettings] = useState(false);
  const [reviewingEvaluation, setReviewingEvaluation] = useState(false);
  const [acceptingEvaluationReviewId, setAcceptingEvaluationReviewId] = useState<string | null>(null);
  const { confirmAction, confirmDialog, resolveConfirmDialog } = useConfirmDialog();
  const continuousReviewEnabled = Boolean(
    history?.evaluationReviewSchedule.activityEnabled || history?.evaluationReviewSchedule.enabled,
  );
  const [refinerDraftEnabled, setRefinerDraftEnabled] = useState(false);
  const [continuousReviewDraftEnabled, setContinuousReviewDraftEnabled] = useState(false);

  useEffect(() => {
    if (history) setRefinerDraftEnabled(history.backgroundReview.enabled);
  }, [history?.backgroundReview.enabled]);

  useEffect(() => {
    setContinuousReviewDraftEnabled(continuousReviewEnabled);
  }, [continuousReviewEnabled]);

  const refresh = useCallback(async () => {
    if (!connection) return;
    setLoading(true);
    try {
      const [payload, refinerPayload] = await Promise.all([
        api.harnessHistory(connection),
        api.refinerHistory(connection),
      ]);
      setHistory(payload);
      setRefinerHistory(refinerPayload);
      const currentIndex = payload.releases.findIndex((release) => release.current);
      const currentRelease = currentIndex >= 0 ? payload.releases[currentIndex] : null;
      if (payload.workspace && currentRelease) {
        onDefaultReleaseDiff(releaseDiffSelection(payload.workspace.id, payload.releases[currentIndex + 1] ?? null, currentRelease));
      }
      onError(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [connection, onDefaultReleaseDiff, onError]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, page, refresh]);

  const reviewEvaluation = useCallback(async (maxEstimatedCostUsd: number) => {
    if (!connection || !history?.workspace) return;
    setReviewingEvaluation(true);
    try {
      const response = await api.reviewHarnessEvaluation(connection, { workspaceId: history.workspace.id, maxEstimatedCostUsd });
      setHistory(response.history);
      onError(null);
      onToast?.(`Continuous Review completed: ${response.receipt.classification.replaceAll("_", " ")}.`, "success");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setReviewingEvaluation(false);
    }
  }, [connection, history, onError, onToast]);

  const saveLoopSettings = useCallback(async (
    scope: "refiner" | "continuous-review",
    refinerEnabled: boolean,
    continuousReviewEnabled: boolean,
  ) => {
    if (!connection || !history?.workspace) return;
    setSavingLoopSettings(true);
    try {
      let nextHistory = history;
      if (scope === "refiner" && refinerEnabled !== history.backgroundReview.enabled) {
        const response = await api.updateHarnessBackgroundReview(connection, { workspaceId: history.workspace.id, enabled: refinerEnabled });
        nextHistory = response.history;
      }
      const currentlyEnabled = history.evaluationReviewSchedule.activityEnabled || history.evaluationReviewSchedule.enabled;
      if (scope === "continuous-review" && (continuousReviewEnabled !== currentlyEnabled || history.evaluationReviewSchedule.enabled)) {
        const schedule = history.evaluationReviewSchedule;
        const response = await api.updateHarnessEvaluationReviewSchedule(connection, {
          workspaceId: history.workspace.id,
          enabled: false,
          activityEnabled: continuousReviewEnabled,
          activityBatchSize: schedule.activityBatchSize,
          cadence: "manual",
          maxEstimatedCostUsd: schedule.maxEstimatedCostUsd,
        });
        nextHistory = response.history;
      }
      setHistory(nextHistory);
      onError(null);
      onToast?.(`${scope === "refiner" ? "Refiner" : "Continuous Review"} settings applied.`, "success");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingLoopSettings(false);
    }
  }, [connection, history, onError, onToast]);

  const acceptEvaluationReview = useCallback(async (review: HarnessEvaluationReviewReceipt) => {
    if (!history?.workspace) return;
    setAcceptingEvaluationReviewId(review.id);
    try {
      const accepted = await onAcceptEvaluationReview(history.workspace.id, { id: review.id, contentHash: review.contentHash });
      if (accepted) {
        onError(null);
        onToast?.("Taskset review opened in Models.", "success");
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setAcceptingEvaluationReviewId(null);
    }
  }, [history?.workspace, onAcceptEvaluationReview, onError, onToast]);

  const openReleaseDiff = useCallback((baseRelease: HarnessHistoryReleaseSummary | null, targetRelease: HarnessHistoryReleaseSummary) => {
    if (!history?.workspace) return;
    onOpenReleaseDiff(releaseDiffSelection(history.workspace.id, baseRelease, targetRelease));
  }, [history?.workspace, onOpenReleaseDiff]);

  const openChangeDiff = useCallback((change: HarnessHistoryChange) => {
    if (!history?.workspace || !change.receipt.nextRelease) return;
    onOpenReleaseDiff({ workspaceId: history.workspace.id, baseRelease: change.receipt.previousRelease, targetRelease: change.receipt.nextRelease, title: change.proposal?.expectedOutcome ?? change.receipt.reason });
  }, [history?.workspace, onOpenReleaseDiff]);

  const rollback = useCallback(async (release: HarnessHistoryReleaseSummary) => {
    if (!connection || !history?.workspace) return;
    setRollbackHash(release.contentHash);
    try {
      const response = await api.rollbackHarness(connection, { workspaceId: history.workspace.id, targetRelease: { id: release.id, contentHash: release.contentHash } });
      setHistory(response.history);
      onError(null);
      onToast?.("Personal Harness rolled back. Existing runs remain pinned.", "success");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setRollbackHash(null);
    }
  }, [connection, history?.workspace, onError, onToast]);

  const requestRollback = useCallback(async (release: HarnessHistoryReleaseSummary) => {
    const confirmed = await confirmAction({
      title: "Roll back Harness release?",
      body: `New work will use ${shortHash(release.contentHash)}. Active runs remain pinned to their current release.`,
      confirmLabel: "Roll back",
    });
    if (confirmed) await rollback(release);
  }, [confirmAction, rollback]);

  const requestRefinerRelease = useCallback(async (release: RefinerRelease, operation: "activate" | "rollback") => {
    if (!connection) return;
    const confirmed = await confirmAction({
      title: operation === "activate" ? "Activate Refiner release?" : "Roll back Refiner release?",
      body: `Future reviews will use ${release.profile.name} at ${shortHash(release.contentHash)}. Existing work remains pinned.`,
      confirmLabel: operation === "activate" ? "Activate" : "Roll back",
    });
    if (!confirmed) return;
    setRefinerRollbackHash(release.contentHash);
    try {
      const request = {
        release: { id: release.id, contentHash: release.contentHash },
        reason: `${operation === "activate" ? "Activate" : "Rollback"} from Settings to ${release.profile.id}@${release.profile.version}.`,
        actor: "settings-user",
      };
      setRefinerHistory(await (operation === "activate"
        ? api.activateRefinerRelease(connection, request)
        : api.rollbackRefinerRelease(connection, request)));
      onError(null);
      onToast?.(`Refiner ${operation === "activate" ? "activated" : "rolled back"}. Existing work remains pinned.`, "success");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setRefinerRollbackHash(null);
    }
  }, [confirmAction, connection, onError, onToast]);

  const reviewProposal = useCallback(async (review: HarnessHistoryPendingReview, decision: "approve" | "decline") => {
    if (!connection || !history?.workspace) return;
    setReviewingProposalId(review.proposal.id);
    try {
      const response = await api.reviewHarnessProposal(connection, { workspaceId: history.workspace.id, proposal: { id: review.proposal.id, contentHash: review.proposal.contentHash }, decision });
      setHistory(response.history);
      onError(null);
      onToast?.(decision === "approve" ? "Harness proposal approved and released." : "Harness proposal declined.", decision === "approve" ? "success" : "info");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setReviewingProposalId(null);
    }
  }, [connection, history?.workspace, onError, onToast]);

  const currentRelease = history?.releases.find((release) => release.current) ?? history?.releases[0] ?? null;
  const currentIndex = currentRelease ? history?.releases.indexOf(currentRelease) ?? -1 : -1;
  const copy = PAGE_COPY[page];
  const loopSettingsDirty = history ? (
    page === "refiner"
      ? refinerDraftEnabled !== history.backgroundReview.enabled
      : continuousReviewDraftEnabled !== continuousReviewEnabled || history.evaluationReviewSchedule.enabled
  ) : false;
  const showLoopActions = page === "refiner" || page === "continuous-review";

  return (
    <section className="account-settings harness-history-settings" aria-labelledby="harness-history-title">
      <div className="account-settings-title harness-page-title">
        <div><h1 id="harness-history-title">{copy.title}</h1><p>{copy.description}</p></div>
        {history?.workspace && showLoopActions ? (
          <div className="harness-page-header-actions">
            {page === "continuous-review" ? <button className="settings-secondary compact" disabled={reviewingEvaluation} onClick={() => void reviewEvaluation(history.evaluationReviewSchedule.maxEstimatedCostUsd)} type="button">{reviewingEvaluation ? "Reviewing…" : "Review now"}</button> : null}
            <label className="harness-page-toggle">
              <span>{page === "refiner" ? (refinerDraftEnabled ? "On" : "Off") : (continuousReviewDraftEnabled ? "On" : "Off")}</span>
              <span className="provider-toggle">
                <input
                  aria-label={page === "refiner" ? "Enable Refiner" : "Enable Continuous Review"}
                  checked={page === "refiner" ? refinerDraftEnabled : continuousReviewDraftEnabled}
                  disabled={savingLoopSettings}
                  onChange={(event) => page === "refiner" ? setRefinerDraftEnabled(event.target.checked) : setContinuousReviewDraftEnabled(event.target.checked)}
                  type="checkbox"
                />
                <span aria-hidden="true" />
              </span>
            </label>
            <button className="settings-primary compact" disabled={savingLoopSettings || !loopSettingsDirty} onClick={() => void saveLoopSettings(page, refinerDraftEnabled, continuousReviewDraftEnabled)} type="button">{savingLoopSettings ? "Applying…" : "Apply changes"}</button>
          </div>
        ) : null}
      </div>

      {!connection ? <div className="harness-empty">Connect to the Local OpenPond server to inspect the Harness.</div> : null}
      {connection && loading && !history ? <div className="harness-empty">Loading Harness history…</div> : null}
      {history && !history.workspace ? <div className="harness-empty">No Personal Harness workspace has been created yet.</div> : null}

      {history?.workspace && page === "overview" ? <OverviewPage history={history} onReviewProposal={reviewProposal} reviewingProposalId={reviewingProposalId} /> : null}
      {history && refinerHistory && page === "refiner" ? <RefinerPage busyReleaseHash={refinerRollbackHash} history={history} refiner={refinerHistory} onOpenChangeDiff={openChangeDiff} onOpenSourceSession={onOpenSourceSession} onRequestRefinerRelease={(release, operation) => void requestRefinerRelease(release, operation)} onStartRefinerAuthoring={onStartRefinerAuthoring} /> : null}
      {history?.workspace && page === "continuous-review" ? (
        <HarnessEvaluationReviewSettings
          acceptingReviewId={acceptingEvaluationReviewId}
          candidates={history.refinementCandidates}
          onAcceptTasksetReview={(review) => void acceptEvaluationReview(review)}
          qualifications={history.modelImprovementQualifications}
          reviews={history.evaluationReviews}
          schedule={history.evaluationReviewSchedule ?? DEFAULT_EVALUATION_REVIEW_SCHEDULE}
        />
      ) : null}
      {history?.workspace && page === "contents" ? (
        <ContentsPage
          history={history}
          onOpenCurrentRelease={() => {
            if (currentRelease) openReleaseDiff(currentIndex >= 0 ? history.releases[currentIndex + 1] ?? null : null, currentRelease);
          }}
        />
      ) : null}
      {history?.workspace && page === "releases" ? <ReleasesPage busy={rollbackHash !== null} history={history} onOpenDiff={openReleaseDiff} onRequestRollback={(release) => void requestRollback(release)} /> : null}

      <ConfirmDialog onResolve={resolveConfirmDialog} state={confirmDialog} />
    </section>
  );
}
