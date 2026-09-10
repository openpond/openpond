import type { BoundJudgeProvider } from "@openpond/evals/learning";
import type { SqliteStore } from "../store/store.js";
import type { createTaskCreatorService } from "./task-creator.js";
import type { createTaskEvaluationService } from "./evaluation-service.js";
import type { createTaskMinerService } from "./task-miner.js";
import type { createTrainingService } from "./training-service.js";
import type { createTrainingChatSearchService } from "./training-chat-search.js";
import type { createDatasetArtifactService } from "./dataset-artifact-service.js";
import type { createDatasetImportService } from "./dataset-imports/import-service.js";
import type { createBenchmarkTasksetService } from "./benchmark-tasksets.js";
import type { createHarnessRefinerBenchmarkService } from "./harness-refiner-benchmark-service.js";
import type { createPreferenceComparisonService } from "./preference-comparison-service.js";
import type { createModelProjectHostingService } from "./model-project-hosting.js";
import type { createModelStarterRuntime } from "./model-starter-runtime.js";
import type { TasksetWorkModelStream } from "./taskset-work-attempt-runner.js";

export interface TrainingApiDependencies {
  store: SqliteStore;
  storeDir: string;
  taskCreator: ReturnType<typeof createTaskCreatorService>;
  taskMiner: ReturnType<typeof createTaskMinerService>;
  evaluation: ReturnType<typeof createTaskEvaluationService>;
  training: ReturnType<typeof createTrainingService>;
  chatSearch: ReturnType<typeof createTrainingChatSearchService>;
  datasetArtifacts: ReturnType<typeof createDatasetArtifactService>;
  datasetImports: ReturnType<typeof createDatasetImportService>;
  benchmarkTasksets: ReturnType<typeof createBenchmarkTasksetService>;
  harnessRefinerBenchmarks?: ReturnType<typeof createHarnessRefinerBenchmarkService>;
  preferenceComparisons?: ReturnType<typeof createPreferenceComparisonService>;
  modelProjectHosting?: ReturnType<typeof createModelProjectHostingService>;
  modelStarters?: ReturnType<typeof createModelStarterRuntime>;
  modelStream?: TasksetWorkModelStream;
  judgeProvider?: BoundJudgeProvider;
}
