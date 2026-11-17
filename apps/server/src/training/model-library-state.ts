import type { TrainingStateResponse } from "@openpond/contracts";
import type { TrainingApiDependencies } from "./training-api-dependencies.js";
import { projectTrainingActivity } from "./training-activity.js";

/** A library projection, not hydrated Dataset or run evidence. Detail/editor
 * routes request their existing full state or exact run-detail owner on demand. */
export async function readModelLibraryState(deps: TrainingApiDependencies, profileId: string): Promise<TrainingStateResponse> {
  const [modelProjects, modelVersions, modelRuns, comparisonSeries, plans, jobs, artifacts, models, modelBindings, minerConfig, activityMetadata, rewardModelRuns] = await Promise.all([
    deps.store.listModelProjects(), deps.store.listModelVersions(), deps.store.listModelRuns(), deps.store.listModelComparisonSeries(),
    deps.store.listTrainingPlans(), deps.store.listTrainingJobs(), deps.store.listTrainingArtifacts(), deps.store.listModelArtifactLineage(),
    deps.store.listModelBindings(), deps.taskMiner.config(profileId), deps.store.readTrainingActivityState(profileId), deps.store.listRewardModelRuns(),
  ]);
  return {
    schemaVersion: "openpond.trainingState.v1", projection: "models", profileId,
    modelProjects, modelVersions, modelRuns, comparisonSeries, plans, jobs, artifacts, models, modelBindings, minerConfig, rewardModelRuns,
    sources: [], creations: [], tasksetDrafts: [], tasksets: [], benchmarkRuns: [], benchmarkComparisons: [],
    datasetImports: [], datasetArtifacts: [], graderAuditReports: [], evaluationResults: [], candidates: [], minerRuns: [],
    comparisonSeriesEntries: [], modelCurrencySnapshots: [], continualBenchIssueReviews: [], continualLearningDailyBatches: [],
    rewardModelVersions: [], modelTasksets: [], bundles: [], rolloutReceipts: [], destinations: [], baseModelCandidates: [],
    activityRevision: projectTrainingActivity({ profileId, state: { ...activityMetadata, jobs } }).revision,
    generatedAt: new Date().toISOString(),
  };
}
