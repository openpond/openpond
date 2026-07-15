import type { TrainingModelChatHandoff } from "../../lib/training-model-chat-handoff";
import { selectedTrainingModelChatTask } from "../../lib/training-model-chat-handoff";
import { ArrowLeft, ArrowRight, X } from "../icons";

export function TrainingModelChatHandoffBar({
  busy,
  handoff,
  onDismiss,
  onSelectTask,
}: {
  busy: boolean;
  handoff: TrainingModelChatHandoff;
  onDismiss: () => void;
  onSelectTask: (index: number) => void;
}) {
  const task = selectedTrainingModelChatTask(handoff);
  if (!task) return null;
  const position = handoff.selectedTaskIndex + 1;
  return (
    <section className="training-chat-handoff" aria-label="Generated Taskset question">
      <div className="training-chat-handoff-copy">
        <strong>Generated Taskset question</strong>
        <span>{handoff.tasksetName}</span>
        <small>{splitLabel(task.split)} · {position} of {handoff.tasks.length} · New chat per question</small>
      </div>
      <div className="training-chat-handoff-actions">
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
