import { useRef, useState } from "react";
import type { ModelProject } from "@openpond/contracts";

export function ModelRunEditorHeader({
  project,
  persisted,
  busy,
  dirty,
  canRun,
  pageReason,
  actionLabel,
  onProjectChange,
  onCancel,
  onSave,
  onLaunch,
}: {
  project: ModelProject;
  persisted: boolean;
  busy: boolean;
  dirty: boolean;
  canRun: boolean;
  pageReason: string | null;
  actionLabel: string;
  onProjectChange: (project: ModelProject) => void;
  onCancel: () => void;
  onSave: () => void;
  onLaunch: () => void;
}) {
  const [editingName, setEditingName] = useState(false);
  const nameBeforeEditRef = useRef(project.name);

  return (
    <header className="model-build-header">
      <div>
        {persisted ? (
          <>
            <h1 className="model-build-name">New run</h1>
            <p>{project.name}</p>
          </>
        ) : editingName ? (
          <input
            aria-label="Model name"
            autoFocus
            className="model-build-name model-build-name-input"
            value={project.name}
            onBlur={() => {
              onProjectChange({
                ...project,
                name: project.name.trim() || nameBeforeEditRef.current,
                updatedAt: new Date().toISOString(),
              });
              setEditingName(false);
            }}
            onChange={(event) =>
              onProjectChange({
                ...project,
                name: event.target.value,
                updatedAt: new Date().toISOString(),
              })}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                onProjectChange({
                  ...project,
                  name: nameBeforeEditRef.current,
                  updatedAt: new Date().toISOString(),
                });
                setEditingName(false);
              }
            }}
          />
        ) : (
          <button
            aria-label={`Rename ${project.name}`}
            className="model-build-name model-build-name-button"
            type="button"
            onClick={() => {
              nameBeforeEditRef.current = project.name;
              setEditingName(true);
            }}
          >
            {project.name}
          </button>
        )}
      </div>
      <div className="model-build-actions">
        <button
          id="model-run-editor-cancel"
          className="training-button secondary"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="training-button secondary"
          type="button"
          disabled={busy || !dirty || !project.name.trim()}
          onClick={onSave}
        >
          Save
        </button>
        <span
          className="model-build-run-control"
          title={pageReason ?? actionLabel}
        >
          <button
            className="training-button"
            type="button"
            disabled={!canRun}
            onClick={onLaunch}
          >
            {actionLabel}
          </button>
        </span>
      </div>
    </header>
  );
}
