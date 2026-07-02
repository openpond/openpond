import path from "node:path";
import { promises as fs } from "node:fs";
import type { OpenPondApp, WorkspaceDiffFile, WorkspaceDiffSummary } from "@openpond/contracts";
import { now } from "../utils.js";
import { runWorkspaceCommand as runCommand } from "./workspace-command.js";
import {
  appWorkspacePaths,
  isGeneratedWorkspacePath,
  isGitRepo,
  isWorkspaceDirectory,
  isVisibleGitWorkspaceFile,
  listPlainWorkspaceFiles,
  normalizeWorkspaceFilePath,
  parseNumstat,
  parseStatusLine,
  pathExists,
  readWorkspaceImageFile,
  readWorkspaceFile,
  truncatePatch,
  uniqueSortedPaths,
  type GitStatusEntry,
  type WorkspaceImageFile,
} from "./workspace-common.js";

type GitWorkspaceContext = {
  commandCwd: string;
  pathPrefix: string;
};

type LoadWorkspaceDiffOptions = {
  includeFileDetails?: boolean;
};

const WORKSPACE_DIFF_FILE_CONCURRENCY = 6;
const WORKSPACE_DIFF_CACHE_MAX_ENTRIES = 60;
const workspaceDiffCache = new Map<string, WorkspaceDiffSummary>();

export async function mapWorkspaceDiffEntriesWithConcurrency<T, R>(
  entries: T[],
  mapper: (entry: T, index: number) => Promise<R>,
  concurrency = WORKSPACE_DIFF_FILE_CONCURRENCY,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(entries.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(entries[index]!, index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, entries.length) }, () => worker())
  );
  return results;
}

export function clearWorkspaceDiffCacheForTests(): void {
  workspaceDiffCache.clear();
}

export async function loadWorkspaceDiff(
  storeDir: string,
  app: OpenPondApp,
  options: LoadWorkspaceDiffOptions = {}
): Promise<WorkspaceDiffSummary> {
  const { repoPath } = appWorkspacePaths(storeDir, app.id);
  return loadWorkspaceDiffAtPath(repoPath, app.id, options);
}

