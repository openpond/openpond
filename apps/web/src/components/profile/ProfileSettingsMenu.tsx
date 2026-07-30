import { useEffect, useRef, useState } from "react";
import {
  FolderGit2,
  GitCommit,
  Plus,
  RefreshCw,
  Settings,
  UploadCloud,
} from "../icons";

export function ProfileSettingsMenu({
  addDisabled,
  commitDisabled,
  commitLabel,
  refreshDisabled,
  repoDisabled,
  syncDisabled,
  syncLabel,
  syncStatus,
  onAdd,
  onCommit,
  onRefresh,
  onRepo,
  onSync,
}: {
  addDisabled: boolean;
  commitDisabled: boolean;
  commitLabel: string;
  refreshDisabled: boolean;
  repoDisabled: boolean;
  syncDisabled: boolean;
  syncLabel: string;
  syncStatus: string | null;
  onAdd: () => void;
  onCommit: () => void;
  onRefresh: () => void;
  onRepo: () => void;
  onSync: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div className="profile-selector-actions">
      <div className="profile-settings-menu-root" ref={menuRef}>
        <button
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label="Profile settings"
          className="settings-icon-button ghost profile-settings-menu-trigger"
          type="button"
          onClick={() => setOpen((current) => !current)}
        >
          <Settings size={15} />
        </button>
        {open ? (
          <div className="profile-settings-menu" role="menu">
            <button
              disabled={commitDisabled}
              role="menuitem"
              type="button"
              onClick={() => run(onCommit)}
            >
              <GitCommit size={14} />
              <span>{commitLabel}</span>
            </button>
            <button
              disabled={syncDisabled}
              role="menuitem"
              type="button"
              onClick={() => run(onSync)}
            >
              <UploadCloud size={14} />
              <span>
                <strong>{syncLabel}</strong>
                {syncStatus ? <small>{syncStatus}</small> : null}
              </span>
            </button>
            <button
              disabled={repoDisabled}
              role="menuitem"
              type="button"
              onClick={() => run(onRepo)}
            >
              <FolderGit2 size={14} />
              <span>Repository</span>
            </button>
            <div className="profile-settings-menu-separator" role="separator" />
            <button
              disabled={refreshDisabled}
              role="menuitem"
              type="button"
              onClick={() => run(onRefresh)}
            >
              <RefreshCw size={14} />
              <span>Refresh profiles</span>
            </button>
            <button
              disabled={addDisabled}
              role="menuitem"
              type="button"
              onClick={() => run(onAdd)}
            >
              <Plus size={14} />
              <span>Add profile</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
