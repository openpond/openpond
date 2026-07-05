import type { NewProjectMode } from "../../app/app-state";
import { Cloud, FolderOpen, FolderPlus, X } from "../icons";

type NewProjectDialogProps = {
  open: boolean;
  mode?: NewProjectMode;
  name: string;
  path: string;
  directory: string;
  busy: boolean;
  onNameChange: (value: string) => void;
  onPathChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function NewProjectDialog({
  open,
  mode = "local",
  name,
  path,
  directory,
  busy,
  onNameChange,
  onPathChange,
  onClose,
  onSubmit,
}: NewProjectDialogProps) {
  if (!open) return null;
  const isCloud = mode === "cloud";
  const isExistingLocal = mode === "existing-local";
  const Icon = isCloud ? Cloud : isExistingLocal ? FolderOpen : FolderPlus;
  const title = isCloud ? "New Cloud Project" : isExistingLocal ? "Use Existing Folder" : "New Local Project";
  const description = isCloud
    ? "Create a hosted project in OpenPond Cloud."
    : isExistingLocal
      ? "Add an existing local project folder to Projects."
      : "Create a new local Git project and add it to Projects.";
  const primaryDisabled = busy || (isExistingLocal ? !path.trim() : !name.trim());
  const primaryLabel = busy
    ? isExistingLocal
      ? "Adding"
      : "Creating"
    : isCloud
      ? "Create Cloud Project"
      : isExistingLocal
        ? "Add project"
        : "Create project";
  return (
    <div className="git-dialog-backdrop" role="presentation">
      <form
        className="git-dialog new-project-dialog"
        aria-label={isExistingLocal ? "Add existing project" : "Create project"}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <button className="git-dialog-close" disabled={busy} type="button" onClick={onClose}>
          <X size={14} />
        </button>
        <div className="git-dialog-icon">
          <Icon size={18} />
        </div>
        <h2>{title}</h2>
        <p>{description}</p>
        {isExistingLocal ? (
          <label className="git-dialog-field">
            <span>Folder path</span>
            <input
              autoFocus
              disabled={busy}
              placeholder="/home/user/project"
              value={path}
              onChange={(event) => onPathChange(event.target.value)}
            />
          </label>
        ) : (
          <>
            <label className="git-dialog-field">
              <span>Project name</span>
              <input
                autoFocus
                disabled={busy}
                placeholder="New project"
                value={name}
                onChange={(event) => onNameChange(event.target.value)}
              />
            </label>
            <div className="git-dialog-row">
              <span>Location</span>
              <strong className="git-dialog-path">{isCloud ? "OpenPond Cloud" : directory}</strong>
            </div>
          </>
        )}
        <button className="git-dialog-primary full" disabled={primaryDisabled} type="submit">
          {primaryLabel}
        </button>
      </form>
    </div>
  );
}
