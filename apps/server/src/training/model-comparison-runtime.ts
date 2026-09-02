import type { SqliteStore } from "../store/store.js";
import { createModelComparisonEvaluationScheduler } from "./model-comparison-evaluation-scheduler.js";
import { createModelComparisonEvaluationService } from "./model-comparison-evaluation-service.js";
import { createModelComparisonSeriesService } from "./model-comparison-series-service.js";
import { createModelCurrencyProjectionService } from "./model-currency-projection-service.js";
import type { TasksetWorkModelStream } from "./taskset-work-attempt-runner.js";

export function createModelComparisonRuntime(input: {
  store: SqliteStore;
  storeDir: string;
  modelStream?: TasksetWorkModelStream;
}) {
  const series = createModelComparisonSeriesService(input.store);
  const currency = createModelCurrencyProjectionService(input.store);
  let reconcileAutomaticEvaluations: () => Promise<unknown> = async () => null;
  const evaluations = createModelComparisonEvaluationService({
    store: input.store,
    storeDir: input.storeDir,
    comparisonSeries: series,
    modelStream: input.modelStream,
    projectCurrency: currency.reconcileEntry,
    reconcileAutomatic: () => reconcileAutomaticEvaluations(),
  });
  const scheduler = createModelComparisonEvaluationScheduler({ store: input.store, evaluations });
  reconcileAutomaticEvaluations = scheduler.reconcileAutomatic;
  void initialize().catch(() => undefined);

  return { series, evaluations, scheduler, currency };

  async function initialize() {
    await evaluations.reconcileInterrupted();
    await series.reconcileEntries();
    await currency.reconcileAll();
    await scheduler.reconcileAutomatic();
  }
}
