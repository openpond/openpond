import { randomUUID } from "node:crypto";

import { createGoalEvent, recordGoalEvent } from "../events";
import { redactString } from "../redaction";
import type { HostedGoalClient } from "../state/hosted";
import type { GoalStateAdapter } from "../state/adapter";
import type { GoalCheckResult, GoalState } from "../types";
import { runGoalShellCommand } from "./shell";

export async function runGoalVerificationChecks(params: {
  goal: GoalState;
  iterationId: string;
  cwd: string;
  workspace?: string | null;
  storageRoot?: string | null;
  localState?: GoalStateAdapter | null;
  hostedClient?: HostedGoalClient | null;
}): Promise<GoalCheckResult[]> {
  const checks: GoalCheckResult[] = [];
  for (const command of params.goal.verification.commands) {
    const redactedCommand = redactString(command);
    const result = await runGoalShellCommand({
      goalId: params.goal.id,
      iterationId: params.iterationId,
      command,
      cwd: params.cwd,
      workspace: params.workspace,
      storageRoot: params.storageRoot,
      localState: params.localState,
      hostedClient: params.hostedClient,
    });
    const status = result.code === 0 && !result.timedOut ? "passed" : "failed";
    const check: GoalCheckResult = {
      id: `check_${randomUUID()}`,
      goalId: params.goal.id,
      iterationId: params.iterationId,
      name: redactedCommand,
      command: redactedCommand,
      status,
      code: result.code,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      summary:
        status === "passed"
          ? `Check passed: ${redactedCommand}`
          : `Check failed: ${redactedCommand}`,
      artifactRefs: result.artifactRefs,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
    };
    checks.push(check);
    await recordGoalEvent(
      createGoalEvent({
        goalId: params.goal.id,
        iterationId: params.iterationId,
        kind: "check.completed",
        summary: check.summary,
        payload: check,
      }),
      { localState: params.localState, hostedClient: params.hostedClient }
    );
    if (status !== "passed") break;
  }
  return checks;
}
