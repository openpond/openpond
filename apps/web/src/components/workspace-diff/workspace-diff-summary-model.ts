export type FileTreeNode = {
  name: string;
  path: string;
  type: "folder" | "file";
  children: FileTreeNode[];
};

type MutableFileTreeNode = FileTreeNode & {
  childMap: Map<string, MutableFileTreeNode>;
};

export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root = createFileTreeNode("", "", "folder");
  for (const filePath of paths) {
    const directoryPath = filePath.endsWith("/");
    const parts = filePath.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let current = root;
    let currentPath = "";
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const type = !directoryPath && index === parts.length - 1 ? "file" : "folder";
      const key = `${type}:${part}`;
      let child = current.childMap.get(key);
      if (!child) {
        child = createFileTreeNode(part, currentPath, type);
        current.childMap.set(key, child);
        current.children.push(child);
      }
      current = child;
    }
  }
  return sortFileTree(root.children);
}

function createFileTreeNode(name: string, path: string, type: FileTreeNode["type"]): MutableFileTreeNode {
  return { name, path, type, children: [], childMap: new Map() };
}

function sortFileTree(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
    .map((node) => ({
      name: node.name,
      path: node.path,
      type: node.type,
      children: sortFileTree(node.children),
    }));
}
