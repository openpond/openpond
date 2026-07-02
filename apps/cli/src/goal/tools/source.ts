import { createGoalEvent, recordGoalEvent } from "../events";
import type { HostedGoalClient } from "../state/hosted";
import type { GoalStateAdapter } from "../state/adapter";
import type { GoalState } from "../types";
import { runGoalShellCommand } from "./shell";

export type SourceFinalizationResult = {
  status: "skipped" | "committed" | "blocked";
  branch: string | null;
  commitMessage: string | null;
  summary: string;
};

export async function finalizeCheckedSourceUpdate(params: {
  goal: GoalState;
  iterationId: string;
  cwd: string;
  checksPassed: boolean;
  defaultBranch?: string | null;
  workspace?: string | null;
  storageRoot?: string | null;
  localState?: GoalStateAdapter | null;
  hostedClient?: HostedGoalClient | null;
}): Promise<SourceFinalizationResult> {
  if (params.goal.executionPolicy.sourceUpdates !== "auto_commit_push_default_branch") {
    return blocked("source update policy is propose-only");
  }
  if (!params.checksPassed) return blocked("required checks have not passed");
  if (params.hostedClient) {
    return {
      status: "skipped",
      branch: null,
      commitMessage: null,
      summary: "Source finalization delegated to OpenPond control plane",
    };
  }

  const status = await runGoalShellCommand({
    goalId: params.goal.id,
    iterationId: params.iterationId,
    command: "git status --porcelain -uall",
    cwd: params.cwd,
    workspace: params.workspace,
    storageRoot: params.storageRoot,
    localState: params.localState,
    hostedClient: params.hostedClient,
  });
  if (!status.stdoutTail.trim()) {
    return {
      status: "skipped",
      branch: null,
      commitMessage: null,
      summary: "No source changes to commit",
    };
  }
  const unsafePath = unsafeSourceFinalizationPathFromStatus(status.stdoutTail);
  if (unsafePath) {
    return blocked(`source update includes disallowed path: ${unsafePath}`);
  }

  const branch =
    params.defaultBranch?.trim() ||
    (await resolveDefaultBranch({
      ...params,
    }));
  if (!branch) return blocked("could not resolve project default branch");

  const message = [
    `OpenPond Goal: ${params.goal.objective.slice(0, 72)}`,
    "",
    `Goal: ${params.goal.id}`,
    `Iteration: ${params.iterationId}`,
  ].join("\n");

  const add = await runGoalShellCommand({
    goalId: params.goal.id,
    iterationId: params.iterationId,
    command: "git add -A",
    cwd: params.cwd,
    workspace: params.workspace,
    storageRoot: params.storageRoot,
    localState: params.localState,
    hostedClient: params.hostedClient,
  });
  if (add.code !== 0) return blocked("git add failed");

  const commit = await runGoalShellCommand({
    goalId: params.goal.id,
    iterationId: params.iterationId,
    command: `git -c user.name='OpenPond Goal' -c user.email=goals@openpond.ai commit -m ${shellEscape(message)}`,
    cwd: params.cwd,
    workspace: params.workspace,
    storageRoot: params.storageRoot,
    localState: params.localState,
    hostedClient: params.hostedClient,
  });
  if (commit.code !== 0) return blocked("git commit failed");

  const push = await runGoalShellCommand({
    goalId: params.goal.id,
    iterationId: params.iterationId,
    command: `git push origin HEAD:${shellEscape(branch)}`,
    cwd: params.cwd,
    workspace: params.workspace,
    storageRoot: params.storageRoot,
    localState: params.localState,
    hostedClient: params.hostedClient,
  });
  if (push.code !== 0) return blocked("git push failed");

  const result: SourceFinalizationResult = {
    status: "committed",
    branch,
    commitMessage: message,
    summary: `Committed and pushed checked source update to ${branch}`,
  };
  await recordGoalEvent(
    createGoalEvent({
      goalId: params.goal.id,
      iterationId: params.iterationId,
      kind: "source.updated",
      summary: result.summary,
      payload: {
        branch,
        policy: params.goal.executionPolicy.sourceUpdates,
      },
    }),
    { localState: params.localState, hostedClient: params.hostedClient }
  );
  return result;

  function blocked(summary: string): SourceFinalizationResult {
    return {
      status: "blocked",
      branch: null,
      commitMessage: null,
      summary,
    };
  }
}

export function unsafeSourceFinalizationPathFromStatus(
  statusOutput: string
): string | null {
  if (statusOutput.includes("[truncated ")) return "git status output was truncated";
  for (const line of statusOutput.split(/\r?\n/)) {
    const paths = porcelainStatusPaths(line);
    const unsafe = paths.find(isUnsafeSourceFinalizationPath);
    if (unsafe) return unsafe;
  }
  return null;
}

function porcelainStatusPaths(line: string): string[] {
  if (line.length < 4) return [];
  const raw = line.slice(3).trim();
  if (!raw) return [];
  return raw
    .split(" -> ")
    .map((path) => path.replace(/^"|"$/g, "").trim())
    .filter(Boolean);
}

function isUnsafeSourceFinalizationPath(path: string): boolean {
  return (
    path === ".env" ||
    path.startsWith(".env.") ||
    path.includes("/.env") ||
    path === "node_modules" ||
    path.startsWith("node_modules/") ||
    path.includes("/node_modules/") ||
    path === ".git" ||
    path.startsWith(".git/") ||
    path.includes("/.git/")
  );
}

async function resolveDefaultBranch(params: {
  goal: GoalState;
  iterationId: string;
  cwd: string;
  workspace?: string | null;
  storageRoot?: string | null;
  localState?: GoalStateAdapter | null;
  hostedClient?: HostedGoalClient | null;
}): Promise<string | null> {
  const remoteHead = await runGoalShellCommand({
    goalId: params.goal.id,
    iterationId: params.iterationId,
    command: "git symbolic-ref --short refs/remotes/origin/HEAD",
    cwd: params.cwd,
    workspace: params.workspace,
    storageRoot: params.storageRoot,
    localState: params.localState,
    hostedClient: params.hostedClient,
  });
  const branch = remoteHead.stdoutTail.trim().replace(/^origin\//, "");
  if (remoteHead.code === 0 && branch) return branch;

  const current = await runGoalShellCommand({
    goalId: params.goal.id,
    iterationId: params.iterationId,
    command: "git branch --show-current",
    cwd: params.cwd,
    workspace: params.workspace,
    storageRoot: params.storageRoot,
    localState: params.localState,
    hostedClient: params.hostedClient,
  });
  const currentBranch = current.stdoutTail.trim();
  return current.code === 0 && currentBranch ? currentBranch : null;
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
