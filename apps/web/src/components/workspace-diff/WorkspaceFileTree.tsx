import { useEffect, useMemo, useState } from "react";
import { File, Folder, FolderOpen } from "../icons";
import type { WorkspaceDiffFile } from "@openpond/contracts";
import { buildFileTree, type FileTreeNode } from "./workspace-diff-summary-model";

export function WorkspaceFileTree({
  changedByPath,
  repoFiles,
  onOpenFile,
}: {
  changedByPath: Map<string, WorkspaceDiffFile>;
  repoFiles: string[];
  onOpenFile: (path: string) => void;
}) {
  const tree = useMemo(() => buildFileTree(repoFiles), [repoFiles]);
  const autoExpandedPaths = useMemo(() => {
    const paths = new Set<string>();
    const changedPaths = new Set(changedByPath.keys());
    for (const node of tree) collectAutoExpandedFolders(node, changedPaths, paths, 0);
    return paths;
  }, [changedByPath, tree]);

  return (
    <div className="workspace-file-tree-card">
      <div className="workspace-file-tree-header">
        <FolderOpen size={14} />
        <strong>Files</strong>
        <span>{repoFiles.length}</span>
      </div>
      <div className="workspace-file-tree">
        {tree.map((node) => (
          <FileTreeNodeRow
            autoExpandedPaths={autoExpandedPaths}
            changedByPath={changedByPath}
            key={`${node.type}:${node.path}`}
            node={node}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </div>
  );
}

function FileTreeNodeRow({
  autoExpandedPaths,
  changedByPath,
  depth = 0,
  node,
  onOpenFile,
}: {
  autoExpandedPaths: Set<string>;
  changedByPath: Map<string, WorkspaceDiffFile>;
  depth?: number;
  node: FileTreeNode;
  onOpenFile: (path: string) => void;
}) {
  const shouldAutoOpen = node.type === "folder" && autoExpandedPaths.has(node.path);
  const [open, setOpen] = useState(shouldAutoOpen);
  const changed = changedByPath.get(node.path);

  useEffect(() => {
    if (shouldAutoOpen) setOpen(true);
  }, [shouldAutoOpen]);

  if (node.type === "folder") {
    return (
      <div className="workspace-file-tree-node">
        <button
          type="button"
          className="workspace-file-tree-row folder"
          aria-expanded={open}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <FolderOpen size={14} /> : <Folder size={14} />}
          <span>{node.name}</span>
        </button>
        {open &&
          node.children.map((child) => (
            <FileTreeNodeRow
              changedByPath={changedByPath}
              autoExpandedPaths={autoExpandedPaths}
              depth={depth + 1}
              key={`${child.type}:${child.path}`}
              node={child}
              onOpenFile={onOpenFile}
            />
          ))}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`workspace-file-tree-row file ${changed ? "changed" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 }}
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

function collectAutoExpandedFolders(
  node: FileTreeNode,
  changedPaths: Set<string>,
  autoExpandedPaths: Set<string>,
  depth: number
): boolean {
  if (node.type === "file") return changedPaths.has(node.path);

  let hasChangedDescendant = false;
  for (const child of node.children) {
    if (collectAutoExpandedFolders(child, changedPaths, autoExpandedPaths, depth + 1)) {
      hasChangedDescendant = true;
    }
  }

  if (depth < 1 || hasChangedDescendant) {
    autoExpandedPaths.add(node.path);
  }
  return hasChangedDescendant;
}
