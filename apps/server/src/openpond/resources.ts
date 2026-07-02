import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isGeneratedWorkspacePath,
  listPlainWorkspaceFiles,
  normalizeWorkspaceFilePath,
  workspaceImageContentType,
} from "../workspace/workspaces.js";
import { listWorkspaceFiles, searchWorkspaceFiles } from "../workspace-tools/workspace-tool-file-system.js";

export type ResourceReadRequest = {
  ref: string;
  maxBytes?: number;
  mode?: "content" | "summary" | "metadata";
};

export type ResourceSearchRequest = {
  scope: "workspace" | "git" | "events" | "messages" | "artifacts" | "goal-context" | "sandbox";
  query: string;
  limit?: number;
  filters?: Record<string, unknown>;
};

export type ResourceReadResult = {
  ref: string;
  kind: string;
  title: string;
  contentType: string | null;
  contentText?: string;
  summary?: string;
  metadata: Record<string, unknown>;
  relatedRefs: string[];
  truncation: {
    truncated: boolean;
    originalBytes?: number;
    returnedBytes?: number;
    reason?: string;
  };
};

export type ResourceSearchResult = {
  query: string;
  scope: string;
  items: Array<{
    ref: string;
    title: string;
    snippet?: string;
    score?: number;
    metadata: Record<string, unknown>;
  }>;
  truncated: boolean;
};

const DEFAULT_RESOURCE_MAX_BYTES = 60_000;
const MAX_RESOURCE_MAX_BYTES = 240_000;
const DEFAULT_RESOURCE_SEARCH_LIMIT = 20;
const MAX_RESOURCE_SEARCH_LIMIT = 100;
const TEXT_SAMPLE_BYTES = 4096;
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".db",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp4",
  ".pdf",
  ".png",
  ".sqlite",
  ".tar",
  ".webp",
  ".xls",
  ".xlsm",
  ".xlsx",
  ".zip",
]);

type ParsedResourceRef =
  | { scope: "workspace"; kind: "file"; identifier: string }
  | { scope: "workspace"; kind: "dir"; identifier: string };

type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  kind: "directory" | "file" | "other";
  ref: string;
};

export async function readLocalWorkspaceResource(input: {
  repoPath: string;
  request: ResourceReadRequest;
}): Promise<ResourceReadResult> {
  const parsed = parseResourceRef(input.request.ref);
  if (parsed.scope !== "workspace") {
    throw new Error(`Unsupported resource scope: ${parsed.scope}`);
  }
  if (parsed.kind === "dir") {
    return readWorkspaceDirectoryResource(input.repoPath, parsed.identifier, input.request);
  }
  return readWorkspaceFileResource(input.repoPath, parsed.identifier, input.request);
}

export async function searchLocalWorkspaceResources(input: {
  repoPath: string;
  request: ResourceSearchRequest;
}): Promise<ResourceSearchResult> {
  if (input.request.scope !== "workspace") {
    throw new Error(`Unsupported resource search scope: ${input.request.scope}`);
  }
  const query = input.request.query.trim();
  if (!query) throw new Error("Resource search query is required");

  const limit = normalizeLimit(input.request.limit, DEFAULT_RESOURCE_SEARCH_LIMIT, MAX_RESOURCE_SEARCH_LIMIT);
  const items: ResourceSearchResult["items"] = [];
  const seen = new Set<string>();
  const addItem = (item: ResourceSearchResult["items"][number]) => {
    if (items.length >= limit || seen.has(item.ref)) return;
    seen.add(item.ref);
    items.push(item);
  };

  const files = await visibleWorkspaceFiles(input.repoPath);
  const lowerQuery = query.toLowerCase();
  for (const filePath of files) {
    if (!filePath.toLowerCase().includes(lowerQuery)) continue;
    addItem({
      ref: workspaceFileRef(filePath),
      title: filePath,
      snippet: "Path match",
      score: 1,
      metadata: { source: "workspace", matchKind: "path", path: filePath },
    });
  }

  if (items.length < limit) {
    const matches = await searchWorkspaceFiles(input.repoPath, query);
    for (const match of matches) {
      addItem({
        ref: workspaceFileRef(match.path),
        title: match.path,
        snippet: `${match.line}: ${match.text}`,
        score: 0.8,
        metadata: {
          source: "workspace",
          matchKind: "text",
          path: match.path,
          line: match.line,
        },
      });
    }
  }

  return {
    query,
    scope: input.request.scope,
    items,
    truncated: items.length >= limit,
  };
}

