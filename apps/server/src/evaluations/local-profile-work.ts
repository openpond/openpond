import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";
import { createCandidateCommandExecutor } from "../harness/experiment-candidate-command.js";

const workTools = new Set(["work_exec", "work_save_output"]);

/** Only the existing confined Profile case owner supplies these capabilities. */
export function supportsLocalProfileEnvironment(value: TasksetPackage): boolean {
  const taskset = value.taskset;
  const text = taskset.environment.kind === "text" && taskset.tools.length === 0;
  const work = taskset.environment.kind === "work"
    && taskset.environment.entrypoint === "openpond-work-v1"
    && taskset.tools.every(tool => workTools.has(tool.name));
  return (text || work) && taskset.policy.connectedAppScopes.length === 0
    && taskset.capabilities.every(item => !item.required || item.id === "private-verifier"
      || item.id === "tools" && item.scopes.every(scope => workTools.has(scope)
        && taskset.tools.some(tool => tool.name === scope)));
}

/** Probe the actual local filesystem/PID/network executor before admission.
 * No model, source checkout, private answers or external compute is involved. */
export async function assertLocalProfileWorkRuntime(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openpond-work-preflight-"));
  try {
    await mkdir(path.join(root, "outputs"));
    const identity = "local-work-preflight";
    const execute = createCandidateCommandExecutor({ authorize: async () => ({
      candidateId: identity, candidateRevision: 1, ownerId: identity,
      sessionId: identity, turnId: identity, sourceRoot: root,
      layout: "profile_case", writablePaths: ["outputs"],
    }) });
    const result = await execute({ candidateId: identity, expectedRevision: 1,
      sessionId: identity, turnId: identity, timeoutMs: 5000,
      command: "/runtime/node -e 'require(\"node:fs\").writeFileSync(\"outputs/probe\",\"ready\");process.stdout.write(\"ready\")'" });
    if (result.code !== 0 || result.timedOut || result.stdout !== "ready")
      throw new Error("The confined local Work executor is unavailable.");
  } finally { await rm(root, { recursive: true, force: true }); }
}
