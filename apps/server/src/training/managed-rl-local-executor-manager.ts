import path from "node:path";
import type {
  Taskset,
  TrainingExecutionRef,
} from "@openpond/contracts";

import { ManagedRlLocalRolloutExecutor } from "./managed-rl-local-rollout-executor.js";
import type {
  ManagedTrainingAccess,
  OpenPondManagedTrainingAdapterDependencies,
} from "./openpond-managed-training-adapter-support.js";
import { resolveManagedValidationTaskSource } from "./managed-training-validation-tasks.js";

export async function ensureManagedRlLocalExecutor(input: {
  access: ManagedTrainingAccess;
  dependencies: OpenPondManagedTrainingAdapterDependencies;
  executors: Map<string, ManagedRlLocalRolloutExecutor>;
  fetchImpl: typeof fetch;
  harnessReleaseHash?: string;
  ref: TrainingExecutionRef;
  validationTaskset?: Taskset;
}): Promise<void> {
  if (input.executors.has(input.ref.runId)) return;
  if (!input.harnessReleaseHash) {
    throw new Error("Managed local rollout is missing its Harness release hash.");
  }

  let validationTaskset = input.validationTaskset;
  if (!validationTaskset) {
    const localJob = await input.dependencies.store.getTrainingJob(input.ref.runId);
    const trainingPlan = localJob
      ? await input.dependencies.store.getTrainingPlan(localJob.planId)
      : null;
    const trainingTaskset = trainingPlan
      ? await input.dependencies.store.getTaskset(trainingPlan.tasksetId)
      : null;
    if (
      !trainingPlan
      || !trainingTaskset
      || trainingTaskset.contentHash !== trainingPlan.tasksetHash
    ) {
      throw new Error("Managed local rollout cannot restore its Taskset lineage.");
    }
    validationTaskset = (
      await resolveManagedValidationTaskSource({
        store: input.dependencies.store,
        trainingPlan,
        trainingTaskset,
      })
    ).taskset;
  }

  if (input.executors.has(input.ref.runId)) return;
  const executor = new ManagedRlLocalRolloutExecutor({
    runId: input.ref.runId,
    access: input.access,
    fetchImpl: input.fetchImpl,
    env: input.dependencies.env,
    store: input.dependencies.store,
    storeDir: input.dependencies.storeDir,
    harnessRoot: path.join(
      input.dependencies.storeDir,
      "training",
      "harnesses",
      input.harnessReleaseHash,
      "source",
    ),
    validationTaskset,
  });
  input.executors.set(input.ref.runId, executor);
  executor.start();
}
