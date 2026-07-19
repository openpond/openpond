import type { FireworksModelServingSession } from "@openpond/contracts";
import type { TrainingModelChatHandoff } from "../../lib/training-model-chat-handoff";
import { selectedTrainingModelChatTask } from "../../lib/training-model-chat-handoff";
import { ArrowLeft, ArrowRight, X } from "../icons";

export function TrainingModelChatHandoffBar({
  busy,
  handoff,
  onDismiss,
  onSelectTask,
  servingSession,
  onStopServing,
}: {
  busy: boolean;
  handoff: TrainingModelChatHandoff;
  onDismiss: () => void;
  onSelectTask: (index: number) => void;
  servingSession?: FireworksModelServingSession | null;
  onStopServing?: (servingSessionId: string) => void;
}) {
  const task = selectedTrainingModelChatTask(handoff);
  const position = handoff.selectedTaskIndex + 1;
  return (
    <section className="training-chat-handoff" aria-label="Model chat">
      <div className="training-chat-handoff-copy">
        <strong>{task ? "Generated Taskset question" : "Model chat"}</strong>
        <span>{handoff.tasksetName}</span>
        <small>
          {task
            ? `${splitLabel(task.split)} · ${position} of ${handoff.tasks.length} · New chat per question`
            : "Ask the imported model directly"}
          {servingSession
            ? ` · Fireworks ${servingSession.state} · $${servingSession.estimatedCostUsd.toFixed(4)}`
            : ""}
        </small>
      </div>
      <div className="training-chat-handoff-actions">
        {task ? (
          <>
            <button
              type="button"
              aria-label="Previous generated question"
              title="Previous question"
              disabled={busy || handoff.selectedTaskIndex === 0}
              onClick={() => onSelectTask(handoff.selectedTaskIndex - 1)}
            >
              <ArrowLeft size={14} />
            </button>
            <button
              type="button"
              className="training-chat-handoff-load"
              disabled={busy}
              onClick={() => onSelectTask(handoff.selectedTaskIndex)}
            >
              Load question
            </button>
            <button
              type="button"
              aria-label="Next generated question"
              title="Next question"
              disabled={busy || handoff.selectedTaskIndex >= handoff.tasks.length - 1}
              onClick={() => onSelectTask(handoff.selectedTaskIndex + 1)}
            >
              <ArrowRight size={14} />
            </button>
          </>
        ) : null}
        {servingSession && ["starting", "ready"].includes(servingSession.state) ? (
          <button
            className="training-chat-handoff-stop"
            disabled={busy}
            type="button"
            onClick={() => onStopServing?.(servingSession.id)}
          >
            Stop serving
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Close generated question handoff"
          title="Close"
          disabled={busy}
          onClick={onDismiss}
        >
          <X size={14} />
        </button>
      </div>
    </section>
  );
}

function splitLabel(split: TrainingModelChatHandoff["tasks"][number]["split"]): string {
  if (split === "frozen_eval") return "Frozen evaluation";
  if (split === "validation") return "Validation";
  return "Training";
}
