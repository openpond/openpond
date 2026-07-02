import { promises as fs } from "node:fs";
import path from "node:path";
import type { OpenPondApp, WorkspaceState } from "@openpond/contracts";
import { runWorkspaceCommand as runCommand } from "./workspace-command.js";

export type WorkspaceOptions = {
  token?: string | null;
  clone?: boolean;
  gitBaseUrl?: string | null;
  allowPlainFolder?: boolean;
};

export type GitBackedWorkspace = Pick<OpenPondApp, "id" | "gitOwner" | "gitRepo" | "gitHost" | "defaultBranch">;

export type WorkspacePaths = {
  workspacePath: string;
  repoPath: string;
};

export type GitStatusEntry = {
  path: string;
  status: string;
};

const MAX_PATCH_CHARS = 24000;
const MAX_FILE_CHARS = 80000;
const MAX_READABLE_FILE_BYTES = 512 * 1024;
const MAX_WORKSPACE_IMAGE_BYTES = 15 * 1024 * 1024;
const GENERATED_WORKSPACE_DIRS = new Set([
  ".cache",
  ".eggs",
  ".git",
  ".ipynb_checkpoints",
  ".mypy_cache",
  ".next",
  ".nox",
  ".nuxt",
  ".output",
  ".parcel-cache",
  ".pytest_cache",
  ".pyre",
  ".ruff_cache",
  ".svelte-kit",
  ".tox",
  ".turbo",
  ".venv",
  "__pycache__",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "env",
  "node_modules",
  "out",
  "site-packages",
  "target",
  "venv",
  "volumes",
]);
const BINARY_WORKSPACE_EXTENSIONS = new Set([
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
const WORKSPACE_IMAGE_CONTENT_TYPES = new Map<string, string>([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

function safeAppSegment(appId: string): string {
  return appId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "app";
}

export function sourceFromRemote(remoteUrl: string | null): WorkspaceState["source"] {
  if (!remoteUrl) return "unknown";
  try {
    const host = new URL(remoteUrl).hostname.toLowerCase();
    if (host === "github.com" || host.endsWith(".github.com")) return "github";
    if (host === "openpond.ai" || host.endsWith(".openpond.ai")) return "openpond";
  } catch {
    return "unknown";
  }
  return "local_git";
}

export function redactRemoteUrl(value: string): string {
  return value
    .replace(/x-access-token:[^@]+@/g, "x-access-token:***@")
    .replace(/Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi, "Authorization: Basic ***");
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  if (!(await pathExists(repoPath))) return false;
  const result = await runCommand("git", ["rev-parse", "--git-dir"], repoPath);
  return result.code === 0;
}

export function truncatePatch(value: string): string {
  if (value.length <= MAX_PATCH_CHARS) return value;
  return `${value.slice(0, MAX_PATCH_CHARS)}\n\n[diff truncated]`;
}

function truncateFileContent(value: string): string {
  if (value.length <= MAX_FILE_CHARS) return value;
  return `${value.slice(0, MAX_FILE_CHARS)}\n\n[file truncated]`;
}

export async function readWorkspaceFile(repoPath: string, filePath: string): Promise<string | null> {
  const target = path.resolve(repoPath, filePath);
  const root = path.resolve(repoPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile()) return null;
    if (!isReadableTextWorkspaceFile(filePath, stat.size)) return null;
    return truncateFileContent(await fs.readFile(target, "utf8"));
  } catch {
    return null;
  }
}

export type WorkspaceImageFile = {
  path: string;
  contentType: string;
  bytes: Buffer;
  sizeBytes: number;
};

export function workspaceImageContentType(filePath: string): string | null {
  return WORKSPACE_IMAGE_CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? null;
}

function isWorkspaceImageFile(filePath: string): boolean {
  return Boolean(workspaceImageContentType(filePath));
}

export async function readWorkspaceImageFile(repoPath: string, filePath: string): Promise<WorkspaceImageFile | null> {
  const normalizedPath = normalizeWorkspaceFilePath(filePath);
  if (!normalizedPath) return null;
  const contentType = workspaceImageContentType(normalizedPath);
  if (!contentType) return null;
  const target = path.resolve(repoPath, normalizedPath);
  const root = path.resolve(repoPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.size > MAX_WORKSPACE_IMAGE_BYTES) return null;
    return {
      path: normalizedPath,
      contentType,
      bytes: await fs.readFile(target),
      sizeBytes: stat.size,
    };
  } catch {
    return null;
  }
}

export async function readLocalImageFile(filePath: string): Promise<WorkspaceImageFile | null> {
  const cleanedPath = cleanLocalImagePath(filePath);
  if (!cleanedPath) return null;
  const contentType = workspaceImageContentType(cleanedPath);
  if (!contentType) return null;
  const target = path.resolve(cleanedPath);
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.size > MAX_WORKSPACE_IMAGE_BYTES) return null;
    return {
      path: target,
      contentType,
      bytes: await fs.readFile(target),
      sizeBytes: stat.size,
    };
  } catch {
    return null;
  }
}

