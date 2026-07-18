import { useState } from "react";
import type {
  CrossSystemExpertBootstrapApproval,
  CrossSystemExpertBootstrapPreview,
  Taskset,
} from "@openpond/contracts";

import type { ShowAppToast } from "../../app/app-state";
import { DetailSection } from "../training/DetailSection";
import { LabStatusBadge } from "./LabStatusBadge";

export function LabExpertBootstrap({
  taskset,
  busyAction,
  onPreview,
  onApprove,
  onToast,
}: {
  taskset: Taskset;
  busyAction: string | null;
  onPreview: () => Promise<CrossSystemExpertBootstrapPreview | null>;
  onApprove: (
    previewHash: string,
  ) => Promise<{ approval: CrossSystemExpertBootstrapApproval; taskset: Taskset } | null>;
  onToast: ShowAppToast;
}) {
  const [preview, setPreview] = useState<CrossSystemExpertBootstrapPreview | null>(null);
  const [open, setOpen] = useState(false);
  const approval = expertApproval(taskset);
  const approvedCount = taskset.learningSignals.demonstrations.filter(
    (signal) => signal.approved && signal.metadata.exampleOrigin === "expert_authored",
  ).length;
  const loading = busyAction === "preview-expert-bootstrap";
  const approving = busyAction === "approve-expert-bootstrap";

  async function review() {
    setOpen(true);
    const result = await onPreview();
    if (result) {
      setPreview(result);
      return;
    }
    setOpen(false);
    onToast("Couldn’t load the expert trajectories.", "error");
  }

  async function approve() {
    if (!preview) return;
    const result = await onApprove(preview.previewHash);
    if (!result) {
      onToast("The expert trajectories were not approved.", "error");
      return;
    }
    setOpen(false);
    onToast(
      `${result.approval.trajectoryCount} expert trajectories approved by ${result.approval.approvedBy}.`,
      "success",
    );
  }

  return (
    <>
      <DetailSection
        title="SFT bootstrap data"
        actions={(
          <button
            className="training-button secondary"
            disabled={loading || approving}
            type="button"
            onClick={() => void review()}
          >
            {approval ? "Review trajectories" : loading ? "Loading…" : "Review expert trajectories"}
          </button>
        )}
      >
        <div className="labs-expert-bootstrap-summary">
          <div>
            <LabStatusBadge
              label={approval ? "Approved" : "Review required"}
              value={approval ? "ready" : "needs_review"}
            />
            <p>
              {approval
                ? `${approvedCount} deterministic train-split trajectories are approved for the optional SFT bootstrap.`
                : "Five deterministic train-split trajectories are available. Failed model outputs remain excluded."}
            </p>
          </div>
          {approval ? (
            <dl className="labs-inline-facts">
              <Fact label="Approved by" value={approval.approvedBy} />
              <Fact label="Taskset revision" value={String(taskset.revision)} />
            </dl>
          ) : null}
        </div>
      </DetailSection>
      {open ? (
        <ExpertTrajectoryDialog
          approving={approving}
          loading={loading}
          preview={preview}
          onApprove={() => void approve()}
          onClose={() => {
            if (!approving) setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

export function ExpertTrajectoryDialog({
  preview,
  loading,
  approving,
  onApprove,
  onClose,
}: {
  preview: CrossSystemExpertBootstrapPreview | null;
  loading: boolean;
  approving: boolean;
  onApprove: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="training-dialog-backdrop"
      role="presentation"
      onMouseDown={approving ? undefined : onClose}
    >
      <section
        aria-label="Review expert trajectories"
        aria-modal="true"
        className="training-dialog labs-expert-bootstrap-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="training-dialog-header">
          <div>
            <h2>Review expert trajectories</h2>
            <p>
              These examples were executed in the deterministic synthetic environment and passed
              the exact verifier. Approval is bound to the signed-in OpenPond account.
            </p>
          </div>
          <button aria-label="Close" disabled={approving} type="button" onClick={onClose}>×</button>
        </div>
        <div className="training-dialog-scroll-body labs-expert-trajectory-list">
          {loading || !preview ? (
            <div className="training-run-placeholder">Generating and verifying the review set…</div>
          ) : (
            <>
              <dl className="labs-inline-facts labs-expert-preview-facts">
                <Fact label="Taskset revision" value={String(preview.tasksetRevision)} />
                <Fact label="Trajectories" value={String(preview.tasks.length)} />
                <Fact label="Review state" value={preview.status === "approved" ? "Approved" : "Pending"} />
              </dl>
              {preview.tasks.map((task) => (
                <details className="labs-expert-trajectory" key={task.trajectoryId}>
                  <summary>
                    <span>
                      <strong>{titleCase(task.family)}</strong>
                      <small>{task.toolCallCount} tool calls · exact reward {task.reward.toFixed(3)}</small>
                    </span>
                    <span aria-hidden="true">›</span>
                  </summary>
                  <div className="labs-expert-trajectory-body">
                    <section>
                      <h3>Prompt</h3>
                      <p>{task.prompt}</p>
                    </section>
                    <section>
                      <h3>Tool sequence</h3>
                      <div className="training-pills">
                        {task.toolNames.map((name, index) => (
                          <span key={`${task.trajectoryId}-${name}-${index}`}>{name}</span>
                        ))}
                      </div>
                    </section>
                    <section>
                      <h3>Verified answer</h3>
                      <pre>{task.finalAnswer}</pre>
                    </section>
                    <details className="labs-expert-messages">
                      <summary>View {task.messageCount} training messages</summary>
                      <pre>{JSON.stringify(task.messages, null, 2)}</pre>
                    </details>
                  </div>
                </details>
              ))}
            </>
          )}
        </div>
        <div className="training-dialog-actions">
          <span className="labs-expert-approval-note">
            Train split only · failed policy outputs excluded
          </span>
          <button className="training-button secondary" disabled={approving} type="button" onClick={onClose}>
            Close
          </button>
          {preview?.status !== "approved" ? (
            <button
              className="training-button"
              disabled={!preview || loading || approving}
              type="button"
              onClick={onApprove}
            >
              {approving ? "Approving…" : `Approve ${preview?.tasks.length ?? 0} trajectories`}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function expertApproval(taskset: Taskset): CrossSystemExpertBootstrapApproval | null {
  const expertBootstrap = record(taskset.metadata.expertBootstrap);
  const approval = record(expertBootstrap.approval);
  if (
    approval.status !== "approved"
    || typeof approval.approvedBy !== "string"
    || typeof approval.approvedAt !== "string"
    || typeof approval.previewHash !== "string"
    || typeof approval.trajectoryCount !== "number"
  ) {
    return null;
  }
  return approval as CrossSystemExpertBootstrapApproval;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function titleCase(value: string): string {
  return value
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
