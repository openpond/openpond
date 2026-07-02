import { useEffect, useState } from "react";
import { Check, CircleAlert, FileText, HelpCircle, Loader2, X } from "../icons";
import type {
  CreatePipelineQuestion,
  CreatePipelineRequest,
  CreatePipelineSnapshot,
} from "@openpond/contracts";
import { createPipelineActionShapeFromMetadata } from "@openpond/contracts";
import type { CreatePipelineReviewActionInput } from "./create-pipeline-types";

export type ComposerCreatePipelineRuntime = {
  turnId: string | null;
  request: CreatePipelineRequest;
  snapshot: CreatePipelineSnapshot | null;
  onAnswerQuestion?: (
    input: CreatePipelineReviewActionInput,
    questionId: string,
    answerValue: string,
  ) => Promise<void>;
  onApprove?: (input: CreatePipelineReviewActionInput) => Promise<void>;
  onCancel?: (input: CreatePipelineReviewActionInput) => Promise<void>;
  onRevise?: (input: CreatePipelineReviewActionInput, revision: string) => Promise<void>;
};

export function ComposerCreatePipelineStrip({
  runtime,
}: {
  runtime: ComposerCreatePipelineRuntime;
}) {
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revision, setRevision] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const snapshot = runtime.snapshot;
  const state = snapshot?.state ?? "planning";
  const plan = snapshot?.plan ?? null;
  const question = activeCreateQuestion(snapshot);
  const actionInput = runtime.turnId
    ? {
        turnId: runtime.turnId,
        request: runtime.request,
        snapshot,
      }
    : null;
  const tone = createPipelineTone(state);

  useEffect(() => {
    setRevisionOpen(false);
    setRevision("");
    setBusyAction(null);
  }, [snapshot?.id, plan?.id, state, question?.id]);

  async function runAction(label: string, handler: (() => Promise<void>) | undefined) {
    if (!handler || busyAction) return;
    setBusyAction(label);
    try {
      await handler();
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section className={`composer-create-strip ${tone}`} aria-label="Create pipeline status">
      <div className="composer-create-strip-heading">
        {tone === "danger" ? <CircleAlert size={15} /> : state === "awaiting_questions" ? <HelpCircle size={15} /> : state === "applying_source" || state === "running_checks" ? <Loader2 size={15} /> : <FileText size={15} />}
        <span>{createPipelineTitle(state)}</span>
        <small>{runtime.request.operation}</small>
      </div>

      {state === "awaiting_questions" && question ? (
        <div className="composer-create-question">
          <p>{question.prompt}</p>
          <div className="composer-create-options">
            {question.options.map((option) => (
              <button
                type="button"
                key={option.id}
                disabled={!actionInput || Boolean(busyAction)}
                onClick={() =>
                  void runAction(`answer:${option.id}`, () =>
                    actionInput && runtime.onAnswerQuestion
                      ? runtime.onAnswerQuestion(actionInput, question.id, option.value)
                      : Promise.resolve(),
                  )
                }
              >
                <span>{busyAction === `answer:${option.id}` ? "Saving" : option.label}</span>
                {option.description ? <small>{option.description}</small> : null}
              </button>
            ))}
          </div>
        </div>
      ) : state === "awaiting_plan_approval" && plan ? (
        <div className="composer-create-plan-summary">
          <p>{plan.summary}</p>
          <CreatePlanFacts snapshot={snapshot} />
          {revisionOpen ? (
            <div className="composer-create-revision">
              <textarea
                rows={2}
                value={revision}
                placeholder="Describe the plan revision"
                onChange={(event) => setRevision(event.currentTarget.value)}
              />
              <div>
                <button
                  type="button"
                  disabled={!actionInput || !revision.trim() || Boolean(busyAction)}
                  onClick={() =>
                    void runAction("revise", () =>
                      actionInput && runtime.onRevise
                        ? runtime.onRevise(actionInput, revision)
                        : Promise.resolve(),
                    )
                  }
                >
                  <FileText size={13} />
                  <span>{busyAction === "revise" ? "Saving" : "Save revision"}</span>
                </button>
                <button type="button" disabled={Boolean(busyAction)} onClick={() => setRevisionOpen(false)}>
                  <X size={13} />
                  <span>Close</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="composer-create-actions">
              <button
                type="button"
                disabled={!actionInput || Boolean(busyAction)}
                onClick={() =>
                  void runAction("approve", () =>
                    actionInput && runtime.onApprove
                      ? runtime.onApprove(actionInput)
                      : Promise.resolve(),
                  )
                }
              >
                <Check size={13} />
                <span>{busyAction === "approve" ? "Confirming" : "Confirm plan"}</span>
              </button>
              <button type="button" disabled={Boolean(busyAction)} onClick={() => setRevisionOpen(true)}>
                <FileText size={13} />
                <span>Edit plan</span>
              </button>
              <button
                type="button"
                disabled={!actionInput || Boolean(busyAction)}
                onClick={() =>
                  void runAction("cancel", () =>
                    actionInput && runtime.onCancel
                      ? runtime.onCancel(actionInput)
                      : Promise.resolve(),
                  )
                }
              >
                <X size={13} />
                <span>{busyAction === "cancel" ? "Cancelling" : "Cancel"}</span>
              </button>
            </div>
          )}
        </div>
      ) : state === "blocked" || state === "failed" ? (
        <div className="composer-create-status-body">
          <p>{snapshot?.blockedReason ?? "Create is blocked. Review the details before retrying."}</p>
        </div>
      ) : state === "ready_local" ? (
        <div className="composer-create-status-body composer-create-status-body-reveals">
          <p>Generated source is ready locally.</p>
          <div className="composer-create-hover-details">
            <CreatePlanFacts snapshot={snapshot} />
          </div>
        </div>
      ) : (
        <div className="composer-create-status-body">
          <p>{createPipelineProgressText(state)}</p>
          <CreatePlanFacts snapshot={snapshot} />
        </div>
      )}
    </section>
  );
}

