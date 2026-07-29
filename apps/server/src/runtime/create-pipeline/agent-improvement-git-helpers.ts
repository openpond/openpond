import { existsSync } from "node:fs";
import { cp, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  CreateImproveGitCandidate,
  CreateImprovePullRequest,
  CreateImproveRun,
} from "@openpond/contracts";

import {
  runWorkspaceCommand,
  type CommandResult,
} from "../../workspace/workspaces.js";
import type { LocalCreatePipelineTarget } from "../local-create-pipeline.js";

export type AgentImprovementCommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
) => Promise<CommandResult>;

export function allowedAgentImprovementPaths(
  run: CreateImproveRun,
  target: LocalCreatePipelineTarget
): string[] {
  const profilePath = normalizeRepoPath(target.profileRelativePath);
  const defaults = [
    normalizeRepoPath(target.sourceRootRelativePath),
    path.posix.join(profilePath, "evals"),
    path.posix.join(profilePath, "settings"),
    path.posix.join(profilePath, "package.json"),
    path.posix.join(profilePath, "tsconfig.json"),
    path.posix.join(profilePath, "openpond.lock"),
    path.posix.join(profilePath, ".gitignore"),
    "openpond-profile.json",
  ];
  const planned = (run.plan?.sourcePlan ?? []).flatMap((item) => {
    const value = normalizeRepoPath(item.path);
    if (!value) return [];
    if (value === "." || value.startsWith(`${profilePath}/`)) return [value];
    return [path.posix.join(profilePath, value), value];
  });
  return [...new Set([...defaults, ...planned])];
}

export function pathAllowed(changedPath: string, allowed: string[]): boolean {
  const normalized = normalizeRepoPath(changedPath);
  return allowed.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
}

export function isCandidateRuntimePath(value: string): boolean {
  const segments = normalizeRepoPath(value).split("/");
  return segments.some(
    (segment) =>
      segment === "node_modules" ||
      segment === ".openpond" ||
      segment === "artifacts"
  );
}

export function parseGitStatusPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const raw = line.slice(3);
      const renamed = raw.split(" -> ");
      return normalizeRepoPath(renamed.at(-1) ?? raw);
    });
}

export async function gitChangedPaths(
  command: AgentImprovementCommandRunner,
  cwd: string,
  range: string
): Promise<string[]> {
  const result = await command(
    "git",
    ["diff", "--name-only", "-z", range, "--", "."],
    cwd
  );
  assertCommand(result, "Unable to inspect Agent candidate paths.");
  return [
    ...new Set(
      result.stdout
        .split("\0")
        .map(normalizeRepoPath)
        .filter((value) => value !== "." && !isCandidateRuntimePath(value))
    ),
  ];
}

export async function workingTreeMatchesCommit(input: {
  command: AgentImprovementCommandRunner;
  repoPath: string;
  commit: string;
  paths: string[];
}): Promise<boolean> {
  for (const relativePath of input.paths) {
    const blob = await optionalGitText(input.command, input.repoPath, [
      "rev-parse",
      `${input.commit}:${relativePath}`,
    ]);
    const absolutePath = path.join(input.repoPath, ...relativePath.split("/"));
    if (!blob) {
      if (existsSync(absolutePath)) return false;
      continue;
    }
    if (!existsSync(absolutePath)) return false;
    const activeBlob = await optionalGitText(input.command, input.repoPath, [
      "hash-object",
      "--",
      relativePath,
    ]);
    if (!activeBlob || activeBlob !== blob) return false;
  }
  return true;
}

export async function linkCandidateDependencies(
  target: LocalCreatePipelineTarget,
  worktreePath: string
): Promise<void> {
  const relativePaths = new Set([
    "node_modules",
    path.posix.join(
      normalizeRepoPath(target.profileRelativePath),
      "node_modules"
    ),
    path.posix.join(
      normalizeRepoPath(target.sourceRootRelativePath),
      "node_modules"
    ),
  ]);
  for (const relativePath of relativePaths) {
    const sourcePath = path.join(target.repoPath, ...relativePath.split("/"));
    const destinationPath = path.join(worktreePath, ...relativePath.split("/"));
    if (!(await directoryExists(sourcePath)) || existsSync(destinationPath))
      continue;
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await symlink(
      sourcePath,
      destinationPath,
      process.platform === "win32" ? "junction" : "dir"
    );
  }
}

export async function snapshotActiveProfileChanges(input: {
  command: AgentImprovementCommandRunner;
  repoPath: string;
  worktreePath: string;
  workspaceRoot: string;
}): Promise<void> {
  const trackedDiff = await input.command(
    "git",
    ["diff", "--binary", "HEAD", "--", ".", ":(exclude)**/tasksets/**"],
    input.repoPath
  );
  assertCommand(trackedDiff, "Unable to capture active Profile changes.");
  if (trackedDiff.stdout) {
    const patchPath = path.join(input.workspaceRoot, "active-profile.patch");
    await writeFile(patchPath, trackedDiff.stdout, "utf8");
    const applied = await input.command(
      "git",
      ["apply", "--whitespace=nowarn", patchPath],
      input.worktreePath
    );
    assertCommand(
      applied,
      "Unable to apply active Profile changes to the candidate baseline."
    );
    await rm(patchPath, { force: true });
  }

  const untracked = await input.command(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    input.repoPath
  );
  assertCommand(untracked, "Unable to inspect untracked Profile source.");
  for (const relativePath of untracked.stdout
    .split("\0")
    .filter(snapshotEligiblePath)) {
    const source = path.join(input.repoPath, ...relativePath.split("/"));
    const destination = path.join(
      input.worktreePath,
      ...relativePath.split("/")
    );
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, {
      recursive: true,
      preserveTimestamps: true,
    });
  }

  const added = await input.command("git", ["add", "-A"], input.worktreePath);
  assertCommand(added, "Unable to stage the active Profile snapshot.");
  const hasSnapshot = await input.command(
    "git",
    ["diff", "--cached", "--quiet"],
    input.worktreePath
  );
  if (hasSnapshot.code === 0) return;
  if (hasSnapshot.code !== 1) {
    assertCommand(
      hasSnapshot,
      "Unable to inspect the active Profile snapshot."
    );
  }
  const committed = await input.command(
    "git",
    ["commit", "-m", "Snapshot active Profile before OpenPond improvement"],
    input.worktreePath,
    gitIdentityEnv()
  );
  assertCommand(committed, "Unable to commit the active Profile snapshot.");
}

