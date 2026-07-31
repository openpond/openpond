import type {
  TaskDataRecord,
  Taskset,
  TrainingJob,
} from "@openpond/contracts";

import type { FireworksDestinationDeps } from "./fireworks-destination-base.js";

export async function resolveArtifactFrozenTasks(input: {
  deps: FireworksDestinationDeps;
  taskset: Taskset;
  job: TrainingJob;
}): Promise<TaskDataRecord[]> {
  const { deps, job, taskset } = input;
  if (!deps.resolveTrainingSelection || !deps.resolveTask) {
    throw new Error("Artifact-backed frozen evaluation is unavailable.");
  }
  const plan = await deps.store.getTrainingPlan(job.planId);
  if (!plan || plan.tasksetHash !== taskset.contentHash) {
    throw new Error("Frozen evaluation plan no longer matches its Dataset.");
  }
  const selection = await deps.resolveTrainingSelection({
    taskset,
    plan,
    split: "frozen_eval",
    maximumBytes: 10 * 1024 * 1024,
  });
  return Promise.all(
    selection.records.map((record) =>
      deps.resolveTask!({
        tasksetId: taskset.id,
        taskId: record.id,
        split: "frozen_eval",
      }),
    ),
  );
}
