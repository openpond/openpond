import { useEffect, useState } from "react";
import type { TaskCreationSnapshot } from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";
import { Check, CircleAlert, FileText, Loader2, X } from "../icons";
import "../../styles/training/training.css";

type TrainingController = ReturnType<typeof useTraining>;

export function TrainingCreationPanel({
  creation,
  training,
  compact = false,
  onOpenTraining,
}: {
  creation: TaskCreationSnapshot;
  training: TrainingController;
  compact?: boolean;
  onOpenTraining?: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [message, setMessage] = useState("");
  const state = creation.state;
  const pending = Boolean(training.busyAction);

  useEffect(() => {
    setAnswer("");
    setMessage("");
  }, [creation.id, state]);

  return (
    <section
      className={compact ? `composer-create-strip ${trainingCreationTone(state)} training-create-strip` : "training-approval"}
      aria-label="Training task status"
    >
      {compact ? (
        <div className="composer-create-strip-heading">
          {state === "planning" || state === "materializing" || state === "validating" ? <Loader2 className="composer-create-spin" size={15} /> : state === "failed" ? <CircleAlert size={15} /> : <FileText size={15} />}
          <span>{trainingCreationTitle(state)}</span>
          <small>training</small>
        </div>
      ) : null}

      {state === "awaiting_disclosure_approval" ? (
        <div className={compact ? "composer-create-plan-summary" : "training-creation-content"}>
          {!compact ? <strong>Review selected evidence with the authoring model?</strong> : null}
          <p>Approve sends excerpts from {creation.request.sourceIds.length} explicitly selected source{creation.request.sourceIds.length === 1 ? "" : "s"} to {creation.request.analysisModel?.providerId}/{creation.request.analysisModel?.modelId} so it can propose a Taskset and grader. This does not start training.</p>
          <div className={compact ? "composer-create-actions" : "training-inline-actions"}>
            <button className={compact ? undefined : "training-button"} disabled={pending} onClick={() => void training.actions.approveDisclosure(creation.id, true)}><Check size={13}/><span>Approve evidence</span></button>
            <button className={compact ? undefined : "training-button secondary"} disabled={pending} onClick={() => void training.actions.approveDisclosure(creation.id, false)}><X size={13}/><span>Decline</span></button>
            {compact && onOpenTraining ? <button disabled={pending} onClick={onOpenTraining}><FileText size={13}/><span>Open Training</span></button> : null}
          </div>
        </div>
      ) : state === "awaiting_materialization_approval" && creation.proposal ? (
        <div className={compact ? "composer-create-plan-summary" : "training-creation-content"}>
          {!compact ? <strong>{creation.proposal.name}</strong> : null}
          <p>{creation.proposal.objective}</p>
          <div className="training-creation-plan-facts">
            <span>{creation.proposal.taskKind.replaceAll("_", " ")}</span>
            <span>{creation.proposal.proposedGraders.length} grader{creation.proposal.proposedGraders.length === 1 ? "" : "s"}</span>
            <span>{creation.proposal.proposedMethod.replaceAll("_", " ")}</span>
          </div>
          {creation.request.mode === "customize" ? (
            <div className="training-question-answer">
              <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Revise tasks, graders, fixtures, or policy" />
              <button className={compact ? undefined : "training-button secondary"} disabled={!message.trim() || pending} onClick={async () => { const value = message; setMessage(""); await training.actions.chatCreation(creation.id, value); }}>Revise</button>
            </div>
          ) : null}
          <div className={compact ? "composer-create-actions" : "training-inline-actions"}>
            <button className={compact ? undefined : "training-button"} disabled={pending} onClick={() => void training.actions.materialize(creation.id, true)}><Check size={13}/><span>Materialize Taskset</span></button>
            {onOpenTraining ? <button className={compact ? undefined : "training-button secondary"} disabled={pending} onClick={onOpenTraining}><FileText size={13}/><span>Review details</span></button> : null}
            <button className={compact ? undefined : "training-button secondary"} disabled={pending} onClick={() => void training.actions.materialize(creation.id, false)}><X size={13}/><span>Cancel</span></button>
          </div>
        </div>
      ) : state === "awaiting_questions" ? (
        <div className={compact ? "composer-create-question" : "training-creation-content"}>
          {(() => {
            const question = creation.blockingQuestions.find((item) => !item.answer);
            return question ? <><p>{question.prompt}</p><div className="training-question-answer"><input value={answer} onChange={(event) => setAnswer(event.target.value)} /><button className={compact ? undefined : "training-button"} disabled={!answer.trim() || pending} onClick={() => void training.actions.answerQuestions(creation.id, { [question.id]: answer })}>Continue</button></div></> : null;
          })()}
        </div>
      ) : (
        <div className={compact ? "composer-create-status-body" : "training-creation-content"}>
          <p>{trainingCreationStatus(creation)}</p>
          {compact && onOpenTraining ? <div className="composer-create-actions"><button onClick={onOpenTraining}><FileText size={13}/><span>Open Training</span></button></div> : null}
        </div>
      )}
    </section>
  );
}

export function TrainingStatusReceipt({ creation }: { creation: TaskCreationSnapshot }) {
  return (
    <section className="chat-create-receipt" aria-label="Training status">
      <div className="chat-create-receipt-heading">
        <FileText size={14} />
        <span>{trainingCreationTitle(creation.state)}</span>
        <small>training</small>
      </div>
      <p>{creation.request.objective ?? trainingCreationStatus(creation)}</p>
      <div className="chat-create-receipt-facts">
        <span>{creation.request.sourceIds.length} selected source{creation.request.sourceIds.length === 1 ? "" : "s"}</span>
        <span>{creation.request.mode === "customize" ? "guided plan" : "fast draft"}</span>
      </div>
    </section>
  );
}

function trainingCreationTitle(state: TaskCreationSnapshot["state"]): string {
  if (state === "awaiting_disclosure_approval") return "Training evidence review";
  if (state === "awaiting_materialization_approval") return "Training plan ready";
  if (state === "awaiting_questions") return "Training question";
  if (state === "materializing") return "Materializing Taskset";
  if (state === "ready") return "Taskset ready";
  if (state === "failed") return "Training plan failed";
  if (state === "cancelled") return "Training plan cancelled";
  return "Preparing training plan";
}

function trainingCreationStatus(creation: TaskCreationSnapshot): string {
  if (creation.blockedReason) return creation.blockedReason;
  if (creation.state === "ready") return "The reviewed Taskset was materialized. Training still requires a separate approval.";
  if (creation.state === "cancelled") return "Taskset creation was cancelled.";
  if (creation.state === "planning") return "The authoring model is proposing tasks, graders, fixtures, and policy boundaries.";
  return `Task Creator is ${creation.state.replaceAll("_", " ")}.`;
}

function trainingCreationTone(state: TaskCreationSnapshot["state"]): "info" | "warning" | "success" | "danger" {
  if (state === "ready") return "success";
  if (state === "failed" || state === "cancelled") return "danger";
  if (state === "awaiting_disclosure_approval" || state === "awaiting_materialization_approval" || state === "awaiting_questions") return "warning";
  return "info";
}
