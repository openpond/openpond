import { useMemo } from "react";
import type { SidebarFileStatus, WorkspaceDiffSummary } from "@openpond/contracts";
import { WorkspaceFileTree } from "./WorkspaceFileTree";

export function WorkspaceDiffFiles({
  diff,
  expandedFolderPaths,
  rootPath,
  repoFiles,
  selectedPath,
  getFileBookmarkStatus,
  onOpenFile,
  onSetFileBookmarkStatus,
  onToggleFolder,
}: {
  diff: WorkspaceDiffSummary | null;
  expandedFolderPaths: ReadonlySet<string>;
  rootPath?: string | null;
  repoFiles: string[];
  selectedPath?: string | null;
  getFileBookmarkStatus?: (path: string) => SidebarFileStatus | null;
  onOpenFile: (path: string) => void;
  onSetFileBookmarkStatus?: (
    path: string,
    status: SidebarFileStatus | "none",
  ) => void;
  onToggleFolder: (path: string) => void;
}) {
  const files = diff?.files ?? [];
  const changedByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const normalizedRootPath = rootPath?.replace(/^\/+|\/+$/g, "") || null;
  const visibleRepoFiles = useMemo(() => {
    if (!normalizedRootPath) return repoFiles;
    const prefix = `${normalizedRootPath}/`;
    return repoFiles
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
      .filter(Boolean);
  }, [normalizedRootPath, repoFiles]);

  return (
    <div className="workspace-diff-files-view">
      <WorkspaceFileTree
        changedByPath={changedByPath}
        expandedFolderPaths={expandedFolderPaths}
        rootPath={normalizedRootPath}
        repoFiles={visibleRepoFiles}
        selectedPath={selectedPath}
        getFileBookmarkStatus={getFileBookmarkStatus}
        onOpenFile={onOpenFile}
        onSetFileBookmarkStatus={onSetFileBookmarkStatus}
        onToggleFolder={onToggleFolder}
      />
    </div>
  );
}
