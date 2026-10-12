import { ChevronRight } from "../icons";
import { isAbsoluteWorkspaceDiffPath, normalizeWorkspaceDiffPath } from "./workspace-diff-panel-model";

export function workspaceFileDisplayName(path: string): string {
  const filename = path.replace(/\\/g, "/").split("/").pop() || "File";
  return filename.replace(/^\d{3}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "");
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
  const displayPath = normalizeWorkspaceDiffPath(path, workspaceRootPath);
  const absolute = isAbsoluteWorkspaceDiffPath(displayPath);
  const root = absolute ? absoluteBreadcrumbRoot(displayPath) : workspaceName?.trim() || "Workspace";
  const pathWithoutAbsoluteRoot = absolute && root !== "/" && displayPath.startsWith(`${root}/`)
    ? displayPath.slice(root.length + 1)
    : displayPath;
  const parts = pathWithoutAbsoluteRoot.split("/").filter(Boolean);
  const selectableFolders = Boolean(onSelectPath && !absolute);
  return (
    <details className="workspace-file-location" key={path}>
      <summary title={path} aria-label={`File path: ${workspaceFileDisplayName(path)}`}>{workspaceFileDisplayName(path)}</summary>
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
  );
}

function absoluteBreadcrumbRoot(path: string): string {
  const windowsDrive = /^[A-Za-z]:\//.exec(path);
  return windowsDrive ? windowsDrive[0].slice(0, -1) : "/";
}

