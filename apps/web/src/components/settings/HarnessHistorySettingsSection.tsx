import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  HarnessHistoryChange,
  HarnessHistoryPayload,
  HarnessHistoryPendingReview,
  HarnessHistoryReleaseSummary,
  HarnessHistoryRoute,
} from "@openpond/contracts";

import { api, type ClientConnection } from "../../api";
import { Check, RefreshCw, RotateCcw, X } from "../icons";

type Props = {
  connection: ClientConnection | null;
  enabled: boolean;
  onError: (message: string | null) => void;
  onOpenSourceSession?: (sessionId: string) => void;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function shortHash(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "none";
}

function HistoryChangeCard({
  change,
  onOpenSourceSession,
}: {
  change: HarnessHistoryChange;
  onOpenSourceSession?: (sessionId: string) => void;
}) {
  const sourceSession = change.trigger?.runRef ?? null;
  const proposal = change.proposal;
  return (
    <article className="harness-history-card">
      <header>
        <div>
          <div className="harness-history-kicker">
            <span className={`harness-status harness-status-${change.receipt.decision}`}>
              {change.receipt.decision.replaceAll("_", " ")}
            </span>
            <span>{proposal?.route ?? (change.receipt.rollbackOf ? "rollback" : "workspace")}</span>
          </div>
          <h2>{proposal?.expectedOutcome ?? change.receipt.reason}</h2>
        </div>
        <time>{formatDate(change.receipt.createdAt)}</time>
      </header>

      <div className="harness-history-release-flow">
        <code>{shortHash(change.receipt.previousRelease?.contentHash)}</code>
        <span aria-hidden="true">→</span>
        <code>{shortHash(change.receipt.nextRelease?.contentHash)}</code>
        <span>channel {change.receipt.previousChannelRevision} → {change.receipt.nextChannelRevision}</span>
      </div>

      <p>{change.receipt.reason}</p>

      {sourceSession && onOpenSourceSession ? (
        <button
          className="settings-secondary compact"
          onClick={() => onOpenSourceSession(sourceSession)}
          type="button"
        >
          Open source conversation
        </button>
      ) : null}

      {proposal ? (
        <details className="harness-history-details">
          <summary>Review {proposal.edits.length} exact edit{proposal.edits.length === 1 ? "" : "s"}</summary>
          <div className="harness-edit-list">
            {proposal.edits.map((edit) => (
              <section className="harness-edit" key={edit.id}>
                <div>
                  <strong>{edit.operation} · {edit.target}</strong>
                  <span>{edit.summary}</span>
                </div>
                {edit.content !== null ? <pre>{edit.content}</pre> : <p>File deleted.</p>}
              </section>
            ))}
          </div>
        </details>
      ) : null}

      {change.validations.length ? (
        <div className="harness-validation-list">
          {change.validations.map((validation) => (
            <div key={validation.id}>
              <span className={`harness-validation-status ${validation.status}`}>
                {validation.status}
              </span>
              <strong>{validation.kind.replaceAll("_", " ")}</strong>
              <span>{validation.summary}</span>
            </div>
          ))}
        </div>
      ) : null}

      {change.outcome ? (
        <footer>
          <span>Refiner: {change.outcome.decision.replaceAll("_", " ")}</span>
          <span>Estimated cost ${change.outcome.estimatedCostUsd.toFixed(4)}</span>
        </footer>
      ) : null}
    </article>
  );
}

function RouteCard({ route }: { route: HarnessHistoryRoute }) {
  return (
    <article className="harness-route-card">
      <div>
        <span className="harness-status harness-status-retained">recommendation</span>
        <strong>{route.decision.route}</strong>
        <time>{formatDate(route.decision.createdAt)}</time>
      </div>
      <p>{route.decision.reason}</p>
      {route.trigger ? <small>Triggered by {route.trigger.reason}</small> : null}
    </article>
  );
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
      <details className="harness-history-details" open>
        <summary>Review {review.proposal.edits.length} exact edit{review.proposal.edits.length === 1 ? "" : "s"}</summary>
        <div className="harness-edit-list">
          {review.proposal.edits.map((edit) => (
            <section className="harness-edit" key={edit.id}>
              <div><strong>{edit.operation} · {edit.target}</strong><span>{edit.summary}</span></div>
              {edit.content !== null ? <pre>{edit.content}</pre> : <p>File deleted.</p>}
            </section>
          ))}
        </div>
      </details>
      <div className="harness-validation-list">
        {review.validations.map((validation) => (
          <div key={validation.id}>
            <span className={`harness-validation-status ${validation.status}`}>{validation.status}</span>
            <strong>{validation.kind.replaceAll("_", " ")}</strong>
            <span>{validation.summary}</span>
          </div>
        ))}
      </div>
      <footer className="harness-review-actions">
        <button className="settings-secondary compact" disabled={busy} onClick={() => onReview(review, "decline")} type="button">
          <X size={13} /> Decline
        </button>
        <button className="settings-primary compact" disabled={busy || review.validations.some((item) => item.status !== "passed")} onClick={() => onReview(review, "approve")} type="button">
          <Check size={13} /> Approve and release
        </button>
      </footer>
    </article>
  );
}

