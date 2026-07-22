import { useMemo } from "react";
import { File, Folder, FolderOpen } from "../icons";
import type { SidebarFileStatus, WorkspaceDiffFile } from "@openpond/contracts";
import { buildFileTree, type FileTreeNode } from "./workspace-diff-summary-model";
import { WorkspaceFileBookmarkActions } from "./WorkspaceFileBookmarkActions";

export function WorkspaceFileTree({
  changedByPath,
  expandedFolderPaths,
  rootPath,
  repoFiles,
  selectedPath,
  getFileBookmarkStatus,
  onOpenFile,
  onSetFileBookmarkStatus,
  onToggleFolder,
}: {
  changedByPath: Map<string, WorkspaceDiffFile>;
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
  const tree = useMemo(() => buildFileTree(repoFiles), [repoFiles]);

  return (
    <div className="workspace-file-tree-view">
      <div className="workspace-file-tree-header">
        <FolderOpen size={14} />
        <strong title={rootPath ?? undefined}>{rootPath ? rootPath.split("/").at(-1) : "Files"}</strong>
        <span>{repoFiles.length}</span>
      </div>
      <div className="workspace-file-tree">
        {tree.map((node) => (
          <FileTreeNodeRow
            changedByPath={changedByPath}
            expandedFolderPaths={expandedFolderPaths}
            key={`${node.type}:${node.path}`}
            node={node}
            rootPath={rootPath}
            selectedPath={selectedPath}
            getFileBookmarkStatus={getFileBookmarkStatus}
            onOpenFile={onOpenFile}
            onSetFileBookmarkStatus={onSetFileBookmarkStatus}
            onToggleFolder={onToggleFolder}
          />
        ))}
      </div>
    </div>
  );
}

function FileTreeNodeRow({
  changedByPath,
  depth = 0,
  expandedFolderPaths,
  node,
  rootPath,
  selectedPath,
  getFileBookmarkStatus,
  onOpenFile,
  onSetFileBookmarkStatus,
  onToggleFolder,
}: {
  changedByPath: Map<string, WorkspaceDiffFile>;
  depth?: number;
  expandedFolderPaths: ReadonlySet<string>;
  node: FileTreeNode;
  rootPath?: string | null;
  selectedPath?: string | null;
  getFileBookmarkStatus?: (path: string) => SidebarFileStatus | null;
  onOpenFile: (path: string) => void;
  onSetFileBookmarkStatus?: (
    path: string,
    status: SidebarFileStatus | "none",
  ) => void;
  onToggleFolder: (path: string) => void;
}) {
  const resolvedPath = rootPath ? `${rootPath}/${node.path}` : node.path;
  const open = node.type === "folder" && expandedFolderPaths.has(resolvedPath);
  const changed = changedByPath.get(resolvedPath);
  const rowPaddingLeft = 2 + depth * 11;

  if (node.type === "folder") {
    return (
      <div className="workspace-file-tree-node">
        <button
          type="button"
          className="workspace-file-tree-row folder"
          aria-expanded={open}
          style={{ paddingLeft: rowPaddingLeft }}
          onClick={() => onToggleFolder(resolvedPath)}
        >
          {open ? <FolderOpen size={14} /> : <Folder size={14} />}
          <span>{node.name}</span>
        </button>
        {open &&
          node.children.map((child) => (
            <FileTreeNodeRow
              changedByPath={changedByPath}
              depth={depth + 1}
              expandedFolderPaths={expandedFolderPaths}
              key={`${child.type}:${child.path}`}
              node={child}
              rootPath={rootPath}
              selectedPath={selectedPath}
              getFileBookmarkStatus={getFileBookmarkStatus}
              onOpenFile={onOpenFile}
              onSetFileBookmarkStatus={onSetFileBookmarkStatus}
              onToggleFolder={onToggleFolder}
            />
          ))}
      </div>
    );
  }
  return (
    <div
      className={`workspace-file-tree-row file ${changed ? "changed" : ""} ${selectedPath === resolvedPath ? "selected" : ""}`}
      style={{ paddingLeft: rowPaddingLeft }}
    >
      <button
        type="button"
        className="workspace-file-tree-row-main"
        title={resolvedPath}
        onClick={() => onOpenFile(resolvedPath)}
      >
        <File size={13} />
        <span>{node.name}</span>
        {changed && (
          <small>
            <span className="diff-addition">+{changed.additions}</span>
            <span className="diff-deletion">-{changed.deletions}</span>
          </small>
        )}
      </button>
      {onSetFileBookmarkStatus ? (
        <WorkspaceFileBookmarkActions
          className="workspace-file-tree-bookmark-actions"
          currentStatus={getFileBookmarkStatus?.(resolvedPath) ?? null}
          onSetStatus={(status) => onSetFileBookmarkStatus(resolvedPath, status)}
        />
      ) : null}
    </div>
  );
}
