import path from "node:path";
import { loadOpenPondProfileState } from "@openpond/cloud";
import type { Taskset } from "@openpond/contracts";
import { buildTaskset, type CustomVerifierRunner } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import { createLearningBatchVerifier } from "./learning-batch-verifier.js";
import { runSandboxedVerifier } from "./sandboxed-verifier.js";
import { createTasksetBindingVerifier } from "./taskset-reward-binding.js";
import { tasksetPackageDirectoryId } from "./taskset-package-path.js";

export async function createTasksetEvaluationVerifier(deps: {
  store: SqliteStore;
  storeDir?: string;
  loadProfileState?: typeof loadOpenPondProfileState;
}, taskset: Taskset): Promise<CustomVerifierRunner | undefined> {
  if (!taskset.graders.some((grader) => grader.kind === "custom_verifier")) return undefined;
  if (taskset.metadata.learning !== undefined) return createLearningBatchVerifier(deps.store, taskset);
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
    ? ({ grader, task, attempt }) => runSandboxedVerifier({ grader, task, attempt, allowedRoot: tasksetRoot })
    : undefined;
}