export async function loadWorkspaceDiffAtPath(
  repoPath: string,
  workspaceId: string,
  options: LoadWorkspaceDiffOptions = {}
): Promise<WorkspaceDiffSummary> {
  const initialized = await isGitRepo(repoPath);
  if (!initialized) {
    const repoFiles = await listPlainWorkspaceFiles(repoPath);
    return {
      appId: workspaceId,
      repoPath,
      initialized: repoFiles.length > 0 || await pathExists(repoPath),
      dirty: false,
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      repoFiles,
      files: [],
      error: null,
      updatedAt: now(),
    };
  }
  const gitContext = await gitWorkspaceContext(repoPath);
  const pathspec = gitContext.pathPrefix || ".";

  const [headResult, statusResult] = await Promise.all([
    runCommand("git", ["rev-parse", "HEAD"], gitContext.commandCwd),
    runCommand("git", ["status", "--porcelain=v1", "-uall", "--", pathspec], gitContext.commandCwd),
  ]);

  if (statusResult.code !== 0) {
    return {
      appId: workspaceId,
      repoPath,
      initialized,
      dirty: false,
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      repoFiles: [],
      files: [],
      error: statusResult.stderr.trim() || statusResult.stdout.trim() || "Unable to read workspace diff",
      updatedAt: now(),
    };
  }

  const entries = statusResult.stdout
    .split("\n")
    .map(parseStatusLine)
    .filter((entry): entry is GitStatusEntry => Boolean(entry))
    .map((entry) => {
      const scopedPath = pathInWorkspace(entry.path, gitContext.pathPrefix);
      if (!scopedPath) return null;
      const normalizedPath = normalizeWorkspaceFilePath(scopedPath);
      return normalizedPath ? { ...entry, path: normalizedPath } : null;
    })
    .filter((entry): entry is GitStatusEntry => {
      if (!entry) return false;
      return !isGeneratedWorkspacePath(entry.path);
    });
  const worktreeSignature = await workspaceDiffWorktreeSignature(repoPath, entries);
  const cacheKey = workspaceDiffCacheKey({
    repoPath,
    workspaceId,
    includeFileDetails: Boolean(options.includeFileDetails),
    head: headResult.code === 0 ? headResult.stdout.trim() : "unborn",
    pathPrefix: gitContext.pathPrefix,
    status: statusResult.stdout,
    worktreeSignature,
  });
  const cached = workspaceDiffCache.get(cacheKey);
  if (cached) return cloneWorkspaceDiffSummary(cached);

  const fileEntries = (
    await mapWorkspaceDiffEntriesWithConcurrency(entries, async (entry) => (
      entry.status === "deleted" || !(await isWorkspaceDirectory(repoPath, entry.path)) ? entry : null
    ))
  ).filter((entry): entry is GitStatusEntry => Boolean(entry));
  const trackedFilesResult = await runCommand("git", ["ls-files", "--", pathspec], gitContext.commandCwd);
  const repoFiles = uniqueSortedPaths([
    ...(trackedFilesResult.code === 0
      ? trackedFilesResult.stdout
        .split("\n")
        .map((line) => pathInWorkspace(line.trim(), gitContext.pathPrefix))
        .filter((line): line is string => Boolean(line))
      : []),
    ...fileEntries.map((entry) => entry.path),
  ].filter((filePath) => !isGeneratedWorkspacePath(filePath)));
  const numstatResult = await runCommand("git", ["diff", "--numstat", "HEAD", "--", pathspec], gitContext.commandCwd);
  const stats = numstatResult.code === 0
    ? scopedNumstat(parseNumstat(numstatResult.stdout), gitContext.pathPrefix)
    : new Map<string, { additions: number; deletions: number }>();

  const trackedPatchMap = options.includeFileDetails
    ? await loadTrackedGitPatchMap(gitContext, fileEntries.filter((entry) => entry.status !== "untracked"))
    : new Map<string, string>();

  const files = await mapWorkspaceDiffEntriesWithConcurrency(fileEntries, async (entry) => {
    const shouldReadContent = options.includeFileDetails || entry.status === "untracked";
    const content = shouldReadContent && entry.status !== "deleted"
      ? await readWorkspaceFile(repoPath, entry.path)
      : null;
    const fileStats =
      entry.status === "untracked"
        ? { additions: countTextLines(content), deletions: 0 }
        : stats.get(entry.path) ?? { additions: 0, deletions: 0 };
    if (options.includeFileDetails) {
      return loadGitWorkspaceFileDetail(repoPath, entry, gitContext, fileStats, {
        content,
        patch: entry.status === "untracked" ? null : trackedPatchMap.get(entry.path) ?? null,
      });
    }
    return {
      path: entry.path,
      status: entry.status,
      additions: fileStats.additions,
      deletions: fileStats.deletions,
      patch: "",
      content: null,
    };
  });

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const summary = {
    appId: workspaceId,
    repoPath,
    initialized,
    dirty: files.length > 0,
    filesChanged: files.length,
    additions,
    deletions,
    repoFiles,
    files,
    error: null,
    updatedAt: now(),
  };
  writeWorkspaceDiffCache(cacheKey, summary);
  return cloneWorkspaceDiffSummary(summary);
}

function countTextLines(content: string | null): number {
  if (!content) return 0;
  const withoutTrailingNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
  return withoutTrailingNewline ? withoutTrailingNewline.split("\n").length : 0;
}

async function workspaceDiffWorktreeSignature(repoPath: string, entries: GitStatusEntry[]): Promise<string> {
  const rows = await mapWorkspaceDiffEntriesWithConcurrency(entries, async (entry) => {
    if (entry.status === "deleted") return `${entry.path}\t${entry.status}\tdeleted`;
    const target = path.resolve(repoPath, entry.path);
    const root = path.resolve(repoPath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      return `${entry.path}\t${entry.status}\toutside`;
    }
    try {
      const stat = await fs.lstat(target);
      const kind = stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
      return `${entry.path}\t${entry.status}\t${kind}\t${stat.size}\t${Math.trunc(stat.mtimeMs)}\t${Math.trunc(stat.ctimeMs)}`;
    } catch {
      return `${entry.path}\t${entry.status}\tmissing`;
    }
  });
  return rows.sort((left, right) => left.localeCompare(right)).join("\n");
}

