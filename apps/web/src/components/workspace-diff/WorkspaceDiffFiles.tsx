import { useMemo } from "react";
import type { WorkspaceDiffSummary } from "@openpond/contracts";
import { WorkspaceFileTree } from "./WorkspaceFileTree";

export function WorkspaceDiffFiles({
  diff,
  expandedFolderPaths,
  repoFiles,
  onOpenFile,
  onToggleFolder,
}: {
  diff: WorkspaceDiffSummary | null;
  expandedFolderPaths: ReadonlySet<string>;
  repoFiles: string[];
  onOpenFile: (path: string) => void;
  onToggleFolder: (path: string) => void;
}) {
  const files = diff?.files ?? [];
  const changedByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);

  return (
    <div className="workspace-diff-files-view">
      <WorkspaceFileTree
        changedByPath={changedByPath}
        expandedFolderPaths={expandedFolderPaths}
        repoFiles={repoFiles}
        onOpenFile={onOpenFile}
        onToggleFolder={onToggleFolder}
      />
    </div>
  );
}
