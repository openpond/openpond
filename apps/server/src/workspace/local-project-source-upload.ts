import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalProject } from "@openpond/contracts";
import {
  isGeneratedWorkspacePath,
  listPlainWorkspaceFiles,
  normalizeWorkspaceFilePath,
} from "./workspace-common.js";
import { runWorkspaceCommand } from "./workspace-command.js";

export type LocalProjectSourceUploadEntry = {
  path: string;
  type: "file";
  contentsBase64: string;
};

export type LocalProjectSourceUploadSkippedFile = {
  path: string;
  reason: "generated" | "invalid_path" | "not_file" | "too_large" | "total_limit" | "read_error";
  sizeBytes?: number;
};

export type LocalProjectSourceUploadBundle = {
  rootPath: string;
  entries: LocalProjectSourceUploadEntry[];
  totalBytes: number;
  skipped: LocalProjectSourceUploadSkippedFile[];
};

export type LocalProjectSourceGitPushResult = {
  rootPath: string;
  branch: string;
  fileCount: number;
  byteCount: number;
  skipped: LocalProjectSourceUploadSkippedFile[];
  initializedEmptyProject: boolean;
  transport: "git_head" | "snapshot";
};

type LocalProjectSourceSelectedFile = {
  path: string;
  absolutePath: string;
  sizeBytes: number;
};

type LocalProjectSourceSelection = {
  rootPath: string;
  files: LocalProjectSourceSelectedFile[];
  totalBytes: number;
  skipped: LocalProjectSourceUploadSkippedFile[];
};

const MAX_SOURCE_UPLOAD_FILES = 5000;
const MAX_SOURCE_UPLOAD_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_UPLOAD_TOTAL_BYTES = 250 * 1024 * 1024;

export async function collectLocalProjectSourceUploadBundle(
  project: LocalProject,
): Promise<LocalProjectSourceUploadBundle> {
  const selection = await selectLocalProjectSourceFiles(project);
  const entries: LocalProjectSourceUploadEntry[] = [];
  for (const file of selection.files) {
    entries.push({
      path: file.path,
      type: "file",
      contentsBase64: (await fs.readFile(file.absolutePath)).toString("base64"),
    });
  }

  return {
    rootPath: selection.rootPath,
    entries,
    totalBytes: selection.totalBytes,
    skipped: selection.skipped,
  };
}

export async function pushLocalProjectSourceToGit(
  project: LocalProject,
  input: {
    repoUrl: string;
    apiKey: string;
    branch: string;
    commitMessage: string;
    fallbackReadme: string;
  },
): Promise<LocalProjectSourceGitPushResult> {
  const branch = normalizeGitBranchName(input.branch);
  const selection = await selectLocalProjectSourceFiles(project);
  if (
    project.repoPath &&
    selection.files.length > 0 &&
    (await gitRepoHasCleanHead(selection.rootPath))
  ) {
    try {
      await pushGitHead({
        cwd: selection.rootPath,
        repoUrl: input.repoUrl,
        apiKey: input.apiKey,
        branch,
      });
      return {
        rootPath: selection.rootPath,
        branch,
        fileCount: selection.files.length,
        byteCount: selection.totalBytes,
        skipped: selection.skipped,
        initializedEmptyProject: false,
        transport: "git_head",
      };
    } catch (error) {
      if (!isNonFastForwardPushError(error)) throw error;
    }
  }

  const snapshotPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "openpond-cloud-source-"),
  );
  const initializedEmptyProject = selection.files.length === 0;
  try {
    if (initializedEmptyProject) {
      await fs.writeFile(path.join(snapshotPath, "README.md"), input.fallbackReadme, "utf8");
    } else {
      await copySelectedFilesToSnapshot(selection, snapshotPath);
    }
    await createSnapshotCommit({
      cwd: snapshotPath,
      branch,
      commitMessage: input.commitMessage,
      repoUrl: input.repoUrl,
      apiKey: input.apiKey,
    });
    await pushGitHead({
      cwd: snapshotPath,
      repoUrl: input.repoUrl,
      apiKey: input.apiKey,
      branch,
    });
    return {
      rootPath: selection.rootPath,
      branch,
      fileCount: initializedEmptyProject ? 1 : selection.files.length,
      byteCount: initializedEmptyProject
        ? Buffer.byteLength(input.fallbackReadme, "utf8")
        : selection.totalBytes,
      skipped: selection.skipped,
      initializedEmptyProject,
      transport: "snapshot",
    };
  } finally {
    await fs.rm(snapshotPath, { recursive: true, force: true });
  }
}

