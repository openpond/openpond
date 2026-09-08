import path from "node:path";
import type { TaskDataRecord, Taskset } from "@openpond/contracts";
import { learningRef } from "@openpond/evals/learning";
import { materializePortableTasksetRelease } from "@openpond/taskset-sdk";
import { resolveTasksetPackageExecution, resolveTasksetPackageInstructions } from "openpond-sdk/taskset-packages";
import { AuthoredTasksetFileInventorySchema } from "./authored-taskset-files.js";
import { captureLocalTasksetPackage } from "./taskset-package-capture.js";
import { tasksetPackageDirectoryId } from "./taskset-package-path.js";
import { desktopTasksetRuntimeAdapterId } from "./portable-evals-adapter.js";

/** Ordinary environments retain executable resources in their immutable package,
 * with no fabricated Task Definition or Reward binding in the learning store. */
export async function loadOrdinaryToolEnvironment(taskset: Taskset, task: TaskDataRecord, storeDir?: string) {
  if (!storeDir) throw new Error("Ordinary tool execution requires its owner's package directory.");
  const releases = materializePortableTasksetRelease({ taskset, adapterId: desktopTasksetRuntimeAdapterId(taskset) });
  const packageValue = await captureLocalTasksetPackage({
    root: path.join(storeDir, "training", "tasksets", tasksetPackageDirectoryId(taskset)),
    content: { schemaVersion: "openpond.tasksetPackage.v1", taskset: releases.tasksetRelease, environment: releases.environmentRelease, verifierSet: releases.verifierSetRelease },
    sources: AuthoredTasksetFileInventorySchema.parse(taskset.metadata.portableFileInventory),
  });
  const resolved = resolveTasksetPackageExecution(packageValue);
  if (!resolved) throw new Error("The Taskset does not declare a JavaScript execution graph.");
  const releasedTask = packageValue.taskset.tasks.find(candidate => candidate.id === task.id);
  if (!releasedTask) throw new Error("The selected task is missing from its executable package.");
  const module = resolved.assets.find(asset => asset.id === resolved.execution.javascript.module.id)!;
  const state = resolved.assets.find(asset => asset.id === releasedTask.privilegedContextRef)!;
  return { execution: resolved.execution, module, initialState: JSON.parse(state.text) as Record<string, unknown>,
    definition: learningRef(packageValue.taskset), instructions: resolveTasksetPackageInstructions(packageValue), task: releasedTask };
}
