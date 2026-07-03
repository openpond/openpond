import { promises as fs } from "node:fs";
import type { OpenPondApp, WorkspaceState } from "@openpond/contracts";
import { now } from "../utils.js";
import { runWorkspaceCommand as runCommand } from "./workspace-command.js";
import {
  appWorkspacePaths,
  assertSafeBranchName,
  cloneWorkspace,
  expectedRemoteUrl,
  isGitRepo,
  isGeneratedWorkspacePath,
  lastFetchAt,
  normalizeWorkspaceFilePath,
  parseBranchStatusLine,
  parseStatusLine,
  pathExists,
  redactRemoteUrl,
  sourceFromRemote,
  type GitBackedWorkspace,
  type WorkspaceOptions,
  type WorkspacePaths,
} from "./workspace-common.js";

export async function loadWorkspaceState(
  storeDir: string,
  app: OpenPondApp,
  options: WorkspaceOptions = {}
): Promise<WorkspaceState> {
  return loadWorkspaceStateAtPath(appWorkspacePaths(storeDir, app.id), app, options);
}

export async function loadWorkspaceStateAtPath(
  paths: WorkspacePaths,
  workspace: GitBackedWorkspace,
  options: WorkspaceOptions = {}
): Promise<WorkspaceState> {
  const { workspacePath, repoPath } = paths;
  const expected = expectedRemoteUrl(workspace, options.gitBaseUrl);
  await fs.mkdir(workspacePath, { recursive: true });

  let initialized = await isGitRepo(repoPath);
  let error: string | null = null;

  if (!initialized && options.clone && expected) {
    try {
      await cloneWorkspace(repoPath, workspacePath, expected, options.token);
      initialized = true;
    } catch (cloneError) {
      error = cloneError instanceof Error ? cloneError.message : String(cloneError);
    }
  }

  if (!initialized) {
    if (options.allowPlainFolder && (await pathExists(repoPath))) {
      return {
        appId: workspace.id,
        source: "local_folder",
        workspacePath,
        repoPath,
        initialized: true,
        remoteUrl: null,
        expectedRemoteUrl: expected,
        currentBranch: null,
        headCommit: null,
        upstreamBranch: null,
        ahead: 0,
        behind: 0,
        diverged: false,
        linkedSourceHeadCommit: options.linkedSourceHeadCommit?.trim() || null,
        aheadOfLinkedSource: 0,
        behindLinkedSource: 0,
        divergedFromLinkedSource: false,
        linkedSourceComparisonError: null,
        lastFetchAt: null,
        defaultBranch: workspace.defaultBranch ?? null,
        branches: [],
        dirty: false,
        changedFilesCount: 0,
        untrackedFilesCount: 0,
        error,
        updatedAt: now(),
      };
    }
    return {
      appId: workspace.id,
      source: sourceFromRemote(expected),
      workspacePath,
      repoPath,
      initialized,
      remoteUrl: null,
      expectedRemoteUrl: expected,
      currentBranch: null,
      headCommit: null,
      upstreamBranch: null,
      ahead: 0,
      behind: 0,
      diverged: false,
      linkedSourceHeadCommit: options.linkedSourceHeadCommit?.trim() || null,
      aheadOfLinkedSource: 0,
      behindLinkedSource: 0,
      divergedFromLinkedSource: false,
      linkedSourceComparisonError: null,
      lastFetchAt: null,
      defaultBranch: workspace.defaultBranch ?? null,
      branches: [],
      dirty: false,
      changedFilesCount: 0,
      untrackedFilesCount: 0,
      error,
      updatedAt: now(),
    };
  }

  const [branchResult, branchesResult, statusResult, remoteResult, headResult] = await Promise.all([
    runCommand("git", ["branch", "--show-current"], repoPath),
    runCommand("git", ["branch", "--format=%(refname:short)"], repoPath),
    runCommand("git", ["status", "--porcelain=v1", "-b"], repoPath),
    runCommand("git", ["config", "--get", "remote.origin.url"], repoPath),
    runCommand("git", ["rev-parse", "--verify", "HEAD"], repoPath),
  ]);

  const remoteUrl = remoteResult.code === 0 ? redactRemoteUrl(remoteResult.stdout.trim()) || null : null;
  const statusLines = statusResult.code === 0 ? statusResult.stdout.split("\n").filter((line) => line.trim()) : [];
  const branchStatus = parseBranchStatusLine(statusLines.find((line) => line.startsWith("## ")) ?? "");
  const changedLines = statusLines.filter((line) => {
    if (line.startsWith("## ")) return false;
    const entry = parseStatusLine(line);
    const normalizedPath = entry ? normalizeWorkspaceFilePath(entry.path) : null;
    return Boolean(normalizedPath && !isGeneratedWorkspacePath(normalizedPath));
  });
  const untrackedFilesCount = changedLines.filter((line) => line.startsWith("??")).length;
  const branch = branchResult.code === 0 && branchResult.stdout.trim() ? branchResult.stdout.trim() : null;
  const headCommit = headResult.code === 0 ? headResult.stdout.trim() || null : null;
  const branches =
    branchesResult.code === 0
      ? branchesResult.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : [];

  const remoteSource = sourceFromRemote(remoteUrl);
  const effectiveSourceUrl = remoteSource === "unknown" && expected ? expected : (remoteUrl ?? expected);
  const linkedSourceComparison = await compareLinkedSourceCommit(
    repoPath,
    options.linkedSourceHeadCommit,
    headCommit,
  );

  return {
    appId: workspace.id,
    source: effectiveSourceUrl ? sourceFromRemote(effectiveSourceUrl) : "local_git",
    workspacePath,
    repoPath,
    initialized,
    remoteUrl,
    expectedRemoteUrl: expected,
    currentBranch: branch,
    headCommit,
    upstreamBranch: branchStatus.upstreamBranch,
    ahead: branchStatus.ahead,
    behind: branchStatus.behind,
    diverged: branchStatus.ahead > 0 && branchStatus.behind > 0,
    linkedSourceHeadCommit: linkedSourceComparison.linkedSourceHeadCommit,
    aheadOfLinkedSource: linkedSourceComparison.aheadOfLinkedSource,
    behindLinkedSource: linkedSourceComparison.behindLinkedSource,
    divergedFromLinkedSource: linkedSourceComparison.divergedFromLinkedSource,
    linkedSourceComparisonError: linkedSourceComparison.error,
    lastFetchAt: await lastFetchAt(repoPath),
    defaultBranch: workspace.defaultBranch ?? null,
    branches,
    dirty: changedLines.length > 0,
    changedFilesCount: changedLines.length,
    untrackedFilesCount,
    error,
    updatedAt: now(),
  };
}

