import type { ModelRun, Taskset } from "@openpond/contracts";

import type { SqliteStore } from "../store/store.js";

export function evaluationModelRunStatus(run: ModelRun) {
  return {
    runId: run.id,
    state: run.status,
    phase: run.evaluationProgress?.stage ?? run.status,
    progress: run.evaluationProgress
      ? run.evaluationProgress.completedAttempts
        / run.evaluationProgress.totalAttempts
      : ["succeeded", "failed", "cancelled"].includes(run.status)
        ? 1
        : null,
    updatedAt: run.updatedAt,
    errorCode: run.status === "failed" ? "evaluation_model_run_failed" : null,
    failure: run.failure,
    receipt: run.receipt,
  };
}

export async function loadBenchmarkHistory(
  store: SqliteStore,
  tasksets: Taskset[],
) {
  const [runs, comparisons] = await Promise.all([
    Promise.all(tasksets.map((taskset) => store.listBenchmarkRuns(taskset.id))),
    Promise.all(
      tasksets.map((taskset) => store.listBenchmarkComparisons(taskset.id)),
    ),
  ]);
  return {
    benchmarkRuns: runs.flat(),
    benchmarkComparisons: comparisons.flat(),
  };
}