function workspaceDiffCacheKey(input: {
  repoPath: string;
  workspaceId: string;
  includeFileDetails: boolean;
  head: string;
  pathPrefix: string;
  status: string;
  worktreeSignature: string;
}): string {
  return JSON.stringify(input);
}

function writeWorkspaceDiffCache(key: string, summary: WorkspaceDiffSummary): void {
  if (workspaceDiffCache.has(key)) workspaceDiffCache.delete(key);
  workspaceDiffCache.set(key, cloneWorkspaceDiffSummary(summary));
  while (workspaceDiffCache.size > WORKSPACE_DIFF_CACHE_MAX_ENTRIES) {
    const oldest = workspaceDiffCache.keys().next().value;
    if (!oldest) break;
    workspaceDiffCache.delete(oldest);
  }
}

function cloneWorkspaceDiffSummary(summary: WorkspaceDiffSummary): WorkspaceDiffSummary {
  return {
    ...summary,
    repoFiles: [...summary.repoFiles],
    files: summary.files.map((file) => ({ ...file })),
  };
}

async function gitWorkspaceContext(repoPath: string): Promise<GitWorkspaceContext> {
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], repoPath);
  if (result.code !== 0) return { commandCwd: repoPath, pathPrefix: "" };
  const topLevel = result.stdout.trim();
  if (!topLevel) return { commandCwd: repoPath, pathPrefix: "" };
  const relative = path.relative(path.resolve(topLevel), path.resolve(repoPath));
  const pathPrefix = normalizeWorkspaceFilePath(relative.replace(/\\/g, "/")) ?? "";
  return {
    commandCwd: topLevel,
    pathPrefix,
  };
}

function pathInWorkspace(filePath: string, pathPrefix: string): string | null {
  const normalizedPath = normalizeWorkspaceFilePath(filePath);
  if (!normalizedPath) return null;
  if (!pathPrefix) return normalizedPath;
  if (normalizedPath === pathPrefix) return null;
  return normalizedPath.startsWith(`${pathPrefix}/`) ? normalizedPath.slice(pathPrefix.length + 1) : null;
}

function gitPathForWorkspacePath(filePath: string, pathPrefix: string): string {
  return pathPrefix ? `${pathPrefix}/${filePath}` : filePath;
}

function scopedNumstat(
  stats: Map<string, { additions: number; deletions: number }>,
  pathPrefix: string
): Map<string, { additions: number; deletions: number }> {
  const scoped = new Map<string, { additions: number; deletions: number }>();
  for (const [filePath, fileStats] of stats) {
    const workspacePath = pathInWorkspace(filePath, pathPrefix);
    if (workspacePath) scoped.set(workspacePath, fileStats);
  }
  return scoped;
}

async function loadTrackedGitPatchMap(
  gitContext: GitWorkspaceContext,
  entries: GitStatusEntry[]
): Promise<Map<string, string>> {
  if (entries.length === 0) return new Map();
  const pathspec = gitContext.pathPrefix || ".";
  const result = await runCommand(
    "git",
    ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--unified=80", "HEAD", "--", pathspec],
    gitContext.commandCwd
  );
  if (result.code !== 0) return new Map();
  return parseGitPatchStreamByWorkspacePath(result.stdout || result.stderr, gitContext.pathPrefix);
}

function parseGitPatchStreamByWorkspacePath(stdout: string, pathPrefix: string): Map<string, string> {
  const patches = new Map<string, string>();
  for (const chunk of stdout.split(/(?=^diff --git )/m)) {
    if (!chunk.trim()) continue;
    const workspacePath = workspacePathForGitPatchChunk(chunk, pathPrefix);
    if (workspacePath) patches.set(workspacePath, chunk);
  }
  return patches;
}

