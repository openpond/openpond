import path from "node:path";
import { promises as fs } from "node:fs";

import { prepareAgentSdkRuntimePackage, runAgentSdkProjectCommand } from "@openpond/cloud";
import { validateTaskValue } from "@openpond/evals/task-schema";
import type { ProfileWorkflowAction } from "@openpond/harness";

/** Invoke a workflow's typed target from the Agent source copied into its
 * admitted release. The active Profile checkout is never consulted here. */
export async function executeReleasedProfileWorkflowAction(input: {
  action: ProfileWorkflowAction;
  releaseBundlePath: string;
  value: unknown;
  runId: string;
  run?: typeof runAgentSdkProjectCommand;
}): Promise<{ output: string; agentSourcePath: string; runPath: string }> {
  const validated = validateTaskValue(input.action.inputSchema, input.value);
  if (!validated.valid) {
    throw new Error(`Profile action input is invalid: ${validated.issues[0]?.message ?? "schema mismatch"}`);
  }
  const agentSourcePath = path.join(input.releaseBundlePath, "source", "agents", input.action.agentId);
  if (!/^[a-zA-Z0-9_-]{1,240}$/.test(input.runId)) throw new Error("Profile action run ID is invalid.");
  const runsRoot = path.join(path.dirname(path.dirname(input.releaseBundlePath)), "workflow-action-runs");
  await fs.mkdir(runsRoot, { recursive: true, mode: 0o700 });
  const runPath = await fs.mkdtemp(path.join(runsRoot, `${input.runId}-`));
  for (const entry of await fs.readdir(agentSourcePath)) {
    await fs.cp(path.join(agentSourcePath, entry), path.join(runPath, entry), { recursive: true });
  }
  const rootYaml = await fs.stat(path.join(runPath, "openpond.yaml")).catch(() => null);
  const nestedTs = await fs.stat(path.join(runPath, "agent", "agent.ts")).catch(() => null);
  if (!rootYaml?.isFile() && !nestedTs?.isFile()) {
    const rootTs = path.join(runPath, "agent.ts");
    if (!(await fs.stat(rootTs).catch(() => null))?.isFile()) {
      throw new Error("Released Profile Agent action source lacks an executable project manifest.");
    }
    await fs.mkdir(path.join(runPath, "agent"), { recursive: true });
    await fs.rename(rootTs, path.join(runPath, "agent", "agent.ts"));
  }
  if (!rootYaml?.isFile()) {
    if (!(await fs.stat(path.join(runPath, "package.json")).catch(() => null))?.isFile()) {
      await fs.writeFile(path.join(runPath, "package.json"), '{"type":"module"}\n', { flag: "wx" });
    }
    const sdkRoot = await prepareAgentSdkRuntimePackage();
    const dependencyRoot = path.join(runPath, "node_modules");
    await fs.mkdir(dependencyRoot, { recursive: true });
    await fs.symlink(sdkRoot, path.join(dependencyRoot, "openpond-agent-sdk"), "dir");
  }
  const result = await (input.run ?? runAgentSdkProjectCommand)({
    command: "run",
    cwd: runPath,
    args: [input.action.sourceActionId, "--cwd", runPath, "--input", JSON.stringify(input.value), "--out-dir", path.join(runPath, ".openpond")],
    timeoutMs: 300_000,
    maxOutputBytes: 1_000_000,
  });
  return { output: result.stdout, agentSourcePath, runPath };
}
