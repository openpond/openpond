import { useEffect, useState } from "react";
import { BadgeCheck, Ban, Check, X } from "../icons";
import type { Approval, ResolveApprovalRequest } from "@openpond/contracts";

type ApprovalDecision = ResolveApprovalRequest["decision"];

type ApprovalRequestCardProps = {
  approval: Approval | null;
  onResolve: (approvalId: string, decision: ApprovalDecision) => Promise<void>;
};

export function ApprovalRequestCard({ approval, onResolve }: ApprovalRequestCardProps) {
  const [pendingDecision, setPendingDecision] = useState<ApprovalDecision | null>(null);

  useEffect(() => {
    setPendingDecision(null);
  }, [approval?.id]);

  if (!approval || approval.kind === "create_plan") return null;

  const detail = formatApprovalDetail(approval.detail);
  const supportsSessionApproval = approval.kind !== "subagent_patch_apply";

  async function resolve(decision: ApprovalDecision) {
    if (!approval || pendingDecision) return;
    setPendingDecision(decision);
    try {
      await onResolve(approval.id, decision);
    } catch {
      setPendingDecision(null);
    }
  }

  return (
    <div className="approval-request-shell" role="status" aria-live="polite">
      <section className="approval-request-card" aria-label={`${approvalKindLabel(approval.kind)} approval request`}>
        <div className="approval-request-copy">
          <div className="approval-request-header">
            <span>{approvalKindLabel(approval.kind)}</span>
          </div>
          <code className="approval-request-title" title={approval.title}>
            {approval.title}
          </code>
          {detail && detail !== approval.title && (
            <details className="approval-request-details">
              <summary>Details</summary>
              <pre>{detail}</pre>
            </details>
          )}
        </div>
        <div className="approval-request-actions">
          <button
            type="button"
            className="approval-action primary"
            disabled={Boolean(pendingDecision)}
            onClick={() => void resolve("accept")}
          >
            <Check size={14} />
            <span>{pendingDecision === "accept" ? "Approving" : "Approve"}</span>
          </button>
          {supportsSessionApproval ? (
            <button
              type="button"
              className="approval-action"
              title="Approve for the rest of this session"
              disabled={Boolean(pendingDecision)}
              onClick={() => void resolve("acceptForSession")}
            >
              <BadgeCheck size={14} />
              <span>{pendingDecision === "acceptForSession" ? "Approving" : "Session"}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="approval-action muted"
            disabled={Boolean(pendingDecision)}
            onClick={() => void resolve("decline")}
          >
            <Ban size={14} />
            <span>{pendingDecision === "decline" ? "Denying" : "Deny"}</span>
          </button>
          <button
            type="button"
            className="approval-action icon-only"
            title="Cancel task"
            aria-label="Cancel task"
            disabled={Boolean(pendingDecision)}
            onClick={() => void resolve("cancel")}
          >
            <X size={15} />
          </button>
        </div>
      </section>
    </div>
  );
}

function approvalKindLabel(kind: Approval["kind"]): string {
  if (kind === "create_plan") return "Plan review";
  if (kind === "subagent_patch_apply") return "Subagent patch";
  if (kind === "file_change" || kind === "legacy_patch") return "File change";
  if (kind === "permissions") return "Permissions";
  if (kind === "user_input") return "Input needed";
  return "Command";
}

function formatApprovalDetail(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}
