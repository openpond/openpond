import type { Taskset } from "@openpond/contracts";
import type { TasksetRelease } from "@openpond/evals";
import { materializePortableTasksetRelease } from "@openpond/taskset-sdk";

/** Publication and run admission must select the same immutable envelope. */
export async function requireReleasedTaskset(
  registry: { releaseForTaskset(taskset: Taskset): Promise<TasksetRelease | null> },
  taskset: Taskset,
): Promise<TasksetRelease> {
  const release = await registry.releaseForTaskset(taskset);
  if (release) return release;
  return materializePortableTasksetRelease({
    taskset,
    adapterId: "openpond-preference-comparisons-v1",
  }).tasksetRelease;
}
