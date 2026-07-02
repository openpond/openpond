import { useMemo } from "react";
import { ChevronDown } from "../icons";
import type { WorkspaceDiffSummary } from "@openpond/contracts";
import { WorkspaceFileTree } from "./WorkspaceFileTree";

export function DiffSummary({
  diff,
  repoFiles,
  onOpenFile,
}: {
  diff: WorkspaceDiffSummary | null;
  repoFiles: string[];
  onOpenFile: (path: string) => void;
}) {
  const files = diff?.files ?? [];
  const changedByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  return (
    <div className="workspace-diff-summary-view">
      <WorkspaceFileTree changedByPath={changedByPath} repoFiles={repoFiles} onOpenFile={onOpenFile} />
      <WorkspaceChangedFilesSummary files={files} onOpenFile={onOpenFile} />
    </div>
  );
}

function WorkspaceChangedFilesSummary({
  files,
  onOpenFile,
}: {
  files: WorkspaceDiffSummary["files"];
  onOpenFile: (path: string) => void;
}) {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <div className="workspace-diff-summary-card">
      <div className="workspace-diff-summary-header">
        <strong>
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </strong>
        <span className="workspace-diff-counts">
          <span className="diff-addition">+{additions}</span>
          <span className="diff-deletion">-{deletions}</span>
        </span>
      </div>
      <div className="workspace-diff-summary-files">
        {files.map((file) => (
          <button type="button" key={file.path} onClick={() => onOpenFile(file.path)}>
            <span>{file.path}</span>
            <span className="workspace-diff-counts">
              <span className="diff-addition">+{file.additions}</span>
              <span className="diff-deletion">-{file.deletions}</span>
            </span>
            <ChevronDown size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}
