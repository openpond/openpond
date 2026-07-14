import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ComputeStorageRoot } from "@openpond/contracts";
import "../../styles/workspace/git-dialogs.css";
import { FolderPlus, Plus, X } from "../icons";

export function ModelStoragePicker({
  disabled,
  onChange,
  storageRoots,
  value,
}: {
  disabled: boolean;
  onChange: (value: string | null) => void;
  storageRoots: ComputeStorageRoot[];
  value: string | null;
}) {
  const selectId = useId();
  const [manualOpen, setManualOpen] = useState(false);
  const selectedPath = normalizedPath(value);
  const selectedStorage = storageRoots.find((storage) => normalizedPath(storage.modelStorePath) === selectedPath) ?? null;

  return (
    <div className="model-storage-picker">
      <label className="model-storage-label" htmlFor={selectId}>Model storage</label>
      <div className="model-storage-control-row">
        <select
          aria-label="Model storage drive"
          className="model-storage-select"
          disabled={disabled}
          id={selectId}
          title={value ?? "No model storage configured"}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">Not configured</option>
          {value && !selectedStorage ? <option value={value}>Manual location</option> : null}
          {storageRoots.map((storage) => (
            <option
              disabled={!storage.mounted || !storage.writable}
              key={storage.id}
              title={storage.modelStorePath}
              value={storage.modelStorePath}
            >
              {storage.label} · {storageKindLabel(storage.kind)} · {storageStatus(storage)}
            </option>
          ))}
        </select>
        <button className="settings-icon-button model-storage-add" disabled={disabled} type="button" title="Add manual location" aria-label="Add manual model storage location" onClick={() => setManualOpen(true)}>
          <Plus size={15} />
        </button>
      </div>

      {manualOpen ? renderDialog(
        <ManualModelStorageDialog
          initialPath={value ?? ""}
          onClose={() => setManualOpen(false)}
          onUse={(path) => {
            onChange(path);
            setManualOpen(false);
          }}
        />,
      ) : null}
    </div>
  );
}

function renderDialog(dialog: ReactNode): ReactNode {
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

export function ManualModelStorageDialog({
  initialPath,
  onClose,
  onUse,
}: {
  initialPath: string;
  onClose: () => void;
  onUse: (path: string) => void;
}) {
  const titleId = useId();
  const [manualPath, setManualPath] = useState(initialPath);
  const error = manualStoragePathError(manualPath);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (error) return;
    onUse(manualPath.trim());
  }

  return (
    <div className="git-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="git-dialog model-storage-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={submit}>
        <button className="git-dialog-close" type="button" title="Close" aria-label="Close manual model storage" onClick={onClose}>
          <X size={15} />
        </button>
        <div className="git-dialog-icon"><FolderPlus size={18} /></div>
        <h2 id={titleId}>Manual model storage</h2>
        <p>Enter an absolute path to a folder mounted on this machine.</p>
        <label className="git-dialog-field">
          <span>Mounted folder path</span>
          <input autoFocus spellCheck={false} value={manualPath} placeholder="/mnt/models or /run/user/…/gvfs/…" onChange={(event) => setManualPath(event.target.value)} />
        </label>
        <div className="model-storage-dialog-note">
          For SMB, connect the share in Files or Finder first, then paste its mounted folder path. OpenPond uses your operating system’s existing connection and credentials.
        </div>
        {manualPath.trim() && error ? <div className="profile-dialog-warning">{error}</div> : null}
        <div className="git-dialog-footer">
          <button className="git-dialog-secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="git-dialog-primary" disabled={Boolean(error)} type="submit">Use location</button>
        </div>
      </form>
    </div>
  );
}

export function manualStoragePathError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Enter a mounted folder path.";
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return "Use the mounted folder path, not an smb:// or other network URL.";
  if (trimmed === "~" || trimmed.startsWith("~/")) return null;
  if (trimmed.startsWith("/") || trimmed.startsWith("\\\\") || /^[a-z]:[\\/]/i.test(trimmed)) return null;
  return "Enter an absolute mounted folder path.";
}

function storageKindLabel(kind: ComputeStorageRoot["kind"]): string {
  if (kind === "network") return "Network";
  if (kind === "removable") return "Removable";
  if (kind === "cache") return "Cache";
  return "Local";
}

function storageStatus(storage: ComputeStorageRoot): string {
  if (!storage.mounted) return "Not mounted";
  if (!storage.writable) return "Read only";
  return `${formatBytes(storage.freeBytes)} free`;
}

function normalizedPath(value: string | null): string {
  const normalized = (value ?? "").trim().replace(/[\\/]+$/, "");
  return /^(?:[a-z]:[\\/]|\\\\)/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function formatBytes(value: number | null): string {
  if (value == null) return "Unknown";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}
