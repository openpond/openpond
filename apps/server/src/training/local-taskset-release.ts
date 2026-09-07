import type { Taskset } from "@openpond/contracts";
import type { TasksetRelease } from "@openpond/evals";
import { materializePortableTasksetRelease, computeTasksetHash } from "@openpond/taskset-sdk";
import { ModelProjectVersionedRefSchema } from "openpond-sdk/model-projects";
import { desktopTasksetRuntimeAdapterId } from "./portable-evals-adapter.js";
import { resolveTasksetRewardBinding } from "./taskset-reward-binding.js";
import type { SqliteStore } from "../store/store.js";

export type LocalTasksetRevisionRef = { id: string; revision: number; contentHash: string };

/** Once admitted, execution and grading resolve the same immutable revision. */
export async function requireLocalTasksetRevision(store: SqliteStore, id: string, reference?: LocalTasksetRevisionRef): Promise<Taskset> {
  const ref = reference ? ModelProjectVersionedRefSchema.parse(reference) : null;
  if (ref && ref.id !== id) throw new Error("Taskset execution reference differs from the requested Taskset.");
  const taskset = ref ? await store.getTasksetRevision(ref.id, ref.revision) : await store.getTaskset(id);
  if (!taskset || (ref && (taskset.contentHash !== ref.contentHash || computeTasksetHash(taskset) !== ref.contentHash))) throw new Error("Taskset execution revision is unavailable or differs from its immutable hash.");
  return taskset;
}

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