async function selectLocalProjectSourceFiles(
  project: LocalProject,
): Promise<LocalProjectSourceSelection> {
  const rootPath = project.repoPath ?? project.workspacePath;
  const candidatePaths = project.repoPath
    ? await gitVisibleProjectFiles(rootPath)
    : await listPlainWorkspaceFiles(rootPath);
  const files: LocalProjectSourceSelectedFile[] = [];
  const skipped: LocalProjectSourceUploadSkippedFile[] = [];
  let totalBytes = 0;

  for (const candidatePath of candidatePaths) {
    if (files.length >= MAX_SOURCE_UPLOAD_FILES) {
      skipped.push({ path: candidatePath, reason: "total_limit" });
      continue;
    }
    const normalizedPath = normalizeWorkspaceFilePath(candidatePath);
    if (!normalizedPath) {
      skipped.push({ path: candidatePath, reason: "invalid_path" });
      continue;
    }
    if (isGeneratedWorkspacePath(normalizedPath)) {
      skipped.push({ path: normalizedPath, reason: "generated" });
      continue;
    }
    const absolutePath = path.resolve(rootPath, normalizedPath);
    const absoluteRoot = path.resolve(rootPath);
    if (absolutePath !== absoluteRoot && !absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) {
      skipped.push({ path: normalizedPath, reason: "invalid_path" });
      continue;
    }

    try {
      const stat = await fs.lstat(absolutePath);
      if (!stat.isFile()) {
        skipped.push({ path: normalizedPath, reason: "not_file" });
        continue;
      }
      if (stat.size > MAX_SOURCE_UPLOAD_FILE_BYTES) {
        skipped.push({ path: normalizedPath, reason: "too_large", sizeBytes: stat.size });
        continue;
      }
      if (totalBytes + stat.size > MAX_SOURCE_UPLOAD_TOTAL_BYTES) {
        skipped.push({ path: normalizedPath, reason: "total_limit", sizeBytes: stat.size });
        continue;
      }
      files.push({
        path: normalizedPath,
        absolutePath,
        sizeBytes: stat.size,
      });
      totalBytes += stat.size;
    } catch {
      skipped.push({ path: normalizedPath, reason: "read_error" });
    }
  }

  return { rootPath, files, totalBytes, skipped };
}

