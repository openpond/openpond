import path from "node:path";
import type {
  DatasetSelectionStrategy,
  Taskset,
  TrainingPlan,
} from "@openpond/contracts";
import type { DatasetProjectionResult } from "./dataset-artifact-service.js";

export type ProjectDatasetArtifact = (input: {
  tasksetId: string;
  split: "train" | "validation" | "test" | "frozen_eval";
  mode: "sft" | "grpo";
  limit: number;
  seed: number;
  selectionStrategy?: DatasetSelectionStrategy;
  approvedSourceIds: string[];
  outputPath: string;
}) => Promise<DatasetProjectionResult>;

export function toProjectedTrainingData(
  projection: DatasetProjectionResult | null,
) {
  return projection
    ? {
        path: projection.outputPath,
        contentHash: projection.contentHash,
        sizeBytes: projection.sizeBytes,
        exampleCount: projection.exampleCount,
        eligibleRows: projection.eligibleRows,
        selectionSeed: projection.selectionSeed,
        selectionStrategy: projection.selectionStrategy,
        taskIdsHash: projection.taskIdsHash,
      }
    : null;
}

export function createTrainingDatasetSelection(input: {
  storeDir: string;
  projectDatasetArtifact?: ProjectDatasetArtifact;
}) {
  async function projectArtifactRows(
    taskset: Taskset,
    plan: TrainingPlan,
    split: "train" | "frozen_eval",
  ): Promise<DatasetProjectionResult> {
    if (!taskset.datasetArtifact || !input.projectDatasetArtifact) {
      throw new Error("Dataset artifact projection is unavailable.");
    }
    if (plan.recipe.method !== "sft" && plan.recipe.method !== "grpo") {
      throw new Error(`Training method ${plan.recipe.method} cannot project Dataset rows.`);
    }
    const seed = plan.recipe.method === "grpo"
      ? plan.recipe.rollout.seed
      : plan.recipe.optimizer.seed;
    const available = taskset.datasetArtifact.splitCounts[split] ?? 0;
    const limit = split === "train"
      ? Math.min(available, plan.recipe.dataset.maxExamples)
      : Math.min(available, 128);
    if (limit < 1) {
      throw new Error(`Dataset artifact has no ${split} rows to project.`);
    }
    return input.projectDatasetArtifact({
      tasksetId: taskset.id,
      split,
      mode: plan.recipe.method,
      limit,
      seed,
      selectionStrategy: plan.recipe.method === "grpo"
        ? plan.recipe.dataset.selectionStrategy
        : "stable_hash_top_n",
      approvedSourceIds: plan.dataPolicy.approvedSourceIds,
      outputPath: path.join(
        input.storeDir,
        "training",
        "projections",
        plan.id,
        `${split}-${plan.recipe.method}-${limit}-${seed}.jsonl`,
      ),
    });
  }

  return { projectArtifactRows };
}
