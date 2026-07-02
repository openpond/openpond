export type ChatFilePathMatch = {
  displayPath: string;
  path: string;
  end: number;
};

export type ChatFilePathOptions = {
  workspaceRootPath?: string | null;
};

const FILE_EXTENSIONS = new Set([
  "bash",
  "c",
  "cc",
  "cjs",
  "cpp",
  "css",
  "csv",
  "env",
  "gif",
  "go",
  "graphql",
  "h",
  "hpp",
  "html",
  "ico",
  "java",
  "jpeg",
  "jpg",
  "js",
  "json",
  "jsx",
  "lock",
  "lockb",
  "md",
  "mdx",
  "mjs",
  "png",
  "py",
  "rs",
  "scss",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "webp",
  "yaml",
  "yml",
  "zsh",
]);

const EXTENSIONLESS_FILES = new Set(["AGENTS.md", "Dockerfile", "LICENSE", "Makefile", "README"]);
const SEGMENT = String.raw`[A-Za-z0-9_.@+-]+`;
const PATH_WITH_SLASH = new RegExp(
  String.raw`^(?:(?:\.{1,2}|~)?[\\/]|[A-Za-z]:[\\/])?(?:${SEGMENT}[\\/])+${SEGMENT}(?::\d+(?::\d+)?)?`,
);
const SINGLE_FILE = new RegExp(String.raw`^${SEGMENT}(?::\d+(?::\d+)?)?`);

export function matchChatFilePathAt(
  content: string,
  start: number,
  options: ChatFilePathOptions = {},
): ChatFilePathMatch | null {
  if (!isPathBoundary(content[start - 1])) return null;
  const slashMatch = PATH_WITH_SLASH.exec(content.slice(start));
  const singleMatch = slashMatch ? null : SINGLE_FILE.exec(content.slice(start));
  const raw = trimTrailingPathPunctuation((slashMatch ?? singleMatch)?.[0] ?? "");
  if (!raw) return null;
  const normalized = normalizeChatFilePath(raw, options);
  if (!normalized) return null;
  return { ...normalized, end: start + raw.length };
}

export function normalizeChatFilePath(
  value: string,
  options: ChatFilePathOptions = {},
): Omit<ChatFilePathMatch, "end"> | null {
  const displayPath = trimTrailingPathPunctuation(value.trim().replace(/^['"`]+|['"`]+$/g, ""));
  if (!displayPath || /^https?:\/\//i.test(displayPath)) return null;
  const pathWithoutLine = displayPath.replace(/:\d+(?::\d+)?$/, "");
  if (!isLikelyFilePath(pathWithoutLine)) return null;
  return {
    displayPath,
    path: normalizeWorkspacePath(pathWithoutLine, options.workspaceRootPath),
  };
}

function normalizeWorkspacePath(path: string, workspaceRootPath: string | null | undefined): string {
  let normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const root = workspaceRootPath?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return normalized;
  if (normalized.startsWith(`${root}/`)) normalized = normalized.slice(root.length + 1);
  const rootName = root.split("/").filter(Boolean).at(-1);
  if (rootName && normalized.startsWith(`${rootName}/`)) normalized = normalized.slice(rootName.length + 1);
  return normalized;
}

function isLikelyFilePath(path: string): boolean {
  const fileName = path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? path;
  if (EXTENSIONLESS_FILES.has(fileName)) return true;
  if (fileName.startsWith(".") && fileName.length > 1) return true;
  const extension = fileName.includes(".") ? fileName.split(".").at(-1)?.toLowerCase() : null;
  return Boolean(extension && FILE_EXTENSIONS.has(extension));
}

function isPathBoundary(value: string | undefined): boolean {
  return !value || /[\s([{<"'`]/.test(value);
}

function trimTrailingPathPunctuation(value: string): string {
  return value.replace(/[.,;!?]+$/, "").replace(/[\])}]+$/, "");
}
