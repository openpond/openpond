import { useMemo } from "react";
import type { WorkspaceDiffSummary } from "@openpond/contracts";
import { WorkspaceFileTree } from "./WorkspaceFileTree";

export function WorkspaceDiffFiles({
  diff,
  expandedFolderPaths,
  rootPath,
  repoFiles,
  onOpenFile,
  onToggleFolder,
}: {
  diff: WorkspaceDiffSummary | null;
  expandedFolderPaths: ReadonlySet<string>;
  rootPath?: string | null;
  repoFiles: string[];
  onOpenFile: (path: string) => void;
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
        onOpenFile={onOpenFile}
        onToggleFolder={onToggleFolder}
      />
    </div>
  );
}