function workspacePathForGitPatchChunk(chunk: string, pathPrefix: string): string | null {
  const lines = chunk.split("\n");
  for (const line of lines) {
    const newPath = gitPatchMarkerPath(line, "+++ ");
    if (newPath) return pathInWorkspace(newPath, pathPrefix);
  }
  for (const line of lines) {
    const oldPath = gitPatchMarkerPath(line, "--- ");
    if (oldPath) return pathInWorkspace(oldPath, pathPrefix);
  }
  for (const line of lines) {
    if (line.startsWith("rename to ")) {
      const renamedPath = normalizeWorkspaceFilePath(line.slice("rename to ".length).trim());
      if (renamedPath) return pathInWorkspace(renamedPath, pathPrefix);
    }
  }
  const header = lines.find((line) => line.startsWith("diff --git "));
  if (!header) return null;
  const destinationIndex = header.lastIndexOf(" b/");
  if (destinationIndex < 0) return null;
  const destinationPath = normalizeWorkspaceFilePath(header.slice(destinationIndex + 3).trim());
  return destinationPath ? pathInWorkspace(destinationPath, pathPrefix) : null;
}

function gitPatchMarkerPath(line: string, prefix: "--- " | "+++ "): string | null {
  if (!line.startsWith(prefix)) return null;
  const value = line.slice(prefix.length).trim();
  if (!value || value === "/dev/null") return null;
  const withoutGitPrefix = value.startsWith("a/") || value.startsWith("b/")
    ? value.slice(2)
    : value;
  return normalizeWorkspaceFilePath(withoutGitPrefix);
}

export async function loadWorkspaceFile(storeDir: string, app: OpenPondApp, filePath: string): Promise<WorkspaceDiffFile> {
  const { repoPath } = appWorkspacePaths(storeDir, app.id);
  return loadWorkspaceFileAtPath(repoPath, filePath);
}

export async function loadWorkspaceImageFile(storeDir: string, app: OpenPondApp, filePath: string): Promise<WorkspaceImageFile> {
  const { repoPath } = appWorkspacePaths(storeDir, app.id);
  return loadWorkspaceImageFileAtPath(repoPath, filePath);
}

export async function loadWorkspaceImageFileAtPath(repoPath: string, filePath: string): Promise<WorkspaceImageFile> {
  const initialized = await isGitRepo(repoPath);
  const normalizedPath = normalizeWorkspaceImageRequestPath(repoPath, filePath);
  if (!normalizedPath) throw new Error("Image not found");
  if (initialized && !(await isVisibleGitWorkspaceFile(repoPath, normalizedPath))) throw new Error("Image not found");
  const image = await readWorkspaceImageFile(repoPath, normalizedPath);
  if (!image) throw new Error("Image not found");
  return image;
}

function normalizeWorkspaceImageRequestPath(repoPath: string, filePath: string): string | null {
  const cleaned = cleanWorkspaceImageRequestPath(filePath);
  if (!cleaned) return null;
  if (!path.isAbsolute(cleaned)) return normalizeWorkspaceFilePath(cleaned);
  const relative = path.relative(path.resolve(repoPath), path.resolve(cleaned));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return normalizeWorkspaceFilePath(relative);
}

