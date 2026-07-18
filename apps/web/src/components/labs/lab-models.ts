import type {
  CreateImproveRun,
  ModelArtifactLineage,
  ModelBinding,
  Taskset,
  TrainingJob,
  TrainingPlan,
  TrainingStateResponse,
} from "@openpond/contracts";

import type { LabWorkproductSummary } from "./lab-workproducts";

export type LabModelVersion = {
  lineage: ModelArtifactLineage;
  number: number;
  job: TrainingJob | null;
  plan: TrainingPlan | null;
  taskset: Taskset | null;
  current: boolean;
};

export function labModelPlans(
  workproduct: LabWorkproductSummary,
  runs: CreateImproveRun[],
  state: TrainingStateResponse | null,
): TrainingPlan[] {
  if (!state) return [];
  const modelRuns = runs.filter(
    (run) =>
      run.target.kind === "model" && run.target.id === workproduct.id,
  );
  const planIds = new Set(
    modelRuns.flatMap((run) =>
      run.target.kind === "model" && run.target.trainingPlanId
        ? [run.target.trainingPlanId]
        : [],
    ),
  );
  const tasksetIds = new Set(
    modelRuns.flatMap((run) => (run.tasksetRef ? [run.tasksetRef.id] : [])),
  );
  if (workproduct.tasksetId) tasksetIds.add(workproduct.tasksetId);
  return state.plans
    .filter(
      (plan) =>
        plan.modelId === workproduct.id ||
        planIds.has(plan.id) ||
        (plan.modelId === null && tasksetIds.has(plan.tasksetId)),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function labModelJobs(
  workproduct: LabWorkproductSummary,
  runs: CreateImproveRun[],
  state: TrainingStateResponse | null,
): TrainingJob[] {
  if (!state) return [];
  const planIds = new Set(
    labModelPlans(workproduct, runs, state).map((plan) => plan.id),
  );
  return state.jobs
    .filter((job) => planIds.has(job.planId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function labModelDatasets(
  workproduct: LabWorkproductSummary,
  runs: CreateImproveRun[],
  state: TrainingStateResponse | null,
): Taskset[] {
  if (!state) return [];
  const ids = new Set(
    labModelPlans(workproduct, runs, state).map((plan) => plan.tasksetId),
  );
  for (const run of runs) {
    if (
      run.target.kind === "model" &&
      run.target.id === workproduct.id &&
      run.tasksetRef
    ) {
      ids.add(run.tasksetRef.id);
    }
  }
  if (workproduct.tasksetId) ids.add(workproduct.tasksetId);
  return state.tasksets.filter((taskset) => ids.has(taskset.id));
}

export function labModelVersions(
  workproduct: LabWorkproductSummary,
  runs: CreateImproveRun[],
  state: TrainingStateResponse | null,
): LabModelVersion[] {
  if (!state) return [];
  const plans = labModelPlans(workproduct, runs, state);
  const planById = new Map(plans.map((plan) => [plan.id, plan] as const));
  const jobs = labModelJobs(workproduct, runs, state);
  const jobById = new Map(jobs.map((job) => [job.id, job] as const));
  const currentBinding = currentModelBinding(workproduct, runs, state);
  const associatedJobIds = new Set(jobs.map((job) => job.id));
  const ordered = state.models
    .filter(
      (model) =>
        model.modelId === workproduct.id ||
        associatedJobIds.has(model.jobId),
    )
    .sort((left, right) => left.importedAt.localeCompare(right.importedAt));
  return ordered
    .map((lineage, index) => {
      const job = jobById.get(lineage.jobId) ?? null;
      return {
        lineage,
        number: index + 1,
        job,
        plan: job ? planById.get(job.planId) ?? null : null,
        taskset:
          state.tasksets.find((taskset) => taskset.id === lineage.tasksetId) ??
          null,
        current: currentBinding?.modelArtifactLineageId === lineage.id,
      };
    })
    .sort((left, right) => right.number - left.number);
}

export function currentModelBinding(
  workproduct: LabWorkproductSummary,
  runs: CreateImproveRun[],
  state: TrainingStateResponse | null,
): ModelBinding | null {
  if (!state) return null;
  const legacyTargets = new Set(
    runs.flatMap((run) =>
      run.target.kind === "model" &&
      run.target.id === workproduct.id &&
      run.tasksetRef
        ? [run.tasksetRef.id]
        : [],
    ),
  );
  if (workproduct.tasksetId) legacyTargets.add(workproduct.tasksetId);
  return (
    state.modelBindings
      .filter(
        (binding) =>
          binding.status === "active" &&
          binding.role === "chat_manual" &&
          (binding.roleTargetId === workproduct.id ||
            legacyTargets.has(binding.roleTargetId)),
      )
      .sort((left, right) =>
        right.promotedAt.localeCompare(left.promotedAt),
      )[0] ?? null
  );
}
