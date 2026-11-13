import { useEffect, useRef, useState } from "react";
import { useFilePathContextMenu } from "../common/FilePathContextMenu";
import { ChevronRight } from "../icons";
import {
  isAbsoluteWorkspaceDiffPath,
  normalizeWorkspaceDiffPath,
} from "./workspace-diff-panel-model";

export function workspaceFileDisplayName(path: string): string {
  const filename = path.replace(/\\/g, "/").split("/").pop() || "File";
  return filename.replace(
    /^\d{3}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i,
    "",
  );
}

export function FileBreadcrumbs({
  path,
  workspaceName = null,
  workspaceRootPath,
  onSelectPath,
}: {
  path: string;
  workspaceName?: string | null;
  workspaceRootPath?: string | null;
  onSelectPath?: (path: string | null) => void;
}) {
  const locationRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const { openFilePathMenu, filePathMenu } = useFilePathContextMenu();
  useEffect(() => {
    if (!open) return;
    const close = () => {
      if (locationRef.current) locationRef.current.open = false;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!locationRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        locationRef.current?.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", close);
    };
  }, [open]);
  const displayPath = normalizeWorkspaceDiffPath(path, workspaceRootPath);
  const absolute = isAbsoluteWorkspaceDiffPath(displayPath);
  const root = absolute
    ? absoluteBreadcrumbRoot(displayPath)
    : workspaceName?.trim() || "Workspace";
  const pathWithoutAbsoluteRoot =
    absolute && root !== "/" && displayPath.startsWith(`${root}/`)
      ? displayPath.slice(root.length + 1)
      : displayPath;
  const parts = pathWithoutAbsoluteRoot.split("/").filter(Boolean);
  const selectableFolders = Boolean(onSelectPath && !absolute);
  return (
    <>
      <details
        className="workspace-file-location"
        key={path}
        ref={locationRef}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary
          aria-label={`File path: ${workspaceFileDisplayName(path)}`}
          onContextMenu={(event) => {
            if (locationRef.current) locationRef.current.open = false;
            openFilePathMenu(event, path, workspaceFileDisplayName(path));
          }}
        >
          {workspaceFileDisplayName(path)}
        </summary>
        <div className="workspace-file-path-popover">
          <span className="workspace-file-breadcrumbs">
            {onSelectPath && !absolute ? (
              <button type="button" onClick={() => onSelectPath(null)}>
                {root}
              </button>
            ) : (
              <span>{root}</span>
            )}
            {parts.map((part, index) => {
              const isFileName = index === parts.length - 1;
              const folderPath = parts.slice(0, index + 1).join("/");
              return (
                <span className="workspace-file-breadcrumb-segment" key={`${index}-${part}`}>
                  <ChevronRight size={13} />
                  {onSelectPath && selectableFolders && !isFileName ? (
                    <button type="button" onClick={() => onSelectPath(folderPath)}>
                      {part}
                    </button>
                  ) : (
                    <span>{part}</span>
                  )}
                </span>
              );
            })}
          </span>
          <code>{path}</code>
        </div>
      </details>
      {filePathMenu}
    </>
  );
}

function absoluteBreadcrumbRoot(path: string): string {
  const windowsDrive = /^[A-Za-z]:\//.exec(path);
  return windowsDrive ? windowsDrive[0].slice(0, -1) : "/";
}
