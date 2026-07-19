import { useMemo, useState } from "react";
import type {
  ModelArtifactLineage,
  ModelBindingRole,
  TrainingStateResponse,
} from "@openpond/contracts";
import type { ShowAppToast } from "../../app/app-state";
import type { useTraining } from "../../hooks/useTraining";

type TrainingController = ReturnType<typeof useTraining>;
type PendingAction = "bind" | "reject" | "evaluate" | null;

const ROLE_LABELS: Record<ModelBindingRole, string> = {
  chat_manual: "Default chat model",
  agent: "Agent runtime",
  extension: "Extension runtime",
  authoring_optimizer: "Authoring / optimizer",
};

export function TrainingModelPromotion({
  lineage,
  state,
  training,
  onToast,
}: {
  lineage: ModelArtifactLineage | null;
  state: TrainingStateResponse | null;
  training: TrainingController;
  onToast: ShowAppToast;
}) {
  const [role, setRole] = useState<ModelBindingRole>("chat_manual");
  const [roleTargetId, setRoleTargetId] = useState("default");
  const [pending, setPending] = useState<PendingAction>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const activeBinding = useMemo(
    () => state?.modelBindings.find((binding) =>
      binding.status === "active" &&
      binding.role === role &&
      binding.roleTargetId === roleTargetId.trim()) ?? null,
    [role, roleTargetId, state?.modelBindings],
  );
  const activeLineage = activeBinding
    ? state?.models.find((model) => model.id === activeBinding.modelArtifactLineageId) ?? null
    : null;
  const evaluationArtifact = lineage?.frozenEvaluationArtifactId
    ? state?.artifacts.find(
        (artifact) => artifact.id === lineage.frozenEvaluationArtifactId,
      ) ?? null
    : null;
  const evaluationIncomplete =
    evaluationArtifact?.metadata.evaluationComplete === false;

  if (!lineage) {
    return <div className="training-run-placeholder">Promotion is available after a verified artifact is imported.</div>;
  }
  const model = lineage;

  const busy = Boolean(training.busyAction);
  const canBind = model.status === "imported" && model.promotable && Boolean(roleTargetId.trim());
  const bindingIsCurrent = activeBinding?.modelArtifactLineageId === model.id;

  async function bind() {
    const result = await training.actions.bindModel(model.id, role, roleTargetId.trim());
    setPending(null);
    onToast(result ? "Model binding activated." : "Couldn’t activate Model binding.", result ? "success" : "error");
  }

  async function reject() {
    const reason = rejectionReason.trim();
    if (!reason) return;
    const result = await training.actions.rejectModel(model.id, reason);
    setPending(null);
    onToast(result ? "Model candidate rejected." : "Couldn’t reject Model candidate.", result ? "success" : "error");
  }

  async function evaluate() {
    const result = await training.actions.evaluateJob(model.jobId);
    setPending(null);
    onToast(
      result
        ? "Frozen evaluation completed."
        : "Couldn’t complete frozen evaluation.",
      result ? "success" : "error",
    );
  }

  async function rollback() {
    if (!activeBinding) return;
    const result = await training.actions.rollbackModelBinding(activeBinding.id);
    onToast(result ? "Model binding rolled back." : "Couldn’t roll back Model binding.", result ? "success" : "error");
  }

  return (
    <div className="training-promotion">
      <div className="training-promotion-status">
        <div>
          <span>Promotion gate</span>
          <strong>{lineage.promotable ? "Passed" : "Blocked"}</strong>
        </div>
        <div>
          <span>Selected role</span>
          <strong>{activeLineage ? shortModel(activeLineage.id) : "No active binding"}</strong>
        </div>
        <div>
          <span>Rollback target</span>
          <strong>{activeBinding?.rollbackTargetBindingId ? shortModel(activeBinding.rollbackTargetBindingId) : "None"}</strong>
        </div>
      </div>
      <div className="training-promotion-controls">
        <label>
          <span>Role</span>
          <select value={role} onChange={(event) => {
            const next = event.target.value as ModelBindingRole;
            setRole(next);
            setRoleTargetId(next === "chat_manual" ? "default" : "");
          }}>
            {Object.entries(ROLE_LABELS).map(([value, label]) =>
              <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>Role target</span>
          <input
            value={roleTargetId}
            placeholder={role === "agent" ? "agent id" : role === "extension" ? "extension id" : "default"}
            onChange={(event) => setRoleTargetId(event.target.value)}
          />
        </label>
        <div className="training-promotion-actions">
          {evaluationIncomplete ? (
            <button
              className="training-button secondary"
              type="button"
              disabled={busy}
              onClick={() => setPending("evaluate")}
            >
              Run evaluation
            </button>
          ) : null}
          {bindingIsCurrent ? (
            <button className="training-button secondary" type="button" disabled={busy} onClick={() => void rollback()}>
              Roll back
            </button>
          ) : (
            <button className="training-button" type="button" disabled={busy || !canBind} onClick={() => setPending("bind")}>
              {activeBinding ? "Replace binding" : "Bind model"}
            </button>
          )}
          <button
            className="training-button danger"
            type="button"
            disabled={busy || lineage.status === "rejected" || bindingIsCurrent}
            onClick={() => setPending("reject")}
          >
            Reject
          </button>
        </div>
      </div>
      {!lineage.promotable ? (
        <p className="training-promotion-note">
          {evaluationIncomplete
            ? "The artifact remains inspectable. Its prior evaluation was blocked by provider infrastructure and recorded no quality result."
            : "The artifact remains inspectable, but it cannot be bound until its frozen-evaluation threshold passes."}
        </p>
      ) : null}
      {pending ? (
        <div className="training-dialog-backdrop" role="presentation" onMouseDown={() => !busy && setPending(null)}>
          <section
            className="training-dialog training-promotion-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={
              pending === "bind"
                ? "Confirm Model binding"
                : pending === "evaluate"
                  ? "Run frozen evaluation"
                  : "Reject Model candidate"
            }
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="training-dialog-header">
              <div>
                <h2>
                  {pending === "bind"
                    ? "Activate this Model binding?"
                    : pending === "evaluate"
                      ? "Run frozen evaluation?"
                      : "Reject this Model candidate?"}
                </h2>
                <p>
                  {pending === "bind"
                    ? `${ROLE_LABELS[role]} · ${roleTargetId.trim()}`
                    : pending === "evaluate"
                      ? "Temporary Fireworks deployments are deleted after the base and trained runs."
                      : "The artifact and evaluation evidence are retained."}
                </p>
              </div>
            </div>
            {pending === "bind" ? (
              <p>{activeBinding
                ? `The current binding ${shortModel(activeBinding.modelArtifactLineageId)} becomes the recorded rollback target.`
                : "This is an explicit activation; training success alone never changes runtime selection."}</p>
            ) : pending === "reject" ? (
              <label className="training-promotion-reason">
                <span>Reason</span>
                <textarea autoFocus value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} />
              </label>
            ) : (
              <p>
                OpenPond first validates both deployment shapes without
                spending, then runs the approved frozen Taskset through the
                stateful tool harness. Runtime is capped at 10 minutes and the
                conservative deployment ceiling is $1.17 within the existing
                training approval.
              </p>
            )}
            <div className="training-dialog-actions">
              <button className="training-button secondary" type="button" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
              <button
                className={`training-button ${pending === "reject" ? "danger" : ""}`}
                type="button"
                disabled={busy || (pending === "reject" && !rejectionReason.trim())}
                onClick={() =>
                  void (
                    pending === "bind"
                      ? bind()
                      : pending === "evaluate"
                        ? evaluate()
                        : reject()
                  )}
              >
                {busy
                  ? "Applying…"
                  : pending === "bind"
                    ? "Activate binding"
                    : pending === "evaluate"
                      ? "Run evaluation"
                      : "Reject candidate"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function shortModel(value: string) {
  return value.replace(/^lineage_/, "").replace(/^model_binding_/, "").slice(0, 16);
}