function cleanLocalImagePath(value: string): string | null {
  let cleaned = value.trim();
  if (!cleaned) return null;
  cleaned = cleaned.replace(/^['"`]+|['"`]+$/g, "");
  if (cleaned.startsWith("file://")) {
    try {
      cleaned = decodeURIComponent(new URL(cleaned).pathname);
    } catch {
      cleaned = cleaned.replace(/^file:\/\//, "");
    }
  }
  if (!path.isAbsolute(cleaned)) return null;
  return cleaned;
}

function isReadableTextWorkspaceFile(filePath: string, sizeBytes: number): boolean {
  if (sizeBytes > MAX_READABLE_FILE_BYTES) return false;
  return !BINARY_WORKSPACE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function isWorkspaceDirectory(repoPath: string, filePath: string): Promise<boolean> {
  const target = path.resolve(repoPath, filePath);
  const root = path.resolve(repoPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return false;
  try {
    const stat = await fs.lstat(target);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export function normalizeWorkspaceFilePath(input: string): string | null {
  const normalized = input.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized.trim() || normalized.startsWith("/")) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === ".." || part === ".git")) return null;
  return parts.join("/");
}

export function isGeneratedWorkspacePath(filePath: string): boolean {
  const normalized = normalizeWorkspaceFilePath(filePath);
  if (!normalized) return true;
  return normalized.split("/").some((part) => (
    GENERATED_WORKSPACE_DIRS.has(part) ||
    part === ".env" ||
    part.startsWith(".env.") ||
    part.endsWith(".egg-info") ||
    part.endsWith(".pyc") ||
    part.endsWith(".pyo")
  ));
}

export async function isVisibleGitWorkspaceFile(repoPath: string, filePath: string): Promise<boolean> {
  if (isGeneratedWorkspacePath(filePath)) return false;
  const result = await runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", filePath], repoPath);
  if (result.code !== 0) return false;
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === filePath);
}

export function parseStatusLine(line: string): GitStatusEntry | null {
  if (!line.trim() || line.startsWith("## ")) return null;
  const code = line.slice(0, 2);
  const rawPath = line.slice(3).trim();
  const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop()!.trim() : rawPath;
  if (!path) return null;

  if (code === "??") return { path, status: "untracked" };
  if (code.includes("A")) return { path, status: "added" };
  if (code.includes("D")) return { path, status: "deleted" };
  if (code.includes("R")) return { path, status: "renamed" };
  return { path, status: "modified" };
}

export function parseBranchStatusLine(line: string): {
  upstreamBranch: string | null;
  ahead: number;
  behind: number;
} {
  const trackingPart = line.replace(/^##\s*/, "").split("...")[1]?.trim();
  if (!trackingPart) return { upstreamBranch: null, ahead: 0, behind: 0 };
  const bracketIndex = trackingPart.indexOf("[");
  const upstreamBranch = (bracketIndex >= 0 ? trackingPart.slice(0, bracketIndex) : trackingPart).trim() || null;
  const aheadMatch = trackingPart.match(/ahead\s+(\d+)/);
  const behindMatch = trackingPart.match(/behind\s+(\d+)/);
  return {
    upstreamBranch,
    ahead: aheadMatch ? Number(aheadMatch[1]) || 0 : 0,
    behind: behindMatch ? Number(behindMatch[1]) || 0 : 0,
  };
}

export function parseNumstat(stdout: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [additionsRaw, deletionsRaw, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t").trim();
    if (!filePath) continue;
    stats.set(filePath, {
      additions: additionsRaw === "-" ? 0 : Number(additionsRaw) || 0,
      deletions: deletionsRaw === "-" ? 0 : Number(deletionsRaw) || 0,
    });
  }
  return stats;
}

export function uniqueSortedPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

const MAX_PLAIN_WORKSPACE_FILES = 2000;

export async function listPlainWorkspaceFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentPath: string, prefix = ""): Promise<void> {
    if (files.length >= MAX_PLAIN_WORKSPACE_FILES) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= MAX_PLAIN_WORKSPACE_FILES) return;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isGeneratedWorkspacePath(relativePath)) continue;
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  await walk(rootPath);
  return uniqueSortedPaths(files);
}

function normalizeGitHost(host?: string | null): string | null {
  const trimmed = host?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.host.replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  }
}

