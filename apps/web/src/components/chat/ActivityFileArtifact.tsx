import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ActivityItem } from "../../lib/app-models";
import { copyToClipboard } from "../../lib/clipboard";
import { revealLocalFile } from "../../lib/desktop-files";
import { Copy, FileText, FolderOpen, PanelRight } from "../icons";

type FileArtifact = NonNullable<ActivityItem["artifacts"]>[number];

type FileArtifactContextMenu = {
  path: string;
  title: string;
  x: number;
  y: number;
};

export function ActivityFileArtifact({
  artifact,
  onOpenFileInSidebar,
}: {
  artifact: FileArtifact;
  onOpenFileInSidebar?: (path: string) => void;
}) {
  const [contextMenu, setContextMenu] =
    useState<FileArtifactContextMenu | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  return (
    <>
      <div
        className="activity-artifact"
        title={artifact.path}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({
            path: artifact.path,
            title: artifact.title,
            ...contextMenuPosition(event.clientX, event.clientY),
          });
        }}
      >
        {onOpenFileInSidebar ? (
          <button
            aria-label={`Open ${artifact.title} in right sidebar`}
            className="activity-artifact-name"
            type="button"
            onClick={() => onOpenFileInSidebar(artifact.path)}
          >
            <FileText aria-hidden size={14} />
            <strong>{artifact.title}</strong>
          </button>
        ) : (
          <span className="activity-artifact-name">
            <FileText aria-hidden size={14} />
            <strong>{artifact.title}</strong>
          </span>
        )}
        <span className="activity-artifact-actions">
          <button
            aria-label={`Show ${artifact.title} in file browser`}
            data-tooltip="Open in file browser"
            type="button"
            onClick={() => void revealLocalFile(artifact.path)}
          >
            <FolderOpen aria-hidden size={14} />
          </button>
          {onOpenFileInSidebar ? (
            <button
              aria-label={`Open ${artifact.title} in right sidebar`}
              data-tooltip="Open in right sidebar"
              type="button"
              onClick={() => onOpenFileInSidebar(artifact.path)}
            >
              <PanelRight aria-hidden size={14} />
            </button>
          ) : null}
        </span>
      </div>
      <FileArtifactContextMenu menu={contextMenu} onClose={closeContextMenu} />
    </>
  );
}

function FileArtifactContextMenu({
  menu,
  onClose,
}: {
  menu: FileArtifactContextMenu | null;
  onClose: () => void;
}) {
  const copyButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menu) return undefined;
    copyButtonRef.current?.focus();
    const close = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu, onClose]);

  if (!menu || typeof document === "undefined") return null;
  return createPortal(
    <div
      aria-label={`${menu.title} file actions`}
      className="activity-artifact-context-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        ref={copyButtonRef}
        role="menuitem"
        type="button"
        onClick={() => {
          void copyToClipboard(menu.path);
          onClose();
        }}
      >
        <Copy aria-hidden size={14} />
        <span>Copy path</span>
      </button>
    </div>,
    document.body,
  );
}

function contextMenuPosition(
  requestedX: number,
  requestedY: number,
): { x: number; y: number } {
  const margin = 8;
  const width = 164;
  const height = 42;
  return {
    x: Math.max(margin, Math.min(requestedX, window.innerWidth - width - margin)),
    y: Math.max(
      margin,
      Math.min(requestedY, window.innerHeight - height - margin),
    ),
  };
}
