import path from "node:path";
import { loadOpenPondProfileState } from "@openpond/cloud";
import type { Taskset } from "@openpond/contracts";
import { buildTaskset, type CustomVerifierRunner } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import { createLearningBatchVerifier } from "./learning-batch-verifier.js";
import { runSandboxedVerifier } from "./sandboxed-verifier.js";
import { createTasksetBindingVerifier } from "./taskset-reward-binding.js";
import { tasksetPackageDirectoryId } from "./taskset-package-path.js";
import { STARTER_TOOL_ENVIRONMENT } from "./starter-tool-environment.js";
import { readStarterToolEvidence } from "./starter-tool-evidence.js";

export async function createTasksetEvaluationVerifier(deps: {
  store: SqliteStore;
  storeDir?: string;
  loadProfileState?: typeof loadOpenPondProfileState;
}, taskset: Taskset): Promise<CustomVerifierRunner | undefined> {
  if (!taskset.graders.some((grader) => grader.kind === "custom_verifier")) return undefined;
  if (taskset.metadata.learning !== undefined) return createLearningBatchVerifier(deps.store, taskset, deps.storeDir);
  if (taskset.metadata.rewardBinding !== undefined) return createTasksetBindingVerifier(deps.store, taskset, deps.storeDir);
  const profile = deps.storeDir
    ? null
    : await (deps.loadProfileState ?? loadOpenPondProfileState)();
  const tasksetRoot = deps.storeDir
    ? path.join(deps.storeDir, "training", "tasksets", tasksetPackageDirectoryId(taskset))
    : profile?.sourcePath
      ? path.join(profile.sourcePath, "tasksets", taskset.id)
      : null;
  const creationSnapshotId = typeof taskset.metadata.creationSnapshotId === "string"
    ? taskset.metadata.creationSnapshotId
    : null;
  const proposal = creationSnapshotId
    ? await deps.store.getTaskDesignProposal(creationSnapshotId)
    : null;
  if (tasksetRoot && taskset.purpose !== "benchmark" && taskset.environment.metadata.runtimeSourceTasksetId === undefined) {
    await buildTaskset(taskset, tasksetRoot, { generatedFiles: proposal?.generatedFiles ?? [] });
  }
  return tasksetRoot
    ? async ({ grader, task, attempt, signal }) => {
      const pinned = taskset.graders.find(candidate => candidate.id === grader.id);
      if (!pinned || pinned.kind !== "custom_verifier") throw new Error("Verifier is not declared by this Taskset revision.");
      let evaluatorContext: Record<string, unknown> | undefined;
      if (taskset.environment.entrypoint === STARTER_TOOL_ENVIRONMENT && !attempt.infrastructureError) {
        if (!deps.storeDir) throw new Error("Tool grading requires the execution owner's artifact directory.");
        evaluatorContext = await readStarterToolEvidence({ store: deps.store, storeDir: deps.storeDir, taskset, task, attempt });
      }
      return runSandboxedVerifier({ grader: pinned, task, attempt, allowedRoot: tasksetRoot, signal, evaluatorContext });
    }
    : undefined;
}
