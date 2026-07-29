import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  CreateImproveGitCandidate,
  CreateImprovePullRequest,
  CreateImproveRun,
} from "@openpond/contracts";

import type { LocalCreatePipelineTarget } from "../local-create-pipeline.js";
import {
  allowedAgentImprovementPaths,
  assertCommand,
  candidateBranch,
  defaultCommandRunner,
  gitChangedPaths,
  gitIdentityEnv,
  githubRepoFromRemote,
  isCandidateRuntimePath,
  linkCandidateDependencies,
  listPullRequestsForBranch,
  normalizePullRequest,
  normalizeRepoPath,
  optionalGitText,
  parseGitStatusPaths,
  pathAllowed,
  requiredGitText,
  requireWorktreePath,
  safePathSegment,
  snapshotActiveProfileChanges,
  workingTreeMatchesCommit,
  type AgentImprovementCommandRunner,
} from "./agent-improvement-git-helpers.js";

export type { AgentImprovementCommandRunner } from "./agent-improvement-git-helpers.js";

export type AgentImprovementWorkspace = {
  target: LocalCreatePipelineTarget;
  git: CreateImproveGitCandidate;
};

export function restoreAgentImprovementWorkspace(
  target: LocalCreatePipelineTarget,
  git: CreateImproveGitCandidate
): AgentImprovementWorkspace {
  const worktreePath = requireWorktreePath(git);
  if (!existsSync(worktreePath)) {
    throw new Error(
      "The existing Agent candidate worktree is no longer available."
    );
  }
  const profileRelativePath = normalizeRepoPath(target.profileRelativePath);
  const sourceRootRelativePath = normalizeRepoPath(
    target.sourceRootRelativePath
  );
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
    "Profile source is not a Git repository."
  );
  if (path.resolve(repoPath) !== path.resolve(input.target.repoPath)) {
    throw new Error(
      "Profile repo path does not match the Git repository root."
    );
  }
  const status = await command(
    "git",
    ["status", "--porcelain=v1", "-uall"],
    repoPath
  );
  assertCommand(status, "Unable to inspect Profile Git status.");
  const [repoHead, baseBranch, remoteUrl] = await Promise.all([
    requiredGitText(
      command,
      repoPath,
      ["rev-parse", "HEAD"],
      "Profile Git repo has no HEAD commit."
    ),
    requiredGitText(
      command,
      repoPath,
      ["branch", "--show-current"],
      "Profile Git repo must be on a branch."
    ),
    optionalGitText(command, repoPath, ["remote", "get-url", "origin"]),
  ]);
  if (
    input.run.adapter.kind === "local" &&
    input.run.adapter.localHead &&
    input.run.adapter.localHead !== repoHead
  ) {
    throw new Error(
      `Profile source changed from ${input.run.adapter.localHead.slice(
        0,
        12
      )} to ${repoHead.slice(
        0,
        12
      )}. Re-plan the improvement against the current source.`
    );
  }

  const branch = candidateBranch(input.run, input.target.agentId);
  const workspaceRoot = path.join(
    os.tmpdir(),
    "openpond-agent-improvements",
    safePathSegment(path.basename(repoPath) || "profile"),
    safePathSegment(input.run.id)
  );
  const worktreePath = path.join(workspaceRoot, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  const existingBranch = await command(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    repoPath
  );
  if (existsSync(worktreePath)) {
    const worktreeBranch = await optionalGitText(command, worktreePath, [
      "branch",
      "--show-current",
    ]);
    if (worktreeBranch !== branch) {
      await command(
        "git",
        ["worktree", "remove", "--force", worktreePath],
        repoPath
      );
      await rm(workspaceRoot, { recursive: true, force: true });
      await mkdir(workspaceRoot, { recursive: true });
    }
  }
  if (!existsSync(worktreePath)) {
    const args =
      existingBranch.code === 0
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
    "Agent candidate worktree has no baseline commit."
  );
  const worktreeHead = await requiredGitText(
    command,
    worktreePath,
    ["rev-parse", "HEAD"],
    "Agent candidate worktree has no HEAD commit."
  );
  if (worktreeHead !== baseCommit)
    throw new Error("Agent candidate baseline could not be resolved.");
  await linkCandidateDependencies(input.target, worktreePath);

  const profileRelativePath = normalizeRepoPath(
    input.target.profileRelativePath
  );
  const sourceRootRelativePath = normalizeRepoPath(
    input.target.sourceRootRelativePath
  );
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
  const status = await command(
    "git",
    ["status", "--porcelain=v1", "-uall"],
    worktreePath
  );
  assertCommand(status, "Unable to inspect Agent candidate changes.");
  const changedPaths = parseGitStatusPaths(status.stdout).filter(
    (changedPath) => !isCandidateRuntimePath(changedPath)
  );
  if (changedPaths.length === 0) {
    throw new Error("The Agent improvement produced no source changes.");
  }
  const allowed = allowedAgentImprovementPaths(input.run, input.activeTarget);
  const disallowed = changedPaths.filter(
    (changedPath) => !pathAllowed(changedPath, allowed)
  );
  if (disallowed.length > 0) {
    throw new Error(
      `Agent candidate changed paths outside the approved scope: ${disallowed.join(
        ", "
      )}`
    );
  }
  const add = await command(
    "git",
    ["add", "--", ...changedPaths],
    worktreePath
  );
  assertCommand(add, "Unable to stage Agent candidate changes.");
  const commit = await command(
    "git",
    [
      "commit",
      "-m",
      `Improve ${
        input.run.target.displayName ?? input.activeTarget.agentId
      } via OpenPond`,
    ],
    worktreePath,
    gitIdentityEnv()
  );
  assertCommand(commit, "Unable to commit Agent candidate changes.");
  const headCommit = await requiredGitText(
    command,
    worktreePath,
    ["rev-parse", "HEAD"],
    "Agent candidate commit was not created."
  );
  const diffStat = await optionalGitText(command, worktreePath, [
    "diff",
    "--stat",
    `${input.workspace.git.baseCommit}..${headCommit}`,
  ]);
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
  if (!input.git.headCommit)
    throw new Error("Agent candidate has no commit to push.");
  if (!input.git.remoteUrl || !githubRepoFromRemote(input.git.remoteUrl)) {
    throw new Error(
      "Agent candidate is ready locally. Configure a GitHub origin remote before opening a pull request."
    );
  }
  const push = await command(
    "git",
    ["push", "--set-upstream", input.git.remoteName, input.git.branch],
    worktreePath
  );
  assertCommand(push, "Unable to push the Agent candidate branch.");

  const existing = await listPullRequestsForBranch(
    command,
    worktreePath,
    input.git.branch
  );
  if (existing.length > 0)
    return normalizePullRequest(existing[0]!, input.timestamp);

  const title = `Improve ${
    input.run.target.displayName ?? input.run.target.id ?? "Agent"
  }`;
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
    worktreePath
  );
  assertCommand(
    created,
    "Unable to create the Agent improvement pull request."
  );
  const url = created.stdout
    .trim()
    .split(/\s+/)
    .find((value) => /^https:\/\/github\.com\//.test(value));
  if (!url)
    throw new Error("GitHub did not return the created pull request URL.");
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
  if (!reference)
    throw new Error("Agent candidate has no pull request reference.");
  const view = await command(
    "gh",
    [
      "pr",
      "view",
      reference,
      "--json",
      "number,url,state,mergedAt,mergeCommit,baseRefName,headRefName",
    ],
    cwd
  );
  assertCommand(view, "Unable to inspect the Agent improvement pull request.");
  return normalizePullRequest(
    JSON.parse(view.stdout) as Record<string, unknown>,
    input.git.pullRequest?.openedAt ?? input.timestamp,
    input.timestamp
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
    cwd
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
  const status = await command(
    "git",
    ["status", "--porcelain=v1", "-uall"],
    input.repoPath
  );
  assertCommand(status, "Unable to inspect the active Profile checkout.");
  if (status.stdout.trim()) {
    throw new Error(
      "Active Profile source has uncommitted changes and cannot sync the merged PR."
    );
  }
  const branch = await requiredGitText(
    command,
    input.repoPath,
    ["branch", "--show-current"],
    "Active Profile checkout is not on a branch."
  );
  if (branch !== input.baseBranch) {
    throw new Error(
      `Active Profile checkout is on ${branch}, expected ${input.baseBranch}.`
    );
  }
  const fetch = await command(
    "git",
    ["fetch", input.remoteName, input.baseBranch],
    input.repoPath
  );
  assertCommand(fetch, "Unable to fetch the merged Profile branch.");
  const merge = await command(
    "git",
    ["merge", "--ff-only", `${input.remoteName}/${input.baseBranch}`],
    input.repoPath
  );
  assertCommand(
    merge,
    "Unable to fast-forward the active Profile checkout to the merged PR."
  );
  return requiredGitText(
    command,
    input.repoPath,
    ["rev-parse", "HEAD"],
    "Unable to resolve the merged Profile commit."
  );
}

export async function applyAgentImprovementCandidateLocally(input: {
  run: CreateImproveRun;
  repoPath: string;
  git: CreateImproveGitCandidate;
  command?: AgentImprovementCommandRunner;
}): Promise<string> {
  const command = input.command ?? defaultCommandRunner;
  if (!input.git.headCommit)
    throw new Error("Agent candidate has no commit to apply.");
  const [activeBranch, activeHead] = await Promise.all([
    requiredGitText(
      command,
      input.repoPath,
      ["branch", "--show-current"],
      "Active Profile checkout is not on a branch."
    ),
    requiredGitText(
      command,
      input.repoPath,
      ["rev-parse", "HEAD"],
      "Active Profile checkout has no HEAD commit."
    ),
  ]);
  if (activeBranch !== input.git.baseBranch) {
    throw new Error(
      `Active Profile checkout is on ${activeBranch}, expected ${input.git.baseBranch}.`
    );
  }
  if (
    input.run.adapter.kind === "local" &&
    input.run.adapter.localHead &&
    activeHead !== input.run.adapter.localHead
  ) {
    throw new Error(
      `Active Profile moved from ${input.run.adapter.localHead.slice(
        0,
        12
      )} to ${activeHead.slice(
        0,
        12
      )}. Re-run the improvement against the current Profile.`
    );
  }

  const releasePaths = await gitChangedPaths(
    command,
    input.repoPath,
    `${activeHead}..${input.git.headCommit}`
  );
  const candidatePaths = await gitChangedPaths(
    command,
    input.repoPath,
    `${input.git.baseCommit}..${input.git.headCommit}`
  );
  if (releasePaths.length === 0 || candidatePaths.length === 0) {
    throw new Error("Agent candidate has no source changes to apply.");
  }
  if (
    !(await workingTreeMatchesCommit({
      command,
      repoPath: input.repoPath,
      commit: input.git.baseCommit,
      paths: releasePaths,
    }))
  ) {
    throw new Error(
      "The active Profile changed after this candidate was created. Review those changes and run the improvement again."
    );
  }

  const patch = await command(
    "git",
    [
      "diff",
      "--binary",
      `${input.git.baseCommit}..${input.git.headCommit}`,
      "--",
      ...candidatePaths,
    ],
    input.repoPath
  );
  assertCommand(patch, "Unable to build the local Agent change.");
  if (!patch.stdout.trim())
    throw new Error("Agent candidate produced an empty local change.");

  const patchPath = path.join(
    os.tmpdir(),
    `openpond-agent-change-${safePathSegment(input.run.id)}-${Date.now()}.patch`
  );
  await writeFile(patchPath, patch.stdout, "utf8");
  let applied = false;
  try {
    const checked = await command(
      "git",
      ["apply", "--check", "--whitespace=nowarn", patchPath],
      input.repoPath
    );
    assertCommand(
      checked,
      "The Agent change no longer applies cleanly to the active Profile."
    );
    const apply = await command(
      "git",
      ["apply", "--whitespace=nowarn", patchPath],
      input.repoPath
    );
    assertCommand(
      apply,
      "Unable to apply the Agent change to the active Profile."
    );
    applied = true;

    if (
      !(await workingTreeMatchesCommit({
        command,
        repoPath: input.repoPath,
        commit: input.git.headCommit,
        paths: releasePaths,
      }))
    ) {
      throw new Error(
        "The active Profile did not match the reviewed candidate after applying the change."
      );
    }

    const staged = await command(
      "git",
      ["add", "-A", "--", ...releasePaths],
      input.repoPath
    );
    assertCommand(staged, "Unable to stage the reviewed Agent change.");
    const committed = await command(
      "git",
      [
        "commit",
        "--only",
        "-m",
        `Apply OpenPond change: ${
          input.run.target.displayName ?? input.run.target.id ?? "Agent"
        }`,
        "--",
        ...releasePaths,
      ],
      input.repoPath,
      gitIdentityEnv()
    );
    assertCommand(committed, "Unable to commit the reviewed Agent change.");
    applied = false;
    const profileCommit = await requiredGitText(
      command,
      input.repoPath,
      ["rev-parse", "HEAD"],
      "Unable to resolve the applied Profile commit."
    );
    const committedCandidate = await command(
      "git",
      [
        "diff",
        "--quiet",
        profileCommit,
        input.git.headCommit,
        "--",
        ...releasePaths,
      ],
      input.repoPath
    );
    if (committedCandidate.code === 1) {
      throw new Error(
        "The committed Profile does not match the reviewed candidate."
      );
    }
    assertCommand(
      committedCandidate,
      "Unable to verify the committed Agent change."
    );
    return profileCommit;
  } catch (error) {
    if (applied) {
      await command(
        "git",
        ["apply", "--reverse", "--whitespace=nowarn", patchPath],
        input.repoPath
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
    await command(
      "git",
      ["worktree", "remove", "--force", input.git.worktreePath],
      input.repoPath
    );
  }
  if (input.deleteLocalBranch !== false) {
    await command("git", ["branch", "-D", input.git.branch], input.repoPath);
  }
  if (input.git.worktreePath) {
    await rm(path.dirname(input.git.worktreePath), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }
}
