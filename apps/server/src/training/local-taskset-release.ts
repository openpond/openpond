import type { Taskset } from "@openpond/contracts";
import type { TasksetRelease } from "@openpond/evals";
import { materializePortableTasksetRelease } from "@openpond/taskset-sdk";
import { desktopTasksetRuntimeAdapterId } from "./portable-evals-adapter.js";

/** Publication and run admission must select the same immutable envelope. */
export async function requireReleasedTaskset(
  registry: { releaseForTaskset(taskset: Taskset): Promise<TasksetRelease | null> },
  taskset: Taskset,
): Promise<TasksetRelease> {
  const release = await registry.releaseForTaskset(taskset);
  if (release) return release;
  return materializePortableTasksetRelease({
    taskset,
    adapterId: desktopTasksetRuntimeAdapterId(taskset),
  }).tasksetRelease;
}
