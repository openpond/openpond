import { existsSync } from "node:fs";
import { cp, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  CreateImproveGitCandidate,
  CreateImprovePullRequest,
  CreateImproveRun,
} from "@openpond/contracts";

import { runWorkspaceCommand, type CommandResult } from "../../workspace/workspaces.js";
import type { LocalCreatePipelineTarget } from "../local-create-pipeline.js";

export type AgentImprovementCommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
) => Promise<CommandResult>;

export type AgentImprovementWorkspace = {
  target: LocalCreatePipelineTarget;
  git: CreateImproveGitCandidate;
};

export function restoreAgentImprovementWorkspace(
  target: LocalCreatePipelineTarget,
  git: CreateImproveGitCandidate,
): AgentImprovementWorkspace {
  const worktreePath = requireWorktreePath(git);
  if (!existsSync(worktreePath)) {
    throw new Error("The existing Agent candidate worktree is no longer available.");
  }
  const profileRelativePath = normalizeRepoPath(target.profileRelativePath);
  const sourceRootRelativePath = normalizeRepoPath(target.sourceRootRelativePath);
  return {
    target: {
      ...target,
      repoPath: worktreePath,
      workspaceRoot: worktreePath,
      sourcePath: path.join(worktreePath, ...profileRelativePath.split("/")),
      sourceRoot: path.join(worktreePath, ...sourceRootRelativePath.split("/")),
    },
    git,
  };
}

