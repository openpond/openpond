import type {
  CreateImproveRun,
  ModelArtifactLineage,
  ModelBinding,
  ModelRun,
  ModelVersion,
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

export function labModelTasksets(
  state: TrainingStateResponse | null
): Taskset[] {
  if (!state) return [];
  const byRevision = new Map<string, Taskset>();
  for (const taskset of [
    ...(state.modelTasksets ?? []),
    ...(state.tasksets ?? []),
  ]) {
    byRevision.set(
      `${taskset.id}:${taskset.revision}:${taskset.contentHash}`,
      taskset
    );
  }
  return [...byRevision.values()];
}

export function labBaseModelVersion(
  workproduct: LabWorkproductSummary,
  state: TrainingStateResponse | null
): ModelVersion | null {
  return (
    (state?.modelVersions ?? [])
      .filter(
        (version) =>
          version.modelId === workproduct.id &&
          version.kind === "base_reference"
      )
      .sort((left, right) => right.version - left.version)[0] ?? null
  );
}

export function labLifecycleModelRuns(
  workproduct: LabWorkproductSummary,
  state: TrainingStateResponse | null
): ModelRun[] {
  return (
    (state?.modelRuns ?? [])
      .filter((run) => run.modelId === workproduct.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) ??
    []
  );
}

export function labModelPlans(
  workproduct: LabWorkproductSummary,
  runs: CreateImproveRun[],
  state: TrainingStateResponse | null
): TrainingPlan[] {
  if (!state) return [];
  const modelRuns = runs.filter(
    (run) => run.target.kind === "model" && run.target.id === workproduct.id
  );
  const planIds = new Set(
    modelRuns.flatMap((run) =>
      run.target.kind === "model" && run.target.trainingPlanId
        ? [run.target.trainingPlanId]
        : []
    )
  );
  const tasksetIds = new Set(
    modelRuns.flatMap((run) => (run.tasksetRef ? [run.tasksetRef.id] : []))
  );
  if (workproduct.tasksetId) tasksetIds.add(workproduct.tasksetId);
  return state.plans
    .filter(
      (plan) =>
        plan.modelId === workproduct.id ||
        planIds.has(plan.id) ||
        (plan.modelId === null && tasksetIds.has(plan.tasksetId))
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function labModelJobs(
  workproduct: LabWorkproductSummary,
  runs: CreateImproveRun[],
  state: TrainingStateResponse | null
): TrainingJob[] {
  if (!state) return [];
  const planIds = new Set(
    labModelPlans(workproduct, runs, state).map((plan) => plan.id)
  );
  const lifecycleRunIds = new Set(
    labLifecycleModelRuns(workproduct, state).map((run) => run.id)
  );
  return state.jobs
    .filter(
      (job) =>
        planIds.has(job.planId) ||
        job.metadata.modelProjectId === workproduct.id ||
        (typeof job.metadata.modelRunId === "string" &&
          lifecycleRunIds.has(job.metadata.modelRunId))
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function labModelDatasets(
  workproduct: LabWorkproductSummary,
  runs: CreateImproveRun[],
  state: TrainingStateResponse | null
): Taskset[] {
  if (!state) return [];
  const ids = new Set(
    labModelPlans(workproduct, runs, state).map((plan) => plan.tasksetId)
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
  return labModelTasksets(state).filter((taskset) => ids.has(taskset.id));
}

export function labModelVersions(
  workproduct: LabWorkproductSummary,
  runs: CreateImproveRun[],
  state: TrainingStateResponse | null
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
        model.modelId === workproduct.id || associatedJobIds.has(model.jobId)
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
          labModelTasksets(state).find(
            (taskset) => taskset.id === lineage.tasksetId
          ) ?? null,
        current: currentBinding?.modelArtifactLineageId === lineage.id,
      };
    })
    .sort((left, right) => right.number - left.number);
}

export function currentModelBinding(
  workproduct: LabWorkproductSummary,
  runs: CreateImproveRun[],
  state: TrainingStateResponse | null
): ModelBinding | null {
  if (!state) return null;
  const associatedJobIds = new Set(
    labModelJobs(workproduct, runs, state).map((job) => job.id)
  );
  const associatedLineageIds = new Set(
    state.models
      .filter(
        (lineage) =>
          lineage.modelId === workproduct.id ||
          associatedJobIds.has(lineage.jobId)
      )
      .map((lineage) => lineage.id)
  );
  const legacyTargets = new Set(
    runs.flatMap((run) =>
      run.target.kind === "model" &&
      run.target.id === workproduct.id &&
      run.tasksetRef
        ? [run.tasksetRef.id]
        : []
    )
  );
  if (workproduct.tasksetId) legacyTargets.add(workproduct.tasksetId);
  return (
    state.modelBindings
      .filter(
        (binding) =>
          binding.status === "active" &&
          binding.role === "chat_manual" &&
          (binding.roleTargetId === workproduct.id ||
            legacyTargets.has(binding.roleTargetId) ||
            (binding.roleTargetId === "default" &&
              associatedLineageIds.has(binding.modelArtifactLineageId)))
      )
      .sort((left, right) =>
        right.promotedAt.localeCompare(left.promotedAt)
      )[0] ?? null
  );
}