async function gitVisibleProjectFiles(rootPath: string): Promise<string[]> {
  const result = await runWorkspaceCommand(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    rootPath,
  );
  if (result.code !== 0) return listPlainWorkspaceFiles(rootPath);
  return Array.from(
    new Set(
      result.stdout
        .split("\0")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function normalizeGitBranchName(value: string): string {
  const branch = value.trim() || "main";
  if (
    branch.length > 120 ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(branch)
  ) {
    throw new Error("Cloud source branch contains unsupported characters.");
  }
  return branch;
}

async function gitRepoHasCleanHead(rootPath: string): Promise<boolean> {
  const head = await runWorkspaceCommand("git", ["rev-parse", "--verify", "HEAD"], rootPath);
  if (head.code !== 0) return false;
  const status = await runWorkspaceCommand("git", ["status", "--porcelain=v1"], rootPath);
  return status.code === 0 && status.stdout.trim().length === 0;
}

async function copySelectedFilesToSnapshot(
  selection: LocalProjectSourceSelection,
  snapshotPath: string,
): Promise<void> {
  for (const file of selection.files) {
    const targetPath = path.resolve(snapshotPath, file.path);
    const snapshotRoot = path.resolve(snapshotPath);
    if (targetPath !== snapshotRoot && !targetPath.startsWith(`${snapshotRoot}${path.sep}`)) {
      continue;
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(file.absolutePath, targetPath);
  }
}

async function createSnapshotCommit(input: {
  cwd: string;
  branch: string;
  commitMessage: string;
  repoUrl: string;
  apiKey: string;
}): Promise<void> {
  await runGitOrThrow(input.cwd, ["init"], "Initialize Cloud source snapshot");
  await runGitOrThrow(input.cwd, ["checkout", "-B", input.branch], "Create Cloud source branch");
  await runGitOrThrow(input.cwd, ["config", "user.name", "OpenPond Desktop"], "Configure Git user");
  await runGitOrThrow(input.cwd, ["config", "user.email", "desktop@openpond.ai"], "Configure Git email");
  await applyRemoteBranchParent({
    cwd: input.cwd,
    repoUrl: input.repoUrl,
    apiKey: input.apiKey,
    branch: input.branch,
  });
  await runGitOrThrow(input.cwd, ["add", "-A"], "Stage Cloud source snapshot");
  await runGitOrThrow(
    input.cwd,
    ["commit", "-m", input.commitMessage],
    "Commit Cloud source snapshot",
  );
}

async function applyRemoteBranchParent(input: {
  cwd: string;
  repoUrl: string;
  apiKey: string;
  branch: string;
}): Promise<void> {
  const remoteRef = `refs/remotes/openpond/${input.branch}`;
  const fetch = await runGitWithAuth(
    input.cwd,
    [
      "fetch",
      "--depth=1",
      input.repoUrl,
      `refs/heads/${input.branch}:${remoteRef}`,
    ],
    input.apiKey,
  );
  if (fetch.code !== 0) {
    const message = `${fetch.stderr}\n${fetch.stdout}`;
    if (isMissingRemoteRefOutput(message)) return;
    throw new Error(`Fetch Cloud source parent failed: ${formatGitError(fetch)}`);
  }
  await runGitOrThrow(
    input.cwd,
    ["reset", "--mixed", remoteRef],
    "Attach Cloud source snapshot to remote branch",
  );
}

async function pushGitHead(input: {
  cwd: string;
  repoUrl: string;
  apiKey: string;
  branch: string;
}): Promise<void> {
  const result = await runGitWithAuth(
    input.cwd,
    [
      "push",
      input.repoUrl,
      `HEAD:${input.branch}`,
    ],
    input.apiKey,
  );
  if (result.code === 0) return;
  throw new Error(`Push Cloud source to OpenPond Git failed: ${formatGitError(result)}`);
}

async function runGitWithAuth(
  cwd: string,
  args: string[],
  apiKey: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const basicAuth = Buffer.from(`openpond:${apiKey}`, "utf8").toString("base64");
  return runWorkspaceCommand(
    "git",
    ["-c", `http.extraHeader=Authorization: Basic ${basicAuth}`, ...args],
    cwd,
  );
}

function isNonFastForwardPushError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("non-fast-forward") ||
    message.includes("fetch first") ||
    message.includes("remote contains work that you do not")
  );
}

function isMissingRemoteRefOutput(value: string): boolean {
  return (
    value.includes("couldn't find remote ref") ||
    value.includes("could not find remote ref") ||
    (value.includes("Remote branch") && value.includes("not found"))
  );
}

function formatGitError(result: { stdout: string; stderr: string }): string {
  return (result.stderr || result.stdout || "Git command failed")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

async function runGitOrThrow(
  cwd: string,
  args: string[],
  operation: string,
): Promise<void> {
  const result = await runWorkspaceCommand("git", args, cwd);
  if (result.code === 0) return;
  throw new Error(
    `${operation} failed: ${formatGitError(result)}`,
  );
}