type LinkedSourceComparison = {
  linkedSourceHeadCommit: string | null;
  aheadOfLinkedSource: number;
  behindLinkedSource: number;
  divergedFromLinkedSource: boolean;
  error: string | null;
};

async function compareLinkedSourceCommit(
  repoPath: string,
  linkedSourceHeadCommit: string | null | undefined,
  headCommit: string | null,
): Promise<LinkedSourceComparison> {
  const linkedCommit = linkedSourceHeadCommit?.trim() || null;
  const empty: LinkedSourceComparison = {
    linkedSourceHeadCommit: linkedCommit,
    aheadOfLinkedSource: 0,
    behindLinkedSource: 0,
    divergedFromLinkedSource: false,
    error: null,
  };
  if (!linkedCommit || !headCommit || linkedCommit === headCommit) return empty;

  const result = await runCommand(
    "git",
    ["rev-list", "--left-right", "--count", `${linkedCommit}...${headCommit}`],
    repoPath,
  );
  if (result.code !== 0) {
    return {
      ...empty,
      error: result.stderr.trim() || result.stdout.trim() || "Unable to compare linked source commit.",
    };
  }

  const [behindRaw, aheadRaw] = result.stdout.trim().split(/\s+/, 2);
  const behindLinkedSource = Number(behindRaw) || 0;
  const aheadOfLinkedSource = Number(aheadRaw) || 0;
  return {
    linkedSourceHeadCommit: linkedCommit,
    aheadOfLinkedSource,
    behindLinkedSource,
    divergedFromLinkedSource: aheadOfLinkedSource > 0 && behindLinkedSource > 0,
    error: null,
  };
}

export async function createAndCheckoutBranch(storeDir: string, app: OpenPondApp, branch: string): Promise<WorkspaceState> {
  return createAndCheckoutBranchAtPath(appWorkspacePaths(storeDir, app.id), app, branch);
}

export async function createAndCheckoutBranchAtPath(
  paths: WorkspacePaths,
  workspace: GitBackedWorkspace,
  branch: string,
  options: WorkspaceOptions = {},
): Promise<WorkspaceState> {
  assertSafeBranchName(branch);
  const state = await loadWorkspaceStateAtPath(paths, workspace, { ...options, clone: false });
  if (!state.initialized) throw new Error(state.error || "Workspace is not initialized");
  const result = await runCommand("git", ["checkout", "-b", branch.trim()], state.repoPath);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Unable to create branch");
  }
  return loadWorkspaceStateAtPath(paths, workspace, { ...options, clone: false });
}

export async function checkoutBranch(storeDir: string, app: OpenPondApp, branch: string): Promise<WorkspaceState> {
  return checkoutBranchAtPath(appWorkspacePaths(storeDir, app.id), app, branch);
}

export async function checkoutBranchAtPath(
  paths: WorkspacePaths,
  workspace: GitBackedWorkspace,
  branch: string,
  options: WorkspaceOptions = {},
): Promise<WorkspaceState> {
  assertSafeBranchName(branch);
  const state = await loadWorkspaceStateAtPath(paths, workspace, { ...options, clone: false });
  if (!state.initialized) throw new Error(state.error || "Workspace is not initialized");
  if (state.dirty && state.currentBranch !== branch.trim()) {
    throw new Error("Commit or discard local changes before switching branches");
  }
  const result = await runCommand("git", ["checkout", branch.trim()], state.repoPath);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Unable to switch branch");
  }
  return loadWorkspaceStateAtPath(paths, workspace, { ...options, clone: false });
}
