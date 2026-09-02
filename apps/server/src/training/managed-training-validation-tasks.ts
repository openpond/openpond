import type {
  ModelComparisonEntryRef,
  TaskDataRecord,
  Taskset,
  TrainingPlan,
} from "@openpond/contracts";

import type { SqliteStore } from "../store/store.js";

export type ManagedValidationTaskSource = {
  taskset: Taskset;
  tasks: TaskDataRecord[];
};

/**
 * A continual-learning release may intentionally contain only newly reviewed
 * training rows. Its private validation rows come from the exact development
 * panel sealed into the Comparison Series, rather than being copied into and
 * misrepresented as part of the release cohort.
 */
export async function resolveManagedValidationTaskSource(input: {
  store: SqliteStore;
  trainingPlan: TrainingPlan;
  trainingTaskset: Taskset;
}): Promise<ManagedValidationTaskSource> {
  const directTasks = validationTasks(input.trainingTaskset);
  if (directTasks.length) {
    return { taskset: input.trainingTaskset, tasks: directTasks };
  }

  const reference = input.trainingPlan.comparisonSeriesEntry;
  if (!reference) {
    throw new Error("OpenPond Managed requires at least one private validation task.");
  }
  const entry = await input.store.getModelComparisonSeriesEntry(reference.entryId);
  if (!entry || !sameEntryReference(entry, reference)) {
    throw new Error("The managed Run cannot resolve its exact Comparison Series entry.");
  }
  const series = await input.store.getModelComparisonSeries(reference.seriesId);
  if (!series?.scheduleSealedAt || series.profileId !== input.trainingTaskset.profileId) {
    throw new Error("The managed Run cannot resolve its sealed Comparison Series.");
  }
  const development = series.evaluationTasksets.development;
  const taskset = await input.store.getTasksetRevision(
    development.id,
    development.revision,
    development.contentHash,
  );
  if (!taskset || taskset.profileId !== series.profileId) {
    throw new Error("The managed Run cannot resolve its exact private development Taskset.");
  }
  const tasks = validationTasks(taskset);
  if (!tasks.length) {
    throw new Error("OpenPond Managed requires at least one private validation task.");
  }
  return { taskset, tasks };
}

function validationTasks(taskset: Taskset): TaskDataRecord[] {
  return taskset.tasks.filter(
    (task) => task.split === "frozen_eval" || task.split === "validation",
  );
}

function sameEntryReference(
  entry: {
    seriesId: string;
    id: string;
    scheduleEntryId: string;
    ordinal: number;
    releaseHash: string;
  },
  reference: ModelComparisonEntryRef,
): boolean {
  return entry.seriesId === reference.seriesId
    && entry.id === reference.entryId
    && entry.scheduleEntryId === reference.scheduleEntryId
    && entry.ordinal === reference.ordinal
    && entry.releaseHash === reference.releaseHash;
}