export function snapshotEligiblePath(value: string): boolean {
  if (!value) return false;
  const segments = normalizeRepoPath(value).split("/");
  return !segments.some(
    (segment) =>
      segment === "node_modules" ||
      segment === ".openpond" ||
      segment === "artifacts" ||
      segment === "tasksets"
  );
}

export function gitIdentityEnv(): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "OpenPond",
    GIT_AUTHOR_EMAIL:
      process.env.GIT_AUTHOR_EMAIL || "openpond@example.invalid",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "OpenPond",
    GIT_COMMITTER_EMAIL:
      process.env.GIT_COMMITTER_EMAIL || "openpond@example.invalid",
  };
}

export async function directoryExists(value: string): Promise<boolean> {
  try {
    return (await lstat(value)).isDirectory();
  } catch {
    return false;
  }
}

export async function listPullRequestsForBranch(
  command: AgentImprovementCommandRunner,
  cwd: string,
  branch: string
): Promise<Record<string, unknown>[]> {
  const listed = await command(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,url,state,mergedAt,mergeCommit,baseRefName,headRefName",
      "--limit",
      "20",
    ],
    cwd
  );
  assertCommand(
    listed,
    "Unable to inspect existing Agent improvement pull requests."
  );
  const parsed = JSON.parse(listed.stdout) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object")
      )
    : [];
}

export function normalizePullRequest(
  raw: Record<string, unknown>,
  openedAt = new Date().toISOString(),
  updatedAt = new Date().toISOString()
): CreateImprovePullRequest {
  const number =
    typeof raw.number === "number" ? raw.number : Number(raw.number);
  const stateValue =
    typeof raw.state === "string" ? raw.state.toLowerCase() : "";
  const mergedAt = stringValue(raw.mergedAt);
  const state: CreateImprovePullRequest["state"] =
    mergedAt || stateValue === "merged"
      ? "merged"
      : stateValue === "open"
      ? "open"
      : "closed";
  const mergeCommitRecord =
    raw.mergeCommit && typeof raw.mergeCommit === "object"
      ? (raw.mergeCommit as Record<string, unknown>)
      : null;
  const mergeCommit =
    stringValue(mergeCommitRecord?.oid) ?? stringValue(raw.mergeCommit);
  const url = stringValue(raw.url);
  const baseBranch = stringValue(raw.baseRefName);
  const headBranch = stringValue(raw.headRefName);
  if (
    !Number.isInteger(number) ||
    number <= 0 ||
    !url ||
    !baseBranch ||
    !headBranch
  ) {
    throw new Error("GitHub returned an incomplete pull request payload.");
  }
  return {
    provider: "github",
    number,
    url,
    state,
    baseBranch,
    headBranch,
    mergeCommit,
    openedAt,
    updatedAt,
  };
}

export function candidateBranch(
  run: CreateImproveRun,
  agentId: string
): string {
  return `openpond/improve/${safePathSegment(agentId)}/${safePathSegment(
    run.id
  ).slice(0, 36)}`;
}

export function requireWorktreePath(git: CreateImproveGitCandidate): string {
  if (!git.worktreePath)
    throw new Error("Agent candidate worktree is unavailable.");
  return git.worktreePath;
}

export function githubRepoFromRemote(remote: string): string | null {
  const normalized = remote
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  return /^[^/]+\/[^/]+$/.test(normalized) ? normalized : null;
}

export function normalizeRepoPath(value: string): string {
  return (
    value
      .replaceAll("\\", "/")
      .replace(/^\.\//, "")
      .replace(/^\/+|\/+$/g, "") || "."
  );
}

export function safePathSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "candidate";
}

export async function requiredGitText(
  command: AgentImprovementCommandRunner,
  cwd: string,
  args: string[],
  message: string
): Promise<string> {
  const result = await command("git", args, cwd);
  assertCommand(result, message);
  const value = result.stdout.trim();
  if (!value) throw new Error(message);
  return value;
}

export async function optionalGitText(
  command: AgentImprovementCommandRunner,
  cwd: string,
  args: string[]
): Promise<string | null> {
  const result = await command("git", args, cwd);
  return result.code === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : null;
}

export function assertCommand(result: CommandResult, message: string): void {
  if (result.code === 0) return;
  throw new Error(result.stderr.trim() || result.stdout.trim() || message);
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function defaultCommandRunner(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {}
): Promise<CommandResult> {
  return runWorkspaceCommand(command, args, cwd, env);
}
