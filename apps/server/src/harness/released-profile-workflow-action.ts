import path from "node:path";

import { runAgentSdkProjectCommand } from "@openpond/cloud";
import { validateTaskValue } from "@openpond/evals/task-schema";
import type { ProfileWorkflowAction } from "@openpond/harness";

/** Invoke a workflow's typed target from the Agent source copied into its
 * admitted release. The active Profile checkout is never consulted here. */
export async function executeReleasedProfileWorkflowAction(input: {
  action: ProfileWorkflowAction;
  releaseBundlePath: string;
  value: unknown;
  run?: typeof runAgentSdkProjectCommand;
}): Promise<{ output: string; agentSourcePath: string }> {
  const validated = validateTaskValue(input.action.inputSchema, input.value);
  if (!validated.valid) {
    throw new Error(`Profile action input is invalid: ${validated.issues[0]?.message ?? "schema mismatch"}`);
  }
  const agentSourcePath = path.join(input.releaseBundlePath, "source", "agents", input.action.agentId);
  const result = await (input.run ?? runAgentSdkProjectCommand)({
    command: "run",
    cwd: agentSourcePath,
    args: [input.action.sourceActionId, "--cwd", agentSourcePath, "--input", JSON.stringify(input.value)],
    timeoutMs: 300_000,
    maxOutputBytes: 1_000_000,
  });
  return { output: result.stdout, agentSourcePath };
}
