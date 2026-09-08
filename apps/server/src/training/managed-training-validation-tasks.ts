import type {
  ModelComparisonEntryRef,
  TaskDataRecord,
  Taskset,
  TrainingPlan,
} from "@openpond/contracts";
import { computeTasksetHash, contentHash } from "@openpond/taskset-sdk";
import { assertTrainingEvaluationIsolation, deterministicTrainingRewardSource } from "openpond-sdk/training";

import type { SqliteStore } from "../store/store.js";
import { resolveTasksetTrainingReward } from "./taskset-reward-binding.js";

export type ManagedValidationTaskSource = {
  taskset: Taskset;
  tasks: TaskDataRecord[];
};

/**
 * Training-only batches keep their membership. Held-out tasks come from the
 * explicit immutable selection, the source's own split, or a sealed series.
 */
export async function resolveManagedValidationTaskSource(input: {
  store: SqliteStore;
  trainingPlan: Pick<TrainingPlan, "comparisonSeriesEntry" | "evaluationTasksetRef">;
  trainingTaskset: Taskset;
  storeDir?: string;
}): Promise<ManagedValidationTaskSource> {
  const explicit = input.trainingPlan.evaluationTasksetRef;
  if (explicit) {
    const taskset = await input.store.getTasksetRevision(explicit.id, explicit.revision, explicit.contentHash);
    if (!taskset || taskset.profileId !== input.trainingTaskset.profileId
      || taskset.id !== explicit.id || taskset.revision !== explicit.revision || taskset.contentHash !== explicit.contentHash) {
      throw new Error("The selected held-out Taskset revision is unavailable in this workspace.");
    }
    return verifySource(taskset);
  }
  const directTasks = validationTasks(input.trainingTaskset);
  if (directTasks.length) {
    return verifySource(input.trainingTaskset);
  }

  const reference = input.trainingPlan.comparisonSeriesEntry;
  if (!reference) {
    throw new Error("Select a held-out Taskset before preparing this training-only batch.");
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
  return verifySource(taskset);

  async function verifySource(taskset: Taskset): Promise<ManagedValidationTaskSource> {
    if (computeTasksetHash(taskset) !== taskset.contentHash) {
      throw new Error("The held-out Taskset bytes do not match its immutable revision.");
    }
    const tasks = validationTasks(taskset);
    if (!tasks.length) throw new Error("The selected Taskset has no held-out evaluation tasks.");
    assertTrainingEvaluationIsolation(input.trainingTaskset.tasks.filter(task => task.split === "train"), tasks);
    if (taskset !== input.trainingTaskset) {
      const contract = (source: Taskset) => ({
        environment: { kind: source.environment.kind, entrypoint: source.environment.entrypoint,
          requiresState: source.capabilities.requiresState, requiresTools: source.capabilities.requiresTools },
        output: source.metadata.tasksetOutputContract ?? null,
      });
      if (contentHash(contract(taskset)) !== contentHash(contract(input.trainingTaskset))) {
        throw new Error("The held-out Taskset execution or output contract differs from the training Taskset.");
      }
      const grading = async (source: Taskset) => {
        const resolved = await resolveTasksetTrainingReward(input.store, source, input.storeDir);
        return deterministicTrainingRewardSource({ graders: source.graders,
          rewardExecution: resolved.rewardExecution ? { binding: resolved.rewardExecution.binding, rewards: resolved.rewardExecution.rewards } : undefined });
      };
      const [trainingGrade, evaluationGrade] = await Promise.all([grading(input.trainingTaskset), grading(taskset)]);
      if (contentHash(trainingGrade) !== contentHash(evaluationGrade)) {
        throw new Error("The held-out Taskset Reward composition differs from the approved training grading plan.");
      }
    }
    return { taskset, tasks };
  }
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