function activeCreateQuestion(snapshot: CreatePipelineSnapshot | null): CreatePipelineQuestion | null {
  return (
    snapshot?.questions.find((question) => question.status === "pending" && question.required) ??
    snapshot?.questions.find((question) => question.status === "pending") ??
    null
  );
}

function CreatePlanFacts({ snapshot }: { snapshot: CreatePipelineSnapshot | null }) {
  const plan = snapshot?.plan ?? null;
  const sourceRefs = snapshot?.sourceRefs ?? [];
  const checkRefs = snapshot?.checkRefs ?? [];
  const source = sourceRefs[0] ?? plan?.sourcePlan[0]?.path ?? null;
  const checks = checkRefs.length || plan?.checks.length || 0;
  const requirements = plan?.requirements.length ?? 0;
  const refs = [...sourceRefs, ...checkRefs].slice(0, 4);
  const actionShape = createPipelineActionShapeFromMetadata(plan?.metadata);
  if (!source && checks === 0 && requirements === 0 && refs.length === 0 && !actionShape) return null;
  return (
    <>
      <div className="composer-create-facts">
        {actionShape ? <span title={actionShape.detail}>{actionShape.label}</span> : null}
        {source ? <span title={source}>{source}</span> : null}
        {checks ? <span>{checkRefs.length ? `${checkRefs.length} check refs` : `${checks} checks`}</span> : null}
        {requirements ? <span>{requirements} setup rows</span> : null}
      </div>
      {refs.length ? (
        <ul className="composer-create-refs" aria-label="Create source and check refs">
          {refs.map((ref) => (
            <li key={ref}>
              <code title={ref}>{ref}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function createPipelineTitle(state: string): string {
  if (state === "awaiting_questions") return "Create question";
  if (state === "awaiting_plan_approval") return "Create plan";
  if (state === "applying_source") return "Applying source";
  if (state === "running_checks") return "Running checks";
  if (state === "ready_local") return "Ready locally";
  if (state === "blocked") return "Create blocked";
  if (state === "failed") return "Create failed";
  return "Create";
}

function createPipelineProgressText(state: string): string {
  if (state === "applying_source") return "Applying the approved source changes.";
  if (state === "running_checks") return "Running SDK checks against the generated source.";
  if (state === "pushing_hosted") return "Pushing the profile source.";
  if (state === "running_hosted_checks") return "Running hosted checks.";
  if (state === "published_hosted") return "Published to hosted profile.";
  return "Preparing the Create workflow.";
}

function createPipelineTone(state: string): "info" | "warning" | "success" | "danger" {
  if (state === "ready_local" || state === "published_hosted") return "success";
  if (state === "blocked" || state === "failed" || state === "cancelled") return "danger";
  if (state === "awaiting_questions" || state === "awaiting_plan_approval") return "warning";
  return "info";
}