function cleanWorkspaceImageRequestPath(value: string): string | null {
  let cleaned = value.trim();
  if (!cleaned) return null;
  cleaned = cleaned.replace(/^['"`]+|['"`]+$/g, "");
  const hashIndex = cleaned.indexOf("#");
  if (hashIndex >= 0) cleaned = cleaned.slice(0, hashIndex);
  const queryIndex = cleaned.indexOf("?");
  if (queryIndex >= 0) cleaned = cleaned.slice(0, queryIndex);
  if (cleaned.startsWith("file://")) {
    try {
      cleaned = decodeURIComponent(new URL(cleaned).pathname);
    } catch {
      cleaned = cleaned.replace(/^file:\/\//, "");
    }
  }
  return cleaned.trim() || null;
}

export async function loadWorkspaceFileAtPath(repoPath: string, filePath: string): Promise<WorkspaceDiffFile> {
  const initialized = await isGitRepo(repoPath);
  const normalizedPath = normalizeWorkspaceFilePath(filePath);
  if (!normalizedPath) throw new Error("File not found");
  if (initialized) {
    const detail = await loadGitWorkspaceFileAtPath(repoPath, normalizedPath);
    if (detail) return detail;
    if (!(await isVisibleGitWorkspaceFile(repoPath, normalizedPath))) throw new Error("File not found");
  }
  const content = await readWorkspaceFile(repoPath, normalizedPath);
  if (content === null) throw new Error("File not found");
  return {
    path: normalizedPath,
    status: "unchanged",
    additions: 0,
    deletions: 0,
    patch: "",
    content,
  };
}

async function loadGitWorkspaceFileAtPath(repoPath: string, filePath: string): Promise<WorkspaceDiffFile | null> {
  const gitContext = await gitWorkspaceContext(repoPath);
  const gitPath = gitPathForWorkspacePath(filePath, gitContext.pathPrefix);
  const statusResult = await runCommand("git", ["status", "--porcelain=v1", "-uall", "--", gitPath], gitContext.commandCwd);
  if (statusResult.code !== 0) return null;
  const entry = statusResult.stdout
    .split("\n")
    .map(parseStatusLine)
    .filter((item): item is GitStatusEntry => Boolean(item))
    .map((item) => {
      const scopedPath = pathInWorkspace(item.path, gitContext.pathPrefix);
      if (!scopedPath) return null;
      const normalizedScopedPath = normalizeWorkspaceFilePath(scopedPath);
      return normalizedScopedPath ? { ...item, path: normalizedScopedPath } : null;
    })
    .find((item): item is GitStatusEntry => Boolean(item && item.path === filePath));
  if (!entry) return null;

  const fileStats =
    entry.status === "untracked"
      ? { additions: countTextLines(await readWorkspaceFile(repoPath, entry.path)), deletions: 0 }
      : await gitNumstatForFile(gitContext, entry.path);
  return loadGitWorkspaceFileDetail(repoPath, entry, gitContext, fileStats);
}

async function loadGitWorkspaceFileDetail(
  repoPath: string,
  entry: GitStatusEntry,
  gitContext: GitWorkspaceContext,
  fileStats: { additions: number; deletions: number },
  overrides: { content?: string | null; patch?: string | null } = {}
): Promise<WorkspaceDiffFile> {
  const content = overrides.content !== undefined
    ? overrides.content
    : entry.status === "deleted"
      ? null
      : await readWorkspaceFile(repoPath, entry.path);
  const gitPath = gitPathForWorkspacePath(entry.path, gitContext.pathPrefix);
  const diffArgs =
    entry.status === "untracked"
      ? ["diff", "--no-index", "--unified=80", "--", "/dev/null", path.join(repoPath, entry.path)]
      : ["diff", "--no-ext-diff", "--unified=80", "HEAD", "--", gitPath];
  let patch = overrides.patch ?? "";
  if (overrides.patch === null || overrides.patch === undefined) {
    const patchResult = await runCommand("git", diffArgs, gitContext.commandCwd);
    patch = patchResult.stdout || patchResult.stderr;
  }
  return {
    path: entry.path,
    status: entry.status,
    additions: fileStats.additions,
    deletions: fileStats.deletions,
    patch: truncatePatch(patch),
    content,
  };
}

async function gitNumstatForFile(
  gitContext: GitWorkspaceContext,
  filePath: string,
): Promise<{ additions: number; deletions: number }> {
  const gitPath = gitPathForWorkspacePath(filePath, gitContext.pathPrefix);
  const result = await runCommand("git", ["diff", "--numstat", "HEAD", "--", gitPath], gitContext.commandCwd);
  if (result.code !== 0) return { additions: 0, deletions: 0 };
  return scopedNumstat(parseNumstat(result.stdout), gitContext.pathPrefix).get(filePath) ?? { additions: 0, deletions: 0 };
}
