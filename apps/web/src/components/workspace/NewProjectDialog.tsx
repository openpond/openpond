import type { NewProjectMode } from "../../app/app-state";
import { useEffect, useRef, useState } from "react";
import { Cloud, Folder, FolderOpen, FolderPlus, Monitor, X } from "../icons";

type ProjectCollection = { name: string; sourceFolders: string[]; primaryFolder: string };

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
  onSubmit: (collection?: ProjectCollection) => Promise<boolean | undefined>;
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
  const [folders, setFolders] = useState<string[]>([]);
  const [primaryFolder, setPrimaryFolder] = useState("");
  const [formError, setFormError] = useState("");
  const [manualPathOpen, setManualPathOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => opener.current?.focus();
  }, [open]);
  if (!open) return null;
  const isCloud = mode === "cloud";
  const isExistingLocal = mode === "existing-local";
  const Icon = isCloud ? Cloud : isExistingLocal ? FolderOpen : FolderPlus;
  const title = isCloud ? "New Cloud Project" : isExistingLocal ? "Create project" : "New Local Project";
  const description = isCloud
    ? "Create a hosted project in OpenPond Cloud."
    : "Create a new local Git project and add it to Projects.";
  const hasNativePicker = Boolean(window.openpond?.selectFolder);
  const sourceLabel = hasNativePicker ? "This computer" : "Connected computer";
  const addFolder = async () => {
    if (!hasNativePicker && !manualPathOpen) {
      setManualPathOpen(true);
      return;
    }
    const selected = hasNativePicker ? await window.openpond!.selectFolder!() : { path: path.trim(), canceled: false };
    const folder = selected.path?.trim();
    if (!folder || selected.canceled) return;
    if (folders.includes(folder)) { setFormError("This folder is already selected."); return; }
    setFolders((current) => [...current, folder]);
    if (!primaryFolder) setPrimaryFolder(folder);
    if (!name.trim()) onNameChange(folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder);
    if (!hasNativePicker) { onPathChange(""); setManualPathOpen(false); }
    setFormError("");
  };
  const primaryDisabled = busy || (isExistingLocal ? !name.trim() || folders.length === 0 : !name.trim());
  const primaryLabel = busy
    ? isExistingLocal
      ? "Creating"
      : "Creating"
    : isCloud
      ? "Create Cloud Project"
      : isExistingLocal
        ? "Create project"
        : "Create project";
  return (
    <div className="git-dialog-backdrop" role="presentation" onKeyDown={(event) => {
      if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
    }}>
      <form
        ref={formRef}
        className={`git-dialog new-project-dialog${isExistingLocal ? " new-project-collection" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Create project"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = Array.from(formRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []);
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
        onSubmit={async (event) => {
          event.preventDefault();
          setFormError("");
          const created = await onSubmit(isExistingLocal ? { name: name.trim(), sourceFolders: folders, primaryFolder } : undefined);
          if (!created) setFormError("Project could not be created. Check the selected folders and try again.");
        }}
      >
        <button className="git-dialog-close" disabled={busy} type="button" onClick={onClose}>
          <X size={14} />
        </button>
        {!isExistingLocal ? <div className="git-dialog-icon"><Icon size={18} /></div> : null}
        <h2>{title}</h2>
        {!isExistingLocal ? <p>{description}</p> : null}
        {isExistingLocal ? (
          <>
            <label className="new-project-name-field">
              <Folder size={16} aria-hidden="true" />
              <input autoFocus aria-label="Project name" disabled={busy} value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Project name" />
            </label>
            <div className="new-project-source-heading"><span>Source folders</span>{folders.length ? <span><Monitor size={15} aria-hidden="true" />{sourceLabel}</span> : null}</div>
            <div className={`new-project-source-box${folders.length ? " populated" : " empty"}`}>
              {folders.length === 0 ? (
                <div className="new-project-empty-source">
                  <span>Add a folder on {hasNativePicker ? "this" : "the connected"} computer</span>
                  <button type="button" disabled={busy} onClick={() => void addFolder()}><FolderPlus size={14} aria-hidden="true" />Add</button>
                </div>
              ) : (
                <ul className="new-project-folder-list">
                  {folders.map((folder) => (
                    <li key={folder} className="new-project-folder-row">
                      <Folder size={15} aria-hidden="true" />
                      <span title={folder} aria-label={folder}>{folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder}</span>
                      {primaryFolder === folder ? <span className="new-project-primary-pill">Primary</span> : <button className="new-project-make-primary" type="button" disabled={busy} onClick={() => setPrimaryFolder(folder)}>Make primary</button>}
                      <button className="new-project-remove" type="button" disabled={busy} aria-label={`Remove ${folder}`} onClick={() => {
                        setFolders((current) => {
                          const next = current.filter((item) => item !== folder);
                          if (primaryFolder === folder) setPrimaryFolder(next[0] ?? "");
                          return next;
                        });
                      }}><X size={14} aria-hidden="true" /></button>
                    </li>
                  ))}
                </ul>
              )}
              {folders.length ? <button className="new-project-add-row" type="button" disabled={busy} onClick={() => void addFolder()}><FolderPlus size={15} aria-hidden="true" />Add folder</button> : null}
              {manualPathOpen ? <label className="new-project-manual-path"><span>Folder path on connected computer</span><input value={path} onChange={(event) => onPathChange(event.target.value)} placeholder="/path/to/folder" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addFolder(); } }} /><button type="button" disabled={!path.trim()} onClick={() => void addFolder()}>Add folder</button></label> : null}
            </div>
          </>
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
        {formError ? <p className="new-project-error" role="alert">{formError}</p> : null}
        <div className="new-project-footer">
          <button className="new-project-cancel" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="git-dialog-primary" disabled={primaryDisabled} type="submit">{primaryLabel}</button>
        </div>
      </form>
    </div>
  );
}
