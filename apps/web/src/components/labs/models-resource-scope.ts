import type { TrainingStateResponse } from "@openpond/contracts";
import type { ModelsRoute } from "./models-route";

/** Discovery scope never rewrites the recorded execution/version owner. */
export function modelResourceOwner(route: ModelsRoute, state: TrainingStateResponse | null): string | null {
  if (!state || !route.resourceId) return route.modelId;
  const separator = route.resourceId.indexOf(":");
  const kind = route.resourceId.slice(0, separator);
  const id = route.resourceId.slice(separator + 1);
  if (kind === "model-run") return state.modelRuns.find((run) => run.id === id)?.modelId ?? null;
  if (kind === "job") {
    const job = state.jobs.find((job) => job.id === id);
    return job ? state.plans.find((plan) => plan.id === job.planId)?.modelId ?? null : null;
  }
  if (kind === "version") {
    return state.modelVersions.find((version) => version.artifactLineageId === id)?.modelId
      ?? state.models.find((lineage) => lineage.id === id)?.modelId ?? null;
  }
  return null;
}

export function modelScopedResources(state: TrainingStateResponse | null, modelId: string | null): TrainingStateResponse | null {
  if (!state || !modelId) return state;
  const project = state.modelProjects.find((project) => project.id === modelId);
  const ids = new Set(project?.tasksetSyncs.map((sync) => sync.localTasksetId) ?? []);
  if (project?.trainingSetup.tasksetRef) ids.add(project.trainingSetup.tasksetRef.id);
  const series = state.comparisonSeries.filter((series) => series.modelProjectId === modelId);
  const seriesIds = new Set(series.map((series) => series.id));
  return { ...state, tasksets: state.tasksets.filter((taskset) => ids.has(taskset.id)), modelTasksets: state.modelTasksets.filter((taskset) => ids.has(taskset.id)), comparisonSeries: series, comparisonSeriesEntries: state.comparisonSeriesEntries.filter((entry) => seriesIds.has(entry.seriesId)), continualLearningDailyBatches: state.continualLearningDailyBatches.filter((batch) => seriesIds.has(batch.seriesId)) };
}