export async function prepareAgentImprovementWorkspace(input: {
  run: CreateImproveRun;
  target: LocalCreatePipelineTarget;
  command?: AgentImprovementCommandRunner;
}): Promise<AgentImprovementWorkspace> {
  const command = input.command ?? defaultCommandRunner;
  const repoPath = await requiredGitText(
    command,
    input.target.repoPath,
    ["rev-parse", "--show-toplevel"],
    "Profile source is not a Git repository.",
  );
  if (path.resolve(repoPath) !== path.resolve(input.target.repoPath)) {
    throw new Error("Profile repo path does not match the Git repository root.");
  }
  const status = await command("git", ["status", "--porcelain=v1", "-uall"], repoPath);
  assertCommand(status, "Unable to inspect Profile Git status.");
  const [repoHead, baseBranch, remoteUrl] = await Promise.all([
    requiredGitText(command, repoPath, ["rev-parse", "HEAD"], "Profile Git repo has no HEAD commit."),
    requiredGitText(command, repoPath, ["branch", "--show-current"], "Profile Git repo must be on a branch."),
    optionalGitText(command, repoPath, ["remote", "get-url", "origin"]),
  ]);
  if (input.run.adapter.kind === "local" && input.run.adapter.localHead && input.run.adapter.localHead !== repoHead) {
    throw new Error(
      `Profile source changed from ${input.run.adapter.localHead.slice(0, 12)} to ${repoHead.slice(0, 12)}. Re-plan the improvement against the current source.`,
    );
  }

  const branch = candidateBranch(input.run, input.target.agentId);
  const workspaceRoot = path.join(
    os.tmpdir(),
    "openpond-agent-improvements",
    safePathSegment(path.basename(repoPath) || "profile"),
    safePathSegment(input.run.id),
  );
  const worktreePath = path.join(workspaceRoot, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  const existingBranch = await command(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    repoPath,
  );
  if (existsSync(worktreePath)) {
    const worktreeBranch = await optionalGitText(command, worktreePath, ["branch", "--show-current"]);
    if (worktreeBranch !== branch) {
      await command("git", ["worktree", "remove", "--force", worktreePath], repoPath);
      await rm(workspaceRoot, { recursive: true, force: true });
      await mkdir(workspaceRoot, { recursive: true });
    }
  }
  if (!existsSync(worktreePath)) {
    const args = existingBranch.code === 0
      ? ["worktree", "add", worktreePath, branch]
      : ["worktree", "add", "-b", branch, worktreePath, repoHead];
    const add = await command("git", args, repoPath);
    assertCommand(add, "Unable to create the Agent candidate worktree.");
  }
  if (status.stdout.trim()) {
    await snapshotActiveProfileChanges({
      command,
      repoPath,
      worktreePath,
      workspaceRoot,
    });
  }
  const baseCommit = await requiredGitText(
    command,
    worktreePath,
    ["rev-parse", "HEAD"],
    "Agent candidate worktree has no baseline commit.",
  );
  const worktreeHead = await requiredGitText(
    command,
    worktreePath,
    ["rev-parse", "HEAD"],
    "Agent candidate worktree has no HEAD commit.",
  );
  if (worktreeHead !== baseCommit) throw new Error("Agent candidate baseline could not be resolved.");
  await linkCandidateDependencies(input.target, worktreePath);

  const profileRelativePath = normalizeRepoPath(input.target.profileRelativePath);
  const sourceRootRelativePath = normalizeRepoPath(input.target.sourceRootRelativePath);
  return {
    target: {
      ...input.target,
      repoPath: worktreePath,
      workspaceRoot: worktreePath,
      sourcePath: path.join(worktreePath, ...profileRelativePath.split("/")),
      sourceRoot: path.join(worktreePath, ...sourceRootRelativePath.split("/")),
    },
    git: {
      baseBranch,
      baseCommit,
      branch,
      headCommit: null,
      remoteName: "origin",
      remoteUrl,
      worktreePath,
      changedPaths: [],
      diffStat: null,
      pullRequest: null,
    },
  };
}

export async function commitAgentImprovementCandidate(input: {
  run: CreateImproveRun;
  activeTarget: LocalCreatePipelineTarget;
  workspace: AgentImprovementWorkspace;
  command?: AgentImprovementCommandRunner;
}): Promise<CreateImproveGitCandidate> {
  const command = input.command ?? defaultCommandRunner;
  const worktreePath = requireWorktreePath(input.workspace.git);
  const status = await command("git", ["status", "--porcelain=v1", "-uall"], worktreePath);
  assertCommand(status, "Unable to inspect Agent candidate changes.");
  const changedPaths = parseGitStatusPaths(status.stdout)
    .filter((changedPath) => !isCandidateRuntimePath(changedPath));
  if (changedPaths.length === 0) {
    throw new Error("The Agent improvement produced no source changes.");
  }
  const allowed = allowedAgentImprovementPaths(input.run, input.activeTarget);
  const disallowed = changedPaths.filter((changedPath) => !pathAllowed(changedPath, allowed));
  if (disallowed.length > 0) {
    throw new Error(`Agent candidate changed paths outside the approved scope: ${disallowed.join(", ")}`);
  }
  const add = await command("git", ["add", "--", ...changedPaths], worktreePath);
  assertCommand(add, "Unable to stage Agent candidate changes.");
  const commit = await command(
    "git",
    ["commit", "-m", `Improve ${input.run.target.displayName ?? input.activeTarget.agentId} via OpenPond`],
    worktreePath,
    gitIdentityEnv(),
  );
  assertCommand(commit, "Unable to commit Agent candidate changes.");
  const headCommit = await requiredGitText(
    command,
    worktreePath,
    ["rev-parse", "HEAD"],
    "Agent candidate commit was not created.",
  );
  const diffStat = await optionalGitText(
    command,
    worktreePath,
    ["diff", "--stat", `${input.workspace.git.baseCommit}..${headCommit}`],
  );
  return {
    ...input.workspace.git,
    headCommit,
    changedPaths,
    diffStat,
  };
}

export async function openAgentImprovementPullRequest(input: {
  run: CreateImproveRun;
  git: CreateImproveGitCandidate;
  evaluationSummary: string;
  command?: AgentImprovementCommandRunner;
  timestamp?: string;
}): Promise<CreateImprovePullRequest> {
  const command = input.command ?? defaultCommandRunner;
  const worktreePath = requireWorktreePath(input.git);
  if (!input.git.headCommit) throw new Error("Agent candidate has no commit to push.");
  if (!input.git.remoteUrl || !githubRepoFromRemote(input.git.remoteUrl)) {
    throw new Error(
      "Agent candidate is ready locally. Configure a GitHub origin remote before opening a pull request.",
    );
  }
  const push = await command(
    "git",
    ["push", "--set-upstream", input.git.remoteName, input.git.branch],
    worktreePath,
  );
  assertCommand(push, "Unable to push the Agent candidate branch.");

  const existing = await listPullRequestsForBranch(command, worktreePath, input.git.branch);
  if (existing.length > 0) return normalizePullRequest(existing[0]!, input.timestamp);

  const title = `Improve ${input.run.target.displayName ?? input.run.target.id ?? "Agent"}`;
  const body = [
    "## OpenPond Agent improvement",
    "",
    input.run.objective,
    "",
    "## Evaluation",
    "",
    input.evaluationSummary,
    "",
    `Create/Improve run: \`${input.run.id}\``,
    `Base commit: \`${input.git.baseCommit}\``,
    `Candidate commit: \`${input.git.headCommit}\``,
  ].join("\n");
  const created = await command(
    "gh",
    [
      "pr",
      "create",
      "--base",
      input.git.baseBranch,
      "--head",
      input.git.branch,
      "--title",
      title,
      "--body",
      body,
    ],
    worktreePath,
  );
  assertCommand(created, "Unable to create the Agent improvement pull request.");
  const url = created.stdout.trim().split(/\s+/).find((value) => /^https:\/\/github\.com\//.test(value));
  if (!url) throw new Error("GitHub did not return the created pull request URL.");
  return inspectAgentImprovementPullRequest({
    git: { ...input.git, pullRequest: null },
    pullRequestRef: url,
    command,
    timestamp: input.timestamp,
  });
}

export async function inspectAgentImprovementPullRequest(input: {
  git: CreateImproveGitCandidate;
  pullRequestRef?: string;
  cwd?: string;
  command?: AgentImprovementCommandRunner;
  timestamp?: string;
}): Promise<CreateImprovePullRequest> {
  const command = input.command ?? defaultCommandRunner;
  const cwd = input.cwd ?? requireWorktreePath(input.git);
  const reference = input.pullRequestRef ?? input.git.pullRequest?.url;
  if (!reference) throw new Error("Agent candidate has no pull request reference.");
  const view = await command(
    "gh",
    [
      "pr",
      "view",
      reference,
      "--json",
      "number,url,state,mergedAt,mergeCommit,baseRefName,headRefName",
    ],
    cwd,
  );
  assertCommand(view, "Unable to inspect the Agent improvement pull request.");
  return normalizePullRequest(
    JSON.parse(view.stdout) as Record<string, unknown>,
    input.git.pullRequest?.openedAt ?? input.timestamp,
    input.timestamp,
  );
}

export async function closeAgentImprovementPullRequest(input: {
  git: CreateImproveGitCandidate;
  reason: string;
  cwd?: string;
  command?: AgentImprovementCommandRunner;
}): Promise<void> {
  const command = input.command ?? defaultCommandRunner;
  const cwd = input.cwd ?? requireWorktreePath(input.git);
  const reference = input.git.pullRequest?.url;
  if (!reference) return;
  const closed = await command(
    "gh",
    ["pr", "close", reference, "--delete-branch", "--comment", input.reason],
    cwd,
  );
  assertCommand(closed, "Unable to close the Agent improvement pull request.");
}

export async function syncMergedAgentImprovement(input: {
  repoPath: string;
  baseBranch: string;
  remoteName: string;
  command?: AgentImprovementCommandRunner;
}): Promise<string> {
  const command = input.command ?? defaultCommandRunner;
  const status = await command("git", ["status", "--porcelain=v1", "-uall"], input.repoPath);
  assertCommand(status, "Unable to inspect the active Profile checkout.");
  if (status.stdout.trim()) {
    throw new Error("Active Profile source has uncommitted changes and cannot sync the merged PR.");
  }
  const branch = await requiredGitText(
    command,
    input.repoPath,
    ["branch", "--show-current"],
    "Active Profile checkout is not on a branch.",
  );
  if (branch !== input.baseBranch) {
    throw new Error(`Active Profile checkout is on ${branch}, expected ${input.baseBranch}.`);
  }
  const fetch = await command(
    "git",
    ["fetch", input.remoteName, input.baseBranch],
    input.repoPath,
  );
  assertCommand(fetch, "Unable to fetch the merged Profile branch.");
  const merge = await command(
    "git",
    ["merge", "--ff-only", `${input.remoteName}/${input.baseBranch}`],
    input.repoPath,
  );
  assertCommand(merge, "Unable to fast-forward the active Profile checkout to the merged PR.");
  return requiredGitText(
    command,
    input.repoPath,
    ["rev-parse", "HEAD"],
    "Unable to resolve the merged Profile commit.",
  );
}

export async function applyAgentImprovementCandidateLocally(input: {
  run: CreateImproveRun;
  repoPath: string;
  git: CreateImproveGitCandidate;
  command?: AgentImprovementCommandRunner;
}): Promise<string> {
  const command = input.command ?? defaultCommandRunner;
  if (!input.git.headCommit) throw new Error("Agent candidate has no commit to apply.");
  const [activeBranch, activeHead] = await Promise.all([
    requiredGitText(
      command,
      input.repoPath,
      ["branch", "--show-current"],
      "Active Profile checkout is not on a branch.",
    ),
    requiredGitText(
      command,
      input.repoPath,
      ["rev-parse", "HEAD"],
      "Active Profile checkout has no HEAD commit.",
    ),
  ]);
  if (activeBranch !== input.git.baseBranch) {
    throw new Error(`Active Profile checkout is on ${activeBranch}, expected ${input.git.baseBranch}.`);
  }
  if (
    input.run.adapter.kind === "local" &&
    input.run.adapter.localHead &&
    activeHead !== input.run.adapter.localHead
  ) {
    throw new Error(
      `Active Profile moved from ${input.run.adapter.localHead.slice(0, 12)} to ${activeHead.slice(0, 12)}. Re-run the improvement against the current Profile.`,
    );
  }

  const releasePaths = await gitChangedPaths(
    command,
    input.repoPath,
    `${activeHead}..${input.git.headCommit}`,
  );
  const candidatePaths = await gitChangedPaths(
    command,
    input.repoPath,
    `${input.git.baseCommit}..${input.git.headCommit}`,
  );
  if (releasePaths.length === 0 || candidatePaths.length === 0) {
    throw new Error("Agent candidate has no source changes to apply.");
  }
  if (!await workingTreeMatchesCommit({
    command,
    repoPath: input.repoPath,
    commit: input.git.baseCommit,
    paths: releasePaths,
  })) {
    throw new Error(
      "The active Profile changed after this candidate was created. Review those changes and run the improvement again.",
    );
  }

  const patch = await command(
    "git",
    ["diff", "--binary", `${input.git.baseCommit}..${input.git.headCommit}`, "--", ...candidatePaths],
    input.repoPath,
  );
  assertCommand(patch, "Unable to build the local Agent change.");
  if (!patch.stdout.trim()) throw new Error("Agent candidate produced an empty local change.");

  const patchPath = path.join(
    os.tmpdir(),
    `openpond-agent-change-${safePathSegment(input.run.id)}-${Date.now()}.patch`,
  );
  await writeFile(patchPath, patch.stdout, "utf8");
  let applied = false;
  try {
    const checked = await command(
      "git",
      ["apply", "--check", "--whitespace=nowarn", patchPath],
      input.repoPath,
    );
    assertCommand(checked, "The Agent change no longer applies cleanly to the active Profile.");
    const apply = await command(
      "git",
      ["apply", "--whitespace=nowarn", patchPath],
      input.repoPath,
    );
    assertCommand(apply, "Unable to apply the Agent change to the active Profile.");
    applied = true;

    if (!await workingTreeMatchesCommit({
      command,
      repoPath: input.repoPath,
      commit: input.git.headCommit,
      paths: releasePaths,
    })) {
      throw new Error("The active Profile did not match the reviewed candidate after applying the change.");
    }

    const staged = await command("git", ["add", "-A", "--", ...releasePaths], input.repoPath);
    assertCommand(staged, "Unable to stage the reviewed Agent change.");
    const committed = await command(
      "git",
      [
        "commit",
        "--only",
        "-m",
        `Apply OpenPond change: ${input.run.target.displayName ?? input.run.target.id ?? "Agent"}`,
        "--",
        ...releasePaths,
      ],
      input.repoPath,
      gitIdentityEnv(),
    );
    assertCommand(committed, "Unable to commit the reviewed Agent change.");
    applied = false;
    const profileCommit = await requiredGitText(
      command,
      input.repoPath,
      ["rev-parse", "HEAD"],
      "Unable to resolve the applied Profile commit.",
    );
    const committedCandidate = await command(
      "git",
      ["diff", "--quiet", profileCommit, input.git.headCommit, "--", ...releasePaths],
      input.repoPath,
    );
    if (committedCandidate.code === 1) {
      throw new Error("The committed Profile does not match the reviewed candidate.");
    }
    assertCommand(committedCandidate, "Unable to verify the committed Agent change.");
    return profileCommit;
  } catch (error) {
    if (applied) {
      await command(
        "git",
        ["apply", "--reverse", "--whitespace=nowarn", patchPath],
        input.repoPath,
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(patchPath, { force: true }).catch(() => undefined);
  }
}

export async function cleanupAgentImprovementWorkspace(input: {
  repoPath: string;
  git: CreateImproveGitCandidate;
  deleteLocalBranch?: boolean;
  command?: AgentImprovementCommandRunner;
}): Promise<void> {
  const command = input.command ?? defaultCommandRunner;
  if (input.git.worktreePath && existsSync(input.git.worktreePath)) {
    await command("git", ["worktree", "remove", "--force", input.git.worktreePath], input.repoPath);
  }
  if (input.deleteLocalBranch !== false) {
    await command("git", ["branch", "-D", input.git.branch], input.repoPath);
  }
  if (input.git.worktreePath) {
    await rm(path.dirname(input.git.worktreePath), { recursive: true, force: true }).catch(() => undefined);
  }
}

function allowedAgentImprovementPaths(
  run: CreateImproveRun,
  target: LocalCreatePipelineTarget,
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
    return [
      path.posix.join(profilePath, value),
      value,
    ];
  });
  return [...new Set([...defaults, ...planned])];
}

function pathAllowed(changedPath: string, allowed: string[]): boolean {
  const normalized = normalizeRepoPath(changedPath);
  return allowed.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function isCandidateRuntimePath(value: string): boolean {
  const segments = normalizeRepoPath(value).split("/");
  return segments.some((segment) =>
    segment === "node_modules"
    || segment === ".openpond"
    || segment === "artifacts"
  );
}

function parseGitStatusPaths(output: string): string[] {
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

async function gitChangedPaths(
  command: AgentImprovementCommandRunner,
  cwd: string,
  range: string,
): Promise<string[]> {
  const result = await command(
    "git",
    ["diff", "--name-only", "-z", range, "--", "."],
    cwd,
  );
  assertCommand(result, "Unable to inspect Agent candidate paths.");
  return [...new Set(
    result.stdout
      .split("\0")
      .map(normalizeRepoPath)
      .filter((value) => value !== "." && !isCandidateRuntimePath(value)),
  )];
}

async function workingTreeMatchesCommit(input: {
  command: AgentImprovementCommandRunner;
  repoPath: string;
  commit: string;
  paths: string[];
}): Promise<boolean> {
  for (const relativePath of input.paths) {
    const blob = await optionalGitText(
      input.command,
      input.repoPath,
      ["rev-parse", `${input.commit}:${relativePath}`],
    );
    const absolutePath = path.join(input.repoPath, ...relativePath.split("/"));
    if (!blob) {
      if (existsSync(absolutePath)) return false;
      continue;
    }
    if (!existsSync(absolutePath)) return false;
    const activeBlob = await optionalGitText(
      input.command,
      input.repoPath,
      ["hash-object", "--", relativePath],
    );
    if (!activeBlob || activeBlob !== blob) return false;
  }
  return true;
}

async function linkCandidateDependencies(
  target: LocalCreatePipelineTarget,
  worktreePath: string,
): Promise<void> {
  const relativePaths = new Set([
    "node_modules",
    path.posix.join(normalizeRepoPath(target.profileRelativePath), "node_modules"),
    path.posix.join(normalizeRepoPath(target.sourceRootRelativePath), "node_modules"),
  ]);
  for (const relativePath of relativePaths) {
    const sourcePath = path.join(target.repoPath, ...relativePath.split("/"));
    const destinationPath = path.join(worktreePath, ...relativePath.split("/"));
    if (!(await directoryExists(sourcePath)) || existsSync(destinationPath)) continue;
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await symlink(sourcePath, destinationPath, process.platform === "win32" ? "junction" : "dir");
  }
}

async function snapshotActiveProfileChanges(input: {
  command: AgentImprovementCommandRunner;
  repoPath: string;
  worktreePath: string;
  workspaceRoot: string;
}): Promise<void> {
  const trackedDiff = await input.command(
    "git",
    ["diff", "--binary", "HEAD", "--", ".", ":(exclude)**/tasksets/**"],
    input.repoPath,
  );
  assertCommand(trackedDiff, "Unable to capture active Profile changes.");
  if (trackedDiff.stdout) {
    const patchPath = path.join(input.workspaceRoot, "active-profile.patch");
    await writeFile(patchPath, trackedDiff.stdout, "utf8");
    const applied = await input.command(
      "git",
      ["apply", "--whitespace=nowarn", patchPath],
      input.worktreePath,
    );
    assertCommand(applied, "Unable to apply active Profile changes to the candidate baseline.");
    await rm(patchPath, { force: true });
  }

  const untracked = await input.command(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    input.repoPath,
  );
  assertCommand(untracked, "Unable to inspect untracked Profile source.");
  for (const relativePath of untracked.stdout.split("\0").filter(snapshotEligiblePath)) {
    const source = path.join(input.repoPath, ...relativePath.split("/"));
    const destination = path.join(input.worktreePath, ...relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, preserveTimestamps: true });
  }

  const added = await input.command("git", ["add", "-A"], input.worktreePath);
  assertCommand(added, "Unable to stage the active Profile snapshot.");
  const hasSnapshot = await input.command(
    "git",
    ["diff", "--cached", "--quiet"],
    input.worktreePath,
  );
  if (hasSnapshot.code === 0) return;
  if (hasSnapshot.code !== 1) {
    assertCommand(hasSnapshot, "Unable to inspect the active Profile snapshot.");
  }
  const committed = await input.command(
    "git",
    ["commit", "-m", "Snapshot active Profile before OpenPond improvement"],
    input.worktreePath,
    gitIdentityEnv(),
  );
  assertCommand(committed, "Unable to commit the active Profile snapshot.");
}

function snapshotEligiblePath(value: string): boolean {
  if (!value) return false;
  const segments = normalizeRepoPath(value).split("/");
  return !segments.some((segment) =>
    segment === "node_modules"
    || segment === ".openpond"
    || segment === "artifacts"
    || segment === "tasksets"
  );
}

function gitIdentityEnv(): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "OpenPond",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "openpond@example.invalid",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "OpenPond",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "openpond@example.invalid",
  };
}

async function directoryExists(value: string): Promise<boolean> {
  try {
    return (await lstat(value)).isDirectory();
  } catch {
    return false;
  }
}

async function listPullRequestsForBranch(
  command: AgentImprovementCommandRunner,
  cwd: string,
  branch: string,
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
    cwd,
  );
  assertCommand(listed, "Unable to inspect existing Agent improvement pull requests.");
  const parsed = JSON.parse(listed.stdout) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
}

