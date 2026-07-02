import type { WorkspaceDiffFile } from "@openpond/contracts";

export type DiffTab = "goal" | "summary" | "file" | "review";

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

function normalizeDiffPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  return parts.join("/");
}
