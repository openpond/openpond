import { Cloud, FolderPlus, X } from "../icons";

type NewProjectDialogProps = {
  open: boolean;
  mode?: "local" | "cloud";
  name: string;
  directory: string;
  busy: boolean;
  onNameChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function NewProjectDialog({
  open,
  mode = "local",
  name,
  directory,
  busy,
  onNameChange,
  onClose,
  onSubmit,
}: NewProjectDialogProps) {
  if (!open) return null;
  const isCloud = mode === "cloud";
  const Icon = isCloud ? Cloud : FolderPlus;
  return (
    <div className="git-dialog-backdrop" role="presentation">
      <form
        className="git-dialog new-project-dialog"
        aria-label="Create project"
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
        <h2>{isCloud ? "New Cloud Project" : "New Local Project"}</h2>
        <p>
          {isCloud
            ? "Create a hosted project in OpenPond Cloud."
            : "Create a new local Git project and add it to Projects."}
        </p>
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
        <button className="git-dialog-primary full" disabled={busy || !name.trim()} type="submit">
          {busy ? "Creating" : isCloud ? "Create Cloud Project" : "Create project"}
        </button>
      </form>
    </div>
  );
}
