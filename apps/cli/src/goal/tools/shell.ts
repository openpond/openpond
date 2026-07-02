import { runShellCommand } from "../../cli/common";
import { createGoalEvent, recordGoalEvent } from "../events";
import { truncateGoalTextArtifact } from "../limits";
import { redactString, truncateForEvent } from "../redaction";
import type { HostedGoalClient } from "../state/hosted";
import type { GoalStateAdapter } from "../state/adapter";
import type { GoalCommandResult } from "../types";
import { createGoalArtifact, recordGoalArtifact } from "./artifacts";

const DEFAULT_GOAL_SHELL_TIMEOUT_SECONDS = 120;

export async function runGoalShellCommand(params: {
  goalId: string;
  iterationId?: string | null;
  command: string;
  cwd: string;
  timeoutSeconds?: number;
  env?: Record<string, string>;
  workspace?: string | null;
  storageRoot?: string | null;
  localState?: GoalStateAdapter | null;
  hostedClient?: HostedGoalClient | null;
}): Promise<GoalCommandResult> {
  const startedAt = new Date().toISOString();
  const redactedCommand = redactString(params.command);
  await recordGoalEvent(
    createGoalEvent({
      goalId: params.goalId,
      iterationId: params.iterationId,
      kind: "command.started",
      summary: `Command started: ${redactedCommand}`,
      payload: { command: redactedCommand, cwd: params.cwd },
    }),
    { localState: params.localState, hostedClient: params.hostedClient }
  );

  const start = Date.now();
  const result = await runShellCommand(params.command, {
    cwd: params.cwd,
    env: params.env,
    timeoutSeconds:
      params.timeoutSeconds ?? DEFAULT_GOAL_SHELL_TIMEOUT_SECONDS,
  });
  const completedAt = new Date().toISOString();
  const artifactRefs: string[] = [];
  const commandResult: GoalCommandResult = {
    command: params.command,
    cwd: params.cwd,
    code: result.code,
    timedOut: result.timedOut,
    durationMs: Date.now() - start,
    stdoutTail: truncateForEvent(result.stdout),
    stderrTail: truncateForEvent(result.stderr),
    artifactRefs,
    startedAt,
    completedAt,
  };

  const combinedOutput = [
    result.stdout ? `stdout:\n${result.stdout}` : "",
    result.stderr ? `stderr:\n${result.stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (combinedOutput.trim()) {
    const artifactContent = truncateGoalTextArtifact(redactString(combinedOutput));
    const artifact = createGoalArtifact({
      goalId: params.goalId,
      iterationId: params.iterationId,
      kind: "command_log",
      name: `${redactedCommand.replace(/\s+/g, "_").slice(0, 80)}.log`,
      content: artifactContent.content,
    });
    const ref = await recordGoalArtifact({
      artifact,
      workspace: params.workspace,
      storageRoot: params.storageRoot,
      localState: params.localState,
      hostedClient: params.hostedClient,
    });
    artifactRefs.push(ref.ref);
  }

  await recordGoalEvent(
    createGoalEvent({
      goalId: params.goalId,
      iterationId: params.iterationId,
      kind: "command.completed",
      summary:
        result.code === 0
          ? `Command completed: ${redactedCommand}`
          : `Command failed: ${redactedCommand}`,
      payload: {
        ...commandResult,
        command: redactedCommand,
        artifactRefs,
      },
    }),
    { localState: params.localState, hostedClient: params.hostedClient }
  );

  return commandResult;
}
