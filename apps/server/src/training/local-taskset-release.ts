import type { Taskset } from "@openpond/contracts";
import type { TasksetRelease } from "@openpond/evals";
import { materializePortableTasksetRelease } from "@openpond/taskset-sdk";
import { desktopTasksetRuntimeAdapterId } from "./portable-evals-adapter.js";
import { resolveTasksetRewardBinding } from "./taskset-reward-binding.js";
import type { SqliteStore } from "../store/store.js";

/** Publication and run admission must select the same immutable envelope. */
export async function requireReleasedTaskset(
  registry: { releaseForTaskset(taskset: Taskset): Promise<TasksetRelease | null> },
  taskset: Taskset,
  store?: SqliteStore,
): Promise<TasksetRelease> {
  const release = await registry.releaseForTaskset(taskset);
  if (release) return release;
  return materializePortableTasksetRelease({
    taskset,
    rewardExecution: store ? await resolveTasksetRewardBinding(store, taskset) : undefined,
    adapterId: desktopTasksetRuntimeAdapterId(taskset),
  }).tasksetRelease;
}