function normalizePullRequest(
  raw: Record<string, unknown>,
  openedAt = new Date().toISOString(),
  updatedAt = new Date().toISOString(),
): CreateImprovePullRequest {
  const number = typeof raw.number === "number" ? raw.number : Number(raw.number);
  const stateValue = typeof raw.state === "string" ? raw.state.toLowerCase() : "";
  const mergedAt = stringValue(raw.mergedAt);
  const state: CreateImprovePullRequest["state"] = mergedAt || stateValue === "merged"
    ? "merged"
    : stateValue === "open"
      ? "open"
      : "closed";
  const mergeCommitRecord = raw.mergeCommit && typeof raw.mergeCommit === "object"
    ? raw.mergeCommit as Record<string, unknown>
    : null;
  const mergeCommit = stringValue(mergeCommitRecord?.oid) ?? stringValue(raw.mergeCommit);
  const url = stringValue(raw.url);
  const baseBranch = stringValue(raw.baseRefName);
  const headBranch = stringValue(raw.headRefName);
  if (!Number.isInteger(number) || number <= 0 || !url || !baseBranch || !headBranch) {
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

function candidateBranch(run: CreateImproveRun, agentId: string): string {
  return `openpond/improve/${safePathSegment(agentId)}/${safePathSegment(run.id).slice(0, 36)}`;
}

function requireWorktreePath(git: CreateImproveGitCandidate): string {
  if (!git.worktreePath) throw new Error("Agent candidate worktree is unavailable.");
  return git.worktreePath;
}

function githubRepoFromRemote(remote: string): string | null {
  const normalized = remote
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  return /^[^/]+\/[^/]+$/.test(normalized) ? normalized : null;
}

function normalizeRepoPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "") || ".";
}

function safePathSegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "candidate";
}

async function requiredGitText(
  command: AgentImprovementCommandRunner,
  cwd: string,
  args: string[],
  message: string,
): Promise<string> {
  const result = await command("git", args, cwd);
  assertCommand(result, message);
  const value = result.stdout.trim();
  if (!value) throw new Error(message);
  return value;
}

async function optionalGitText(
  command: AgentImprovementCommandRunner,
  cwd: string,
  args: string[],
): Promise<string | null> {
  const result = await command("git", args, cwd);
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function assertCommand(result: CommandResult, message: string): void {
  if (result.code === 0) return;
  throw new Error(result.stderr.trim() || result.stdout.trim() || message);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function defaultCommandRunner(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  return runWorkspaceCommand(command, args, cwd, env);
}