function parseResourceRef(ref: string): ParsedResourceRef {
  const trimmed = ref.trim();
  if (trimmed.startsWith("workspace:file:")) {
    return { scope: "workspace", kind: "file", identifier: trimmed.slice("workspace:file:".length) };
  }
  if (trimmed.startsWith("workspace:dir:")) {
    return { scope: "workspace", kind: "dir", identifier: trimmed.slice("workspace:dir:".length) };
  }
  throw new Error("Unsupported resource ref. Use workspace:file:<path> or workspace:dir:<path>.");
}

async function readWorkspaceFileResource(
  repoPath: string,
  identifier: string,
  request: ResourceReadRequest,
): Promise<ResourceReadResult> {
  const filePath = normalizeRequiredWorkspacePath(identifier);
  const targetPath = await resolveWorkspacePath(repoPath, filePath);
  const stat = await fs.lstat(targetPath);
  if (!stat.isFile()) throw new Error(`Not a file resource: ${filePath}`);

  const contentType = contentTypeForPath(filePath);
  const maxBytes = normalizeMaxBytes(request.maxBytes);
  const binary = await isBinaryFile(targetPath, filePath);
  const metadata = {
    path: filePath,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    binary,
  };
  if (request.mode === "metadata" || binary) {
    return {
      ref: workspaceFileRef(filePath),
      kind: "workspace.file",
      title: filePath,
      contentType,
      metadata,
      relatedRefs: [],
      truncation: {
        truncated: false,
        originalBytes: stat.size,
        returnedBytes: 0,
        reason: binary ? "binary" : undefined,
      },
    };
  }

  const content = await readTextWithLimit(targetPath, stat.size, maxBytes);
  return {
    ref: workspaceFileRef(filePath),
    kind: "workspace.file",
    title: filePath,
    contentType,
    contentText: content.text,
    metadata: {
      ...metadata,
      lineCount: countLines(content.text),
    },
    relatedRefs: [workspaceDirRef(path.dirname(filePath) === "." ? "" : path.dirname(filePath))],
    truncation: content.truncation,
  };
}

async function readWorkspaceDirectoryResource(
  repoPath: string,
  identifier: string,
  request: ResourceReadRequest,
): Promise<ResourceReadResult> {
  const dirPath = normalizeOptionalWorkspacePath(identifier);
  const targetPath = await resolveWorkspacePath(repoPath, dirPath);
  const stat = await fs.lstat(targetPath);
  if (!stat.isDirectory()) throw new Error(`Not a directory resource: ${dirPath || "."}`);

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const visible: WorkspaceDirectoryEntry[] = entries
    .map((entry) => {
      const entryPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
      if (isGeneratedWorkspacePath(entryPath)) return null;
      return {
        name: entry.name,
        path: entryPath,
        kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        ref: entry.isDirectory() ? workspaceDirRef(entryPath) : workspaceFileRef(entryPath),
      };
    })
    .filter((entry): entry is WorkspaceDirectoryEntry => Boolean(entry))
    .sort((left, right) => left.path.localeCompare(right.path));
  const maxBytes = normalizeMaxBytes(request.maxBytes);
  const fullText = visible.map((entry) => `${entry.kind === "directory" ? "dir " : "file"} ${entry.path}`).join("\n");
  const content = trimUtf8Text(fullText, maxBytes);

  return {
    ref: workspaceDirRef(dirPath),
    kind: "workspace.dir",
    title: dirPath || ".",
    contentType: "inode/directory",
    ...(request.mode === "metadata" ? {} : { contentText: content.text }),
    metadata: {
      path: dirPath,
      entryCount: visible.length,
      entries: visible,
      modifiedAt: stat.mtime.toISOString(),
    },
    relatedRefs: visible.slice(0, 50).map((entry) => entry.ref),
    truncation: content.truncation,
  };
}

