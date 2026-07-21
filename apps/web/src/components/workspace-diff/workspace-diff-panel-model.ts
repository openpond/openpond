import type { WorkspaceDiffFile } from "@openpond/contracts";

export type DiffTab = "goal" | "summary" | "files" | "file";

export type WorkspaceDiffPanelViewState = {
  activeTab: DiffTab;
  openFilePaths: string[];
  selectedPath: string | null;
};

export type WorkspaceDiffTabRequest = {
  id: number;
  tab: Extract<DiffTab, "files" | "summary">;
};

export type WorkspaceDiffSideChatTab = {
  id: string;
  title: string;
};

export type WorkspaceFileSourceValue = "local" | "sandbox";

export type WorkspaceFileSourceOption = {
  value: WorkspaceFileSourceValue;
  label: string;
};

export type WorkspaceFileSourceSwitcher = {
  value: WorkspaceFileSourceValue;
  options: WorkspaceFileSourceOption[];
  onChange: (value: WorkspaceFileSourceValue) => void;
};

export type WorkspaceDiffRefreshOptions = {
  silent?: boolean;
};

export type FileDraft = {
  content: string;
  savedContent: string;
  savedAt?: number;
};

export type SandboxFileSource = {
  sandboxId: string | null;
  emptyMessage: string;
};

export const WORKSPACE_TEMPLATE_CONFIG_PATH = "openpond.config.json";

export type RovingTabKey = "ArrowRight" | "ArrowLeft" | "Home" | "End";

export function nextRovingTabIndex(
  currentIndex: number,
  tabCount: number,
  key: RovingTabKey,
): number {
  if (tabCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return tabCount - 1;
  if (key === "ArrowRight") return (currentIndex + 1) % tabCount;
  return (currentIndex - 1 + tabCount) % tabCount;
}

export function defaultWorkspaceDiffPanelViewState(): WorkspaceDiffPanelViewState {
  return {
    activeTab: "files",
    openFilePaths: [],
    selectedPath: null,
  };
}

export function cloneWorkspaceDiffPanelViewState(
  state: WorkspaceDiffPanelViewState,
): WorkspaceDiffPanelViewState {
  return {
    activeTab: state.activeTab,
    openFilePaths: [...state.openFilePaths],
    selectedPath: state.selectedPath,
  };
}

export function normalizeWorkspaceDiffPanelViewState(
  state: WorkspaceDiffPanelViewState,
  workspaceRootPath: string | null | undefined = null,
): WorkspaceDiffPanelViewState {
  const openFilePaths = uniqueWorkspaceDiffPaths(
    state.openFilePaths
      .map((path) => normalizeWorkspaceDiffPath(path, workspaceRootPath))
      .filter(Boolean),
  );
  const selectedPath = state.selectedPath
    ? normalizeWorkspaceDiffPath(state.selectedPath, workspaceRootPath) || null
    : null;
  return {
    activeTab: state.activeTab === "file" && !selectedPath ? "files" : state.activeTab,
    openFilePaths,
    selectedPath,
  };
}

export function workspaceDiffPanelViewStatesEqual(
  left: WorkspaceDiffPanelViewState,
  right: WorkspaceDiffPanelViewState,
): boolean {
  return (
    left.activeTab === right.activeTab &&
    left.selectedPath === right.selectedPath &&
    left.openFilePaths.length === right.openFilePaths.length &&
    left.openFilePaths.every((path, index) => path === right.openFilePaths[index])
  );
}

export function normalizeWorkspaceDiffPath(
  value: string,
  workspaceRootPath: string | null | undefined = null,
): string {
  let normalized = normalizeWorkspaceDiffPathValue(value);
  const root = workspaceRootPath?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return normalized;
  if (normalized === root) return "";
  if (normalized.startsWith(`${root}/`)) normalized = normalized.slice(root.length + 1);
  const rootName = root.split("/").filter(Boolean).at(-1);
  if (rootName && normalized.startsWith(`${rootName}/`)) normalized = normalized.slice(rootName.length + 1);
  return normalized;
}

export function isAbsoluteWorkspaceDiffPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

export function placeholderFile(path: string): WorkspaceDiffFile {
  return {
    path,
    status: "unchanged",
    additions: 0,
    deletions: 0,
    patch: "",
    content: null,
  };
}

export function isDirectoryLikeDiffFile(file: WorkspaceDiffFile, repoFiles: string[]): boolean {
  const normalizedPath = normalizeDiffPath(file.path);
  if (!normalizedPath || file.path.endsWith("/")) return true;
  if (file.content == null && /Could not access .+\/null['"]?/.test(file.patch)) return true;

  return repoFiles.some((candidate) => {
    const normalizedCandidate = normalizeDiffPath(candidate);
    return Boolean(normalizedCandidate && normalizedCandidate.startsWith(`${normalizedPath}/`));
  });
}

export function isMarkdownPath(filePath: string): boolean {
  return /\.(?:md|markdown|mdx)$/i.test(filePath) || /(?:^|\/)readme$/i.test(filePath);
}

export function isDocumentPath(filePath: string): boolean {
  return /\.(?:doc|docx)$/i.test(filePath);
}

function normalizeWorkspaceDiffPathValue(value: string): string {
  let normalized = value.trim().replace(/^['"`]+|['"`]+$/g, "");
  if (/^file:\/\//i.test(normalized)) {
    try {
      normalized = decodeURIComponent(new URL(normalized).pathname);
    } catch {
      normalized = normalized.replace(/^file:\/\//i, "");
    }
  }
  return normalized.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function uniqueWorkspaceDiffPaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

function normalizeDiffPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  return parts.join("/");
}
