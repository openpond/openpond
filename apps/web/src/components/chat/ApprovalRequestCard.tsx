import { useEffect, useState } from "react";
import { BadgeCheck, Ban, Check, X } from "../icons";
import type { Approval, ResolveApprovalRequest } from "@openpond/contracts";
import type { NativeAgentQuestion } from "@openpond/agent-runtime";
import { NativeQuestionFields } from "./NativeQuestionFields";

type ApprovalDecision = ResolveApprovalRequest["decision"];

type ApprovalRequestCardProps = {
  approval: Approval | null;
  onResolve: (approvalId: string, decision: ApprovalDecision, answers?: ResolveApprovalRequest["answers"]) => Promise<void>;
};

export function ApprovalRequestCard({ approval, onResolve }: ApprovalRequestCardProps) {
  const [pendingDecision, setPendingDecision] = useState<ApprovalDecision | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  useEffect(() => {
    setPendingDecision(null);
    setAnswers({});
  }, [approval?.id]);

  if (!approval || approval.kind === "create_plan") return null;

  const detail = formatApprovalDetail(approval.detail);
  const native = typeof approval.providerRequestId === "string" && approval.providerRequestId.startsWith("native-agent:");
  let choices: Array<{ kind: string; name: string }> = [];
  let questions: NativeAgentQuestion[] = [];
  if (native) { try { const parsed = JSON.parse(approval.detail) as { options?: Array<{ kind: string; name: string }>; questions?: NativeAgentQuestion[] }; choices = parsed.options ?? []; questions = parsed.questions ?? []; } catch { /* Invalid native details never expose a broader grant. */ } }
  const supportsSessionApproval = native ? choices.some((option) => option.kind === "allow_always") : approval.kind !== "subagent_patch_apply";
  const nativeAlwaysName = choices.find((option) => option.kind === "allow_always")?.name;

  async function resolve(decision: ApprovalDecision) {
    if (!approval || pendingDecision) return;
    setPendingDecision(decision);
    try {
      await onResolve(approval.id, decision, decision === "accept" && questions.length ? answers : undefined);
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
          {questions.length ? <NativeQuestionFields questions={questions} answers={answers} disabled={Boolean(pendingDecision)} onChange={setAnswers} /> : null}
        </div>
        <div className="approval-request-actions">
          <button
            type="button"
            className="approval-action primary"
            disabled={Boolean(pendingDecision) || questions.some((question) => !answers[question.question]?.trim()) || (native && !choices.some((option) => option.kind === "allow_once"))}
            onClick={() => void resolve("accept")}
          >
            <Check size={14} />
            <span>{pendingDecision === "accept" ? "Sending" : questions.length ? "Submit answers" : "Approve"}</span>
          </button>
          {supportsSessionApproval ? (
            <button
              type="button"
              className="approval-action"
              title={native ? nativeAlwaysName : "Approve for the rest of this session"}
              disabled={Boolean(pendingDecision)}
              onClick={() => void resolve("acceptForSession")}
            >
              <BadgeCheck size={14} />
              <span>{pendingDecision === "acceptForSession" ? "Approving" : native ? nativeAlwaysName : "Session"}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="approval-action muted"
            disabled={Boolean(pendingDecision) || (native && !choices.some((option) => option.kind === "reject_once"))}
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