function ReleaseRow({
  release,
  busy,
  onRollback,
}: {
  release: HarnessHistoryReleaseSummary;
  busy: boolean;
  onRollback: (release: HarnessHistoryReleaseSummary) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="harness-release-row">
      <div>
        <strong>{release.current ? "Current release" : release.id}</strong>
        <span>{shortHash(release.contentHash)} · {release.files.length} files · {formatDate(release.createdAt)}</span>
      </div>
      {release.current ? (
        <span className="harness-current-pill">current</span>
      ) : confirming ? (
        <div className="harness-inline-actions">
          <button className="settings-secondary compact" disabled={busy} onClick={() => setConfirming(false)} type="button">
            <X size={13} /> Cancel
          </button>
          <button className="settings-primary compact" disabled={busy} onClick={() => onRollback(release)} type="button">
            <RotateCcw size={13} /> Confirm rollback
          </button>
        </div>
      ) : (
        <button
          className="settings-secondary compact"
          disabled={busy}
          onClick={() => setConfirming(true)}
          type="button"
        >
          <RotateCcw size={13} /> Roll back
        </button>
      )}
    </div>
  );
}

export function HarnessHistorySettingsSection({
  connection,
  enabled,
  onError,
  onOpenSourceSession,
  onToast,
}: Props) {
  const [history, setHistory] = useState<HarnessHistoryPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [rollbackHash, setRollbackHash] = useState<string | null>(null);
  const [reviewingProposalId, setReviewingProposalId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!connection) return;
    setLoading(true);
    try {
      setHistory(await api.harnessHistory(connection));
      onError(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [connection, onError]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const current = useMemo(
    () => history?.releases.find((release) => release.current) ?? null,
    [history],
  );

  const rollback = useCallback(async (release: HarnessHistoryReleaseSummary) => {
    if (!connection || !history?.workspace) return;
    setRollbackHash(release.contentHash);
    try {
      const response = await api.rollbackHarness(connection, {
        workspaceId: history.workspace.id,
        targetRelease: { id: release.id, contentHash: release.contentHash },
      });
      setHistory(response.history);
      onError(null);
      onToast?.("Personal Harness rolled back. Existing runs remain pinned.", "success");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setRollbackHash(null);
    }
  }, [connection, history?.workspace, onError, onToast]);

  const reviewProposal = useCallback(async (
    review: HarnessHistoryPendingReview,
    decision: "approve" | "decline",
  ) => {
    if (!connection || !history?.workspace) return;
    setReviewingProposalId(review.proposal.id);
    try {
      const response = await api.reviewHarnessProposal(connection, {
        workspaceId: history.workspace.id,
        proposal: { id: review.proposal.id, contentHash: review.proposal.contentHash },
        decision,
      });
      setHistory(response.history);
      onError(null);
      onToast?.(
        decision === "approve" ? "Harness proposal approved and released." : "Harness proposal declined.",
        decision === "approve" ? "success" : "info",
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setReviewingProposalId(null);
    }
  }, [connection, history?.workspace, onError, onToast]);

  return (
    <section className="account-settings harness-history-settings" aria-labelledby="harness-history-title">
      <div className="account-settings-title">
        <div>
          <h1 id="harness-history-title">Harness</h1>
          <p>Immutable releases, Refiner changes, validation evidence, and rollback history.</p>
        </div>
        <button className="settings-secondary" disabled={loading} onClick={() => void refresh()} type="button">
          <RefreshCw className={loading ? "settings-spin" : undefined} size={14} /> Refresh
        </button>
      </div>

      {!connection ? <div className="harness-empty">Connect to the Local OpenPond server to inspect the Harness.</div> : null}
      {connection && loading && !history ? <div className="harness-empty">Loading Harness history…</div> : null}
      {history && !history.workspace ? <div className="harness-empty">No Personal Harness workspace has been created yet.</div> : null}

      {history?.workspace ? (
        <>
          <section className="harness-summary-grid">
            <div><span>Workspace</span><strong>{history.workspace.name}</strong></div>
            <div><span>Current release</span><strong>{shortHash(current?.contentHash)}</strong></div>
            <div><span>Channel revision</span><strong>{history.workspace.currentChannel.revision}</strong></div>
            <div><span>Status</span><strong>{history.workspace.dirty ? "Unreleased changes" : "Clean"}</strong></div>
          </section>

          <section className="account-list">
            <div className="account-list-heading"><span>Releases</span><small>New runs use current; active runs stay pinned.</small></div>
            {history.releases.map((release) => (
              <ReleaseRow
                busy={rollbackHash !== null}
                key={`${release.id}:${release.contentHash}`}
                onRollback={rollback}
                release={release}
              />
            ))}
          </section>

          <section className="harness-history-section">
            <div className="harness-section-heading">
              <div><h2>Needs review</h2><p>Executable, Agent, destructive, and sensitive changes never advance without your approval.</p></div>
              <span>{history.pendingReviews.length}</span>
            </div>
            {history.pendingReviews.length ? history.pendingReviews.map((review) => (
              <PendingReviewCard
                busy={reviewingProposalId !== null}
                key={`${review.proposal.id}:${review.proposal.contentHash}`}
                onReview={reviewProposal}
                review={review}
              />
            )) : <div className="harness-empty">No Harness proposals need review.</div>}
          </section>

          <section className="harness-history-section">
            <div className="harness-section-heading">
              <div><h2>Applied history</h2><p>Every release transition with its exact change and validation receipts.</p></div>
              <span>{history.changes.length}</span>
            </div>
            {history.changes.length ? history.changes.map((change) => (
              <HistoryChangeCard
                change={change}
                key={`${change.receipt.id}:${change.receipt.contentHash}`}
                onOpenSourceSession={onOpenSourceSession}
              />
            )) : <div className="harness-empty">No Harness changes have been applied.</div>}
          </section>

          <section className="harness-history-section">
            <div className="harness-section-heading">
              <div><h2>Routed recommendations</h2><p>Runtime, memory, product, Taskset, and training observations that did not mutate the Harness.</p></div>
              <span>{history.routes.length}</span>
            </div>
            {history.routes.length ? history.routes.map((route) => (
              <RouteCard key={`${route.decision.id}:${route.decision.contentHash}`} route={route} />
            )) : <div className="harness-empty">No external recommendations have been routed.</div>}
          </section>

          <section className="harness-history-section">
            <div className="harness-section-heading">
              <div><h2>Memory</h2><p>Bounded external memory available through search; it is not copied into every Agent prompt or sandbox.</p></div>
              <span>{history.memories.length}</span>
            </div>
            {history.memories.length ? history.memories.map((entry) => (
              <article className="harness-route-card" key={`${entry.id}:${entry.revision}`}>
                <div><strong>{entry.key}</strong><span>revision {entry.revision}</span><time>{formatDate(entry.updatedAt)}</time></div>
                <p>{entry.content}</p>
                {entry.tags.length ? <small>{entry.tags.join(" · ")}</small> : null}
              </article>
            )) : <div className="harness-empty">No Harness memory has been saved.</div>}
          </section>
        </>
      ) : null}
    </section>
  );
}
