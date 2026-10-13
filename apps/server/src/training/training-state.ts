import type { TrainingApiDependencies } from "./training-api-dependencies.js";
import { loadBenchmarkHistory } from "./training-benchmark-state.js";
import { syncModelTrainingCreateImproveRuns } from "./model-create-improve-reconciliation.js";
import { projectTrainingActivity } from "./training-activity.js";

export function createTrainingStateReader(
  deps: TrainingApiDependencies,
  prepare: (profileId: string) => Promise<void>,
) {
  const pending = new Map<string, ReturnType<typeof readState>>();
  function state(profileId: string) {
    const current = pending.get(profileId);
    if (current) return current;
    const request = readState(profileId).finally(() => pending.delete(profileId));
    pending.set(profileId, request);
    return request;
  }
  async function readState(profileId: string) {
    await prepare(profileId);
    const [
      sources,
      creations,
      tasksetDrafts,
      tasksets,
      datasetImports,
      datasetArtifacts,
      candidates,
      minerConfig,
      minerRuns,
      modelProjects,
      comparisonSeriesRecords,
      modelCurrencySnapshots,
      continualBenchIssueReviews,
      continualLearningDailyBatches,
      modelTasksets,
      execution,
    ] = await Promise.all([
      deps.store.listTrainingSources(profileId),
      deps.store.listTaskCreationSnapshots(profileId),
      deps.store.listTasksetDrafts(profileId),
      deps.store.listTasksets(profileId),
      deps.store.listDatasetImportJobs(profileId),
      deps.datasetArtifacts.summaries(profileId),
      deps.store.listTaskCandidates(profileId, "all"),
      deps.taskMiner.config(profileId),
      deps.store.listTaskMinerRuns(profileId),
      deps.store.listModelProjects(),
      // Model Projects are an account-wide library. Comparison Series must use
      // the same scope or a series disappears whenever the active assistant
      // profile changes even though its Project, Runs, and Versions remain
      // visible on the Models dashboard.
      deps.store.listModelComparisonSeries(),
      deps.store.listModelCurrencySnapshots(),
      deps.store.listContinualBenchIssueReviews(),
      deps.store.listContinualLearningDailyBatches(),
      deps.store.listTasksets(),
      deps.training.state(),
    ]);
    const [reconciledModelVersions, reconciledModelRuns, reconciledComparisonSeriesEntries] =
      await Promise.all([
        deps.store.listModelVersions(),
        deps.store.listModelRuns(),
        deps.store.listModelComparisonSeriesEntries(),
      ]);
    await syncModelTrainingCreateImproveRuns({ store: deps.store, profileId, execution });
    const graderAuditReports = (
      await Promise.all(tasksets.map((taskset) => deps.store.listGraderAuditReports(taskset.id)))
    ).flat();
    const evaluationResults = (
      await Promise.all(tasksets.map((taskset) => deps.store.listEvaluationResults(taskset.id)))
    ).flat();
    const { benchmarkRuns, benchmarkComparisons } = await loadBenchmarkHistory(
      deps.store,
      tasksets,
    );
    const activity = projectTrainingActivity({
      profileId,
      state: {
        jobs: execution.jobs,
        creations,
        minerRuns,
        datasetImports,
        tasksetDrafts,
        tasksets,
        modelProjects,
      },
    });
    return {
      schemaVersion: "openpond.trainingState.v1",
      profileId,
      sources,
      creations,
      tasksetDrafts,
      tasksets,
      benchmarkRuns,
      benchmarkComparisons,
      datasetImports,
      datasetArtifacts,
      graderAuditReports,
      evaluationResults,
      candidates,
      minerConfig,
      minerRuns,
      modelProjects,
      modelVersions: reconciledModelVersions,
      modelRuns: reconciledModelRuns,
      comparisonSeries: comparisonSeriesRecords,
      comparisonSeriesEntries: reconciledComparisonSeriesEntries,
      modelCurrencySnapshots,
      continualBenchIssueReviews,
      continualLearningDailyBatches,
      modelTasksets,
      ...execution,
      activityRevision: activity.revision,
      generatedAt: new Date().toISOString(),
    };
  }

  async function activity(profileId: string) {
    const [metadata, execution] = await Promise.all([
      deps.store.readTrainingActivityState(profileId),
      deps.training.activity({ background: true }),
    ]);
    return projectTrainingActivity({ profileId, state: { ...metadata, jobs: execution.jobs } });
  }

  return { state, activity };
}
