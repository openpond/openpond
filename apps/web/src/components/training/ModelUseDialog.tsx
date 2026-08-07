import type { ModelArtifactLineage, Taskset } from "@openpond/contracts";

import type { useTraining } from "../../hooks/useTraining";
import {
  buildTrainingModelChatHandoff,
  type TrainingModelChatHandoff,
} from "../../lib/training-model-chat-handoff";
import { MessageSquare, X } from "../icons";
import { AppDialog } from "../dialogs/AppDialog";

type TrainingController = ReturnType<typeof useTraining>;

export function ModelUseDialog({
  lineage,
  taskset,
  training,
  onChat,
  onClose,
}: {
  lineage: ModelArtifactLineage;
  taskset: Taskset;
  training: TrainingController;
  onChat: (handoff: TrainingModelChatHandoff) => void;
  onClose: () => void;
}) {
  const busy = Boolean(training.busyAction);

  function chat(): void {
    onChat(buildTrainingModelChatHandoff({
      modelId: lineage.id,
      taskset,
    }));
    onClose();
  }

  return (
    <AppDialog
      ariaLabel={`Use ${taskset.name}`}
      className="training-dialog training-model-use-dialog"
      dismissDisabled={busy}
      onClose={onClose}
    >
      <div className="training-dialog-header">
        <div>
          <h2>Use model</h2>
          <p>{taskset.name}</p>
        </div>
        <button
          aria-label="Close model use"
          disabled={busy}
          type="button"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>

      {!lineage.promotable ? (
        <p className="training-model-use-warning">
          This run did not pass its frozen Eval. Chat is available for
          inspection, but the model cannot be promoted.
        </p>
      ) : null}

      <p className="training-model-use-note">
        Open a chat with this trained version. OpenPond selects its managed or
        Local runtime from the recorded model lineage.
      </p>

      <div className="training-dialog-actions">
        <button
          className="training-button secondary"
          disabled={busy}
          type="button"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          className="training-button"
          disabled={busy}
          type="button"
          onClick={chat}
        >
          <MessageSquare size={14} />
          Chat now
        </button>
      </div>
    </AppDialog>
  );
}
