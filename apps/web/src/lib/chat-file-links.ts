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
  "m4v",
  "mjs",
  "mov",
  "mp4",
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
  "webm",
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
const RESOURCE_FILE_REF = /^(?:workspace|sandbox):file:[^\s<>()]+/;

export function matchChatFilePathAt(
  content: string,
  start: number,
  options: ChatFilePathOptions = {},
): ChatFilePathMatch | null {
  if (!isPathBoundary(content[start - 1])) return null;
  const slice = content.slice(start);
  const resourceMatch = RESOURCE_FILE_REF.exec(slice);
  const slashMatch = resourceMatch ? null : PATH_WITH_SLASH.exec(slice);
  const singleMatch = resourceMatch || slashMatch ? null : SINGLE_FILE.exec(slice);
  const raw = trimTrailingPathPunctuation((resourceMatch ?? slashMatch ?? singleMatch)?.[0] ?? "");
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
  const pathWithResourceRef = normalizeFileUrlPath(normalizeResourceFileRefPath(displayPath));
  const pathWithoutLine = pathWithResourceRef.replace(/:\d+(?::\d+)?$/, "");
  if (!isLikelyFilePath(pathWithoutLine)) return null;
  return {
    displayPath,
    path: normalizeWorkspacePath(pathWithoutLine, options.workspaceRootPath),
  };
}

function normalizeResourceFileRefPath(path: string): string {
  const resourceMatch = /^(workspace|sandbox):file:(.*)$/i.exec(path);
  if (!resourceMatch) return path;
  const kind = resourceMatch[1]?.toLowerCase();
  let value = resourceMatch[2] ?? "";
  if (kind === "sandbox") {
    value = value.replace(/^\/workspace\/app\//, "").replace(/^\/workspace\//, "");
  }
  return value;
}

function normalizeFileUrlPath(path: string): string {
  if (!/^file:\/\//i.test(path)) return path;
  try {
    return decodeURIComponent(new URL(path).pathname);
  } catch {
    return path.replace(/^file:\/\//i, "");
  }
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
