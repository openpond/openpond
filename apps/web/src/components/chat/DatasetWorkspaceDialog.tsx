import { useState } from "react";
import type { ClientConnection } from "../../api";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import { AppDialog } from "../dialogs/AppDialog";
import { X } from "../icons";
import { ComposerExperimentSetup } from "./ComposerExperimentSetup";
import { ComposerResourcePanel } from "./ComposerResourcePanel";
import { DatasetTrainingPlanFields } from "./DatasetTrainingPlanFields";
import type { DatasetWorkspaceDialogState } from "./DatasetWorkspace";

type Resources = ReturnType<typeof useChatResourceFocus>;
export function DatasetWorkspaceDialog({
  dialog,
  connection,
  resources,
  onClose,
  onAddToChat,
}: {
  dialog: DatasetWorkspaceDialogState;
  connection: ClientConnection;
  resources: Resources;
  onClose: () => void;
  onAddToChat: (text: string) => void;
}) {
  const [text, setText] = useState(dialog.text ?? "");
  return (
    <AppDialog
      ariaLabel={dialog.title}
      className="training-dialog dataset-workspace-dialog"
      onClose={onClose}
    >
      <header className="training-dialog-header">
        <h2>{dialog.title}</h2>
        <button
          className="training-icon-button"
          type="button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      {dialog.title === "New experiment" ? (
        <>
          <p>Uses {resources.focus.dataset?.name} and its current graders. This creates a draft.</p>
          <ComposerExperimentSetup
            resources={resources}
            busy={false}
            createNew
            onClose={onClose}
            onAddGrader={() =>
              onAddToChat(
                `Create a grader for ${resources.focus.dataset?.name}, revision ${resources.focus.dataset?.revision}. Ask what it should check, then validate it before evaluating.`,
              )
            }
          />
        </>
      ) : dialog.title === "Add grader" ? (
        <ComposerResourcePanel
          kind="grader"
          resources={resources}
          busy={false}
          onDraft={onAddToChat}
        />
      ) : dialog.title === "New training" ? (
        <DatasetTrainingPlanFields
          connection={connection}
          resources={resources}
          onAddToChat={onAddToChat}
          initialPreset="standard"
        />
      ) : (
        <>
          <p>Review the request, then add it to chat.</p>
          <textarea
            data-autofocus
            aria-label="Chat request"
            rows={6}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="training-dialog-actions">
            <button type="button" className="training-button secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="training-button"
              disabled={!text.trim()}
              onClick={() => onAddToChat(text)}
            >
              Add to chat
            </button>
          </div>
        </>
      )}
    </AppDialog>
  );
}