async function visibleWorkspaceFiles(repoPath: string): Promise<string[]> {
  try {
    return await listWorkspaceFiles(repoPath);
  } catch {
    return listPlainWorkspaceFiles(repoPath);
  }
}

async function resolveWorkspacePath(repoPath: string, relativePath: string): Promise<string> {
  const root = await fs.realpath(repoPath);
  const target = path.resolve(root, relativePath || ".");
  assertInside(root, target);
  const realTarget = await fs.realpath(target);
  assertInside(root, realTarget);
  return realTarget;
}

function assertInside(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Resource path escapes the workspace root");
  }
}

function normalizeRequiredWorkspacePath(input: string): string {
  const normalized = normalizeWorkspaceFilePath(input);
  if (!normalized) throw new Error("Resource path is required");
  return normalized;
}

function normalizeOptionalWorkspacePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed === ".") return "";
  return normalizeRequiredWorkspacePath(trimmed);
}

function normalizeMaxBytes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_RESOURCE_MAX_BYTES;
  return Math.min(Math.floor(value), MAX_RESOURCE_MAX_BYTES);
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function workspaceFileRef(filePath: string): string {
  return `workspace:file:${filePath}`;
}

function workspaceDirRef(dirPath: string): string {
  return `workspace:dir:${dirPath || "."}`;
}

function contentTypeForPath(filePath: string): string | null {
  const imageType = workspaceImageContentType(filePath);
  if (imageType) return imageType;
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".json") return "application/json";
  if (extension === ".md" || extension === ".mdx") return "text/markdown";
  if ([".css", ".csv", ".html", ".js", ".jsx", ".ts", ".tsx", ".txt", ".yaml", ".yml"].includes(extension)) {
    return "text/plain";
  }
  return null;
}

async function isBinaryFile(targetPath: string, filePath: string): Promise<boolean> {
  if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return true;
  const file = await fs.open(targetPath, "r");
  try {
    const sample = Buffer.alloc(TEXT_SAMPLE_BYTES);
    const { bytesRead } = await file.read(sample, 0, sample.length, 0);
    return sample.subarray(0, bytesRead).includes(0);
  } finally {
    await file.close();
  }
}

async function readTextWithLimit(
  targetPath: string,
  sizeBytes: number,
  maxBytes: number,
): Promise<Pick<ResourceReadResult, "truncation"> & { text: string }> {
  if (sizeBytes <= maxBytes) {
    const buffer = await fs.readFile(targetPath);
    return {
      text: buffer.toString("utf8"),
      truncation: { truncated: false, originalBytes: sizeBytes, returnedBytes: buffer.length },
    };
  }

  const headBytes = Math.max(1, Math.floor(maxBytes / 2));
  const tailBytes = Math.max(1, maxBytes - headBytes);
  const file = await fs.open(targetPath, "r");
  try {
    const head = Buffer.alloc(headBytes);
    const tail = Buffer.alloc(tailBytes);
    const headRead = await file.read(head, 0, head.length, 0);
    const tailStart = Math.max(0, sizeBytes - tailBytes);
    const tailRead = await file.read(tail, 0, tail.length, tailStart);
    return {
      text: [
        head.subarray(0, headRead.bytesRead).toString("utf8"),
        "\n\n[resource truncated: middle omitted]\n\n",
        tail.subarray(0, tailRead.bytesRead).toString("utf8"),
      ].join(""),
      truncation: {
        truncated: true,
        originalBytes: sizeBytes,
        returnedBytes: headRead.bytesRead + tailRead.bytesRead,
        reason: "maxBytes",
      },
    };
  } finally {
    await file.close();
  }
}

function trimUtf8Text(value: string, maxBytes: number): Pick<ResourceReadResult, "truncation"> & { text: string } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) {
    return {
      text: value,
      truncation: { truncated: false, originalBytes: buffer.length, returnedBytes: buffer.length },
    };
  }
  const trimmed = buffer.subarray(0, maxBytes).toString("utf8");
  return {
    text: `${trimmed}\n\n[resource truncated]`,
    truncation: {
      truncated: true,
      originalBytes: buffer.length,
      returnedBytes: maxBytes,
      reason: "maxBytes",
    },
  };
}

function countLines(value: string): number {
  if (!value) return 0;
  return value.split(/\r?\n/).length;
}
