import { useMemo } from "react";
import { File, Folder, FolderOpen } from "../icons";
import type { WorkspaceDiffFile } from "@openpond/contracts";
import { buildFileTree, type FileTreeNode } from "./workspace-diff-summary-model";

export function WorkspaceFileTree({
  changedByPath,
  expandedFolderPaths,
  repoFiles,
  onOpenFile,
  onToggleFolder,
}: {
  changedByPath: Map<string, WorkspaceDiffFile>;
  expandedFolderPaths: ReadonlySet<string>;
  repoFiles: string[];
  onOpenFile: (path: string) => void;
  onToggleFolder: (path: string) => void;
}) {
  const tree = useMemo(() => buildFileTree(repoFiles), [repoFiles]);

  return (
    <div className="workspace-file-tree-view">
      <div className="workspace-file-tree-header">
        <FolderOpen size={14} />
        <strong>Files</strong>
        <span>{repoFiles.length}</span>
      </div>
      <div className="workspace-file-tree">
        {tree.map((node) => (
          <FileTreeNodeRow
            changedByPath={changedByPath}
            expandedFolderPaths={expandedFolderPaths}
            key={`${node.type}:${node.path}`}
            node={node}
            onOpenFile={onOpenFile}
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
  onOpenFile,
  onToggleFolder,
}: {
  changedByPath: Map<string, WorkspaceDiffFile>;
  depth?: number;
  expandedFolderPaths: ReadonlySet<string>;
  node: FileTreeNode;
  onOpenFile: (path: string) => void;
  onToggleFolder: (path: string) => void;
}) {
  const open = node.type === "folder" && expandedFolderPaths.has(node.path);
  const changed = changedByPath.get(node.path);
  const rowPaddingLeft = 2 + depth * 11;

  if (node.type === "folder") {
    return (
      <div className="workspace-file-tree-node">
        <button
          type="button"
          className="workspace-file-tree-row folder"
          aria-expanded={open}
          style={{ paddingLeft: rowPaddingLeft }}
          onClick={() => onToggleFolder(node.path)}
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
              onOpenFile={onOpenFile}
              onToggleFolder={onToggleFolder}
            />
          ))}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`workspace-file-tree-row file ${changed ? "changed" : ""}`}
      style={{ paddingLeft: rowPaddingLeft }}
      onClick={() => onOpenFile(node.path)}
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
  );
}
