import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeBranchName } from "../workspace/workspace-common.js";
import { runWorkspaceCommand } from "../workspace/workspaces.js";
import {
  gitBasicAuthEnv,
  redactRemoteUrl,
  type DeploymentSource,
  type GitStatusFile,
  type GitStatusResult,
} from "./workspace-tool-common.js";

function parseBranchStatus(line: string): Pick<GitStatusResult, "branch" | "upstream" | "ahead" | "behind"> {
  const value = line.replace(/^##\s*/, "").trim();
  const [branchPart, trackingPartRaw] = value.split("...");
  const noCommitsBranch = branchPart.match(/^No commits yet on\s+(.+)$/)?.[1]?.trim();
  const branch = noCommitsBranch || (branchPart && branchPart !== "HEAD (no branch)" ? branchPart : null);
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  if (trackingPartRaw) {
    const trackingPart = trackingPartRaw.trim();
    const bracketIndex = trackingPart.indexOf("[");
    upstream = (bracketIndex >= 0 ? trackingPart.slice(0, bracketIndex) : trackingPart).trim() || null;
    const aheadMatch = trackingPart.match(/ahead\s+(\d+)/);
    const behindMatch = trackingPart.match(/behind\s+(\d+)/);
    ahead = aheadMatch ? Number(aheadMatch[1]) || 0 : 0;
    behind = behindMatch ? Number(behindMatch[1]) || 0 : 0;
  }
  return { branch, upstream, ahead, behind };
}

function parseFileStatus(line: string): GitStatusFile | null {
  if (!line.trim() || line.startsWith("## ")) return null;
  const statusCode = line.slice(0, 2).trim() || "modified";
  const rawPath = line.slice(3).trim();
  const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop()!.trim() : rawPath;
  if (!filePath) return null;
  return { path: filePath, status: statusCode };
}

async function currentBranch(repoPath: string): Promise<string> {
  const branch = await runWorkspaceCommand("git", ["branch", "--show-current"], repoPath);
  const value = branch.stdout.trim();
  if (branch.code !== 0 || !value) throw new Error(branch.stderr.trim() || branch.stdout.trim() || "Unable to resolve current branch");
  return value;
}

async function currentOrigin(repoPath: string): Promise<string> {
  const remote = await runWorkspaceCommand("git", ["remote", "get-url", "origin"], repoPath);
  const value = remote.stdout.trim();
  if (remote.code !== 0 || !value) throw new Error(remote.stderr.trim() || remote.stdout.trim() || "No origin remote is configured");
  return value;
}

export async function getWorkspaceOriginUrl(repoPath: string): Promise<string | null> {
  const remote = await runWorkspaceCommand("git", ["remote", "get-url", "origin"], repoPath);
  const value = remote.stdout.trim();
  return remote.code === 0 && value ? value : null;
}

export async function ensureWorkspaceGitRepository(repoPath: string, branch = "main"): Promise<void> {
  const existing = await runWorkspaceCommand("git", ["rev-parse", "--git-dir"], repoPath);
  if (existing.code === 0) return;

  assertSafeBranchName(branch);
  let init = await runWorkspaceCommand("git", ["init", "-b", branch], repoPath);
  if (init.code !== 0) {
    init = await runWorkspaceCommand("git", ["init"], repoPath);
    if (init.code !== 0) {
      throw new Error(init.stderr.trim() || init.stdout.trim() || "git init failed");
    }
    const rename = await runWorkspaceCommand("git", ["branch", "-M", branch], repoPath);
    if (rename.code !== 0) {
      throw new Error(rename.stderr.trim() || rename.stdout.trim() || "git branch setup failed");
    }
  }
}

export async function workspaceHasHead(repoPath: string): Promise<boolean> {
  const result = await runWorkspaceCommand("git", ["rev-parse", "--verify", "HEAD"], repoPath);
  return result.code === 0 && Boolean(result.stdout.trim());
}

export async function setWorkspaceOrigin(
  repoPath: string,
  remoteUrl: string,
  options: { replaceExisting?: boolean } = {}
): Promise<{ previousRemoteUrl: string | null; remoteUrl: string }> {
  const previousRemoteUrl = await getWorkspaceOriginUrl(repoPath);
  if (previousRemoteUrl && previousRemoteUrl !== remoteUrl && !options.replaceExisting) {
    throw new Error("Origin remote already exists. Confirm replacing origin before publishing to OpenPond.");
  }
  const args = previousRemoteUrl
    ? ["remote", "set-url", "origin", remoteUrl]
    : ["remote", "add", "origin", remoteUrl];
  const result = await runWorkspaceCommand("git", args, repoPath);
  if (result.code !== 0) {
    throw new Error(redactRemoteUrl(result.stderr.trim() || result.stdout.trim() || "git remote setup failed"));
  }
  return {
    previousRemoteUrl: previousRemoteUrl ? redactRemoteUrl(previousRemoteUrl) : null,
    remoteUrl: redactRemoteUrl(remoteUrl),
  };
}

async function lastFetchAt(repoPath: string): Promise<string | null> {
  const fetchHead = await runWorkspaceCommand("git", ["rev-parse", "--git-path", "FETCH_HEAD"], repoPath);
  const fetchHeadPath = fetchHead.code === 0 && fetchHead.stdout.trim()
    ? path.resolve(repoPath, fetchHead.stdout.trim())
    : path.join(repoPath, ".git", "FETCH_HEAD");
  try {
    const stat = await fs.stat(fetchHeadPath);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

export async function getWorkspaceGitStatus(repoPath: string): Promise<GitStatusResult> {
  const status = await runWorkspaceCommand("git", ["status", "--porcelain=v1", "-b"], repoPath);
  if (status.code !== 0) throw new Error(status.stderr.trim() || status.stdout.trim() || "git status failed");
  const lines = status.stdout.split("\n").filter((line) => line.trim());
  const branchLine = lines.find((line) => line.startsWith("## ")) ?? "##";
  const branch = parseBranchStatus(branchLine);
  const remote = await runWorkspaceCommand("git", ["remote", "get-url", "origin"], repoPath);
  const files = lines.map(parseFileStatus).filter((file): file is GitStatusFile => Boolean(file));
  return {
    ...branch,
    remoteUrl: remote.code === 0 && remote.stdout.trim() ? redactRemoteUrl(remote.stdout.trim()) : null,
    diverged: branch.ahead > 0 && branch.behind > 0,
    lastFetchAt: await lastFetchAt(repoPath),
    dirty: files.length > 0,
    files,
  };
}

export async function getWorkspaceGitDiff(
  repoPath: string,
  options: { staged?: boolean } = {},
): Promise<{ staged: boolean; diff: string }> {
  const args = options.staged ? ["diff", "--staged"] : ["diff"];
  const result = await runWorkspaceCommand("git", args, repoPath);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "git diff failed");
  return {
    staged: options.staged === true,
    diff: result.stdout,
  };
}

export async function commitWorkspaceChanges(
  repoPath: string,
  message: string,
  options: { includeUnstaged?: boolean } = {}
): Promise<{ commitSha: string | null; status: GitStatusResult }> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error("Commit message is required");
  const before = await getWorkspaceGitStatus(repoPath);
  if (!before.dirty) throw new Error("No workspace changes to commit");

  if (options.includeUnstaged !== false) {
    const add = await runWorkspaceCommand("git", ["add", "-A"], repoPath);
    if (add.code !== 0) throw new Error(add.stderr.trim() || add.stdout.trim() || "git add failed");
  }

  let commit = await runWorkspaceCommand("git", ["commit", "-m", trimmed], repoPath);
  if (commit.code !== 0) {
    await runWorkspaceCommand("git", ["config", "user.email", "openpond-app@example.local"], repoPath);
    await runWorkspaceCommand("git", ["config", "user.name", "OpenPond App"], repoPath);
    commit = await runWorkspaceCommand("git", ["commit", "-m", trimmed], repoPath);
  }
  if (commit.code !== 0) throw new Error(commit.stderr.trim() || commit.stdout.trim() || "git commit failed");

  const sha = await runWorkspaceCommand("git", ["rev-parse", "HEAD"], repoPath);
  return {
    commitSha: sha.code === 0 ? sha.stdout.trim() || null : null,
    status: await getWorkspaceGitStatus(repoPath),
  };
}

export async function pushWorkspaceBranch(
  repoPath: string,
  token?: string | null
): Promise<{ branch: string; upstream: string | null; remoteUrl: string; stdout: string; stderr: string; status: GitStatusResult }> {
  const branch = await currentBranch(repoPath);
  const remoteUrl = await currentOrigin(repoPath);
  const upstream = await runWorkspaceCommand("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repoPath);
  const args =
    upstream.code === 0 && upstream.stdout.trim()
      ? ["push"]
      : ["push", "--set-upstream", "origin", branch];
  const push = await runWorkspaceCommand("git", args, repoPath, gitBasicAuthEnv(remoteUrl, token));
  if (push.code !== 0) {
    throw new Error(redactRemoteUrl(push.stderr.trim() || push.stdout.trim() || "git push failed"));
  }
  return {
    branch,
    upstream: upstream.code === 0 ? upstream.stdout.trim() || null : null,
    remoteUrl: redactRemoteUrl(remoteUrl),
    stdout: redactRemoteUrl(push.stdout),
    stderr: redactRemoteUrl(push.stderr),
    status: await getWorkspaceGitStatus(repoPath),
  };
}

export async function fetchWorkspaceRemote(
  repoPath: string,
  token?: string | null
): Promise<{ remoteUrl: string; stdout: string; stderr: string; status: GitStatusResult }> {
  const remoteUrl = await currentOrigin(repoPath);
  const fetch = await runWorkspaceCommand("git", ["fetch", "origin", "--prune"], repoPath, gitBasicAuthEnv(remoteUrl, token));
  if (fetch.code !== 0) {
    throw new Error(redactRemoteUrl(fetch.stderr.trim() || fetch.stdout.trim() || "git fetch failed"));
  }
  return {
    remoteUrl: redactRemoteUrl(remoteUrl),
    stdout: redactRemoteUrl(fetch.stdout),
    stderr: redactRemoteUrl(fetch.stderr),
    status: await getWorkspaceGitStatus(repoPath),
  };
}

export async function getWorkspaceDeploymentSource(repoPath: string): Promise<DeploymentSource> {
  const status = await getWorkspaceGitStatus(repoPath);
  if (status.dirty) {
    throw new Error("Workspace has uncommitted changes; commit and push before deploying");
  }
  if (!status.branch) throw new Error("Workspace is not on a branch");
  if (!status.upstream) throw new Error("Branch has no upstream; push before deploying");
  if (!status.remoteUrl) throw new Error("Workspace has no origin remote; push before deploying");
  if (status.ahead > 0) throw new Error("Branch has unpushed commits; push before deploying");

  const sha = await runWorkspaceCommand("git", ["rev-parse", "HEAD"], repoPath);
  const commitSha = sha.stdout.trim();
  if (sha.code !== 0 || !commitSha) throw new Error(sha.stderr.trim() || sha.stdout.trim() || "Unable to resolve HEAD commit");

  return {
    branch: status.branch,
    commitSha,
    upstream: status.upstream,
    remoteUrl: status.remoteUrl,
  };
}