function normalizeGitBaseUrl(baseUrl?: string | null): { protocol: string; host: string } | null {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return { protocol: url.protocol || "https:", host: url.host };
  } catch {
    return null;
  }
}

function isDefaultOpenPondGitHost(host?: string | null): boolean {
  const normalized = normalizeGitHost(host);
  return !normalized || normalized === "openpond.ai" || normalized === "www.openpond.ai";
}

export function expectedRemoteUrl(workspace: GitBackedWorkspace, gitBaseUrl?: string | null): string | null {
  const owner = workspace.gitOwner?.trim();
  const repo = workspace.gitRepo?.trim();
  if (!owner || !repo) return null;

  const accountGitBase = normalizeGitBaseUrl(gitBaseUrl);
  const appGitHost = normalizeGitHost(workspace.gitHost);
  const host =
    accountGitBase && isDefaultOpenPondGitHost(appGitHost)
      ? accountGitBase.host
      : appGitHost || accountGitBase?.host || "openpond.ai";
  const protocol = accountGitBase && host === accountGitBase.host ? accountGitBase.protocol : "https:";
  const normalizedRepo = repo.endsWith(".git") ? repo : `${repo}.git`;
  return `${protocol}//${host}/${owner}/${normalizedRepo}`;
}

function isOpenPondRemote(remoteUrl: string): boolean {
  try {
    const host = new URL(remoteUrl).hostname.toLowerCase();
    return host === "openpond.ai" || host.endsWith(".openpond.ai");
  } catch {
    return false;
  }
}

function gitBasicAuthEnv(remoteUrl: string, token?: string | null): NodeJS.ProcessEnv {
  if (!token || !isOpenPondRemote(remoteUrl)) return {};
  const encoded = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${encoded}`,
  };
}

export function assertSafeBranchName(branch: string): void {
  const trimmed = branch.trim();
  if (!trimmed) throw new Error("Branch name is required");
  if (trimmed.includes("..")) throw new Error("Branch name cannot contain '..'");
  if (/[~^:\\\s]/.test(trimmed)) throw new Error("Branch name contains unsupported characters");
  if (trimmed.startsWith("/") || trimmed.endsWith("/") || trimmed.startsWith("-")) {
    throw new Error("Branch name is not safe");
  }
}

export function appWorkspacePaths(storeDir: string, appId: string): WorkspacePaths {
  const workspacePath = path.join(storeDir, "workspaces", safeAppSegment(appId));
  return {
    workspacePath,
    repoPath: path.join(workspacePath, "repo"),
  };
}

export async function cloneWorkspace(repoPath: string, workspacePath: string, remoteUrl: string, token?: string | null): Promise<void> {
  await fs.mkdir(workspacePath, { recursive: true });
  const alreadyExists = await pathExists(repoPath);
  const result = await runCommand("git", ["clone", "--quiet", remoteUrl, repoPath], workspacePath, gitBasicAuthEnv(remoteUrl, token));
  if (result.code !== 0) {
    if (!alreadyExists) await fs.rm(repoPath, { recursive: true, force: true }).catch(() => null);
    throw new Error(redactRemoteUrl(result.stderr.trim() || result.stdout.trim() || "git clone failed"));
  }
  const sanitize = await runCommand("git", ["remote", "set-url", "origin", remoteUrl], repoPath);
  if (sanitize.code !== 0) {
    throw new Error(redactRemoteUrl(sanitize.stderr.trim() || sanitize.stdout.trim() || "git remote set-url failed"));
  }
}

export async function lastFetchAt(repoPath: string): Promise<string | null> {
  const fetchHead = await runCommand("git", ["rev-parse", "--git-path", "FETCH_HEAD"], repoPath);
  const fetchHeadPath =
    fetchHead.code === 0 && fetchHead.stdout.trim()
      ? path.resolve(repoPath, fetchHead.stdout.trim())
      : path.join(repoPath, ".git", "FETCH_HEAD");
  try {
    const stat = await fs.stat(fetchHeadPath);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}
