import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  DatasetSelectionStrategy,
  Taskset,
  TrainingPlan,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import type { DatasetProjectionResult } from "./dataset-artifact-service.js";
import type {
  FireworksTrainingRecord,
  FireworksTrainingSelection,
} from "./fireworks-dataset.js";

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

  async function resolveTrainingSelection(selectionInput: {
    taskset: Taskset;
    plan: TrainingPlan;
    split: "train" | "frozen_eval";
    maximumBytes: number;
  }): Promise<FireworksTrainingSelection> {
    if (
      selectionInput.plan.recipe.method !== "sft"
      && selectionInput.plan.recipe.method !== "grpo"
    ) {
      throw new Error("Fireworks selection requires SFT or GRPO.");
    }
    const seed = selectionInput.plan.recipe.method === "grpo"
      ? selectionInput.plan.recipe.rollout.seed
      : selectionInput.plan.recipe.optimizer.seed;
    if (selectionInput.taskset.datasetArtifact) {
      const projection = await projectArtifactRows(
        selectionInput.taskset,
        selectionInput.plan,
        selectionInput.split,
      );
      if (projection.sizeBytes > selectionInput.maximumBytes) {
        throw new Error(
          `The projected Dataset is ${projection.sizeBytes} bytes; the provider boundary allows ${selectionInput.maximumBytes}. Reduce Training examples.`,
        );
      }
      const bytes = await readFile(projection.outputPath);
      if (
        bytes.byteLength !== projection.sizeBytes
        || sha256(bytes) !== projection.contentHash
      ) {
        throw new Error("Projected Dataset rows failed integrity verification.");
      }
      return {
        records: parseTrainingRecords(bytes.toString("utf8")),
        eligibleRows: projection.eligibleRows,
        selectionSeed: projection.selectionSeed,
        selectionStrategy: projection.selectionStrategy,
        taskIdsHash: projection.taskIdsHash,
        sourceContentHash: projection.contentHash,
        sourceSizeBytes: projection.sizeBytes,
      };
    }
    const approvedSources = new Set(
      selectionInput.plan.dataPolicy.approvedSourceIds,
    );
    const approvedDemonstrations = new Set(
      selectionInput.taskset.learningSignals.demonstrations.flatMap((signal) =>
        signal.approved && signal.taskId ? [signal.taskId] : []),
    );
    const limit = selectionInput.split === "train"
      ? selectionInput.plan.recipe.dataset.maxExamples
      : 128;
    const records = selectionInput.taskset.tasks
      .filter((task) =>
        task.split === selectionInput.split
        && task.sourceRefs.every((source) => approvedSources.has(source))
        && (
          selectionInput.split !== "train"
          || selectionInput.plan.recipe.method === "grpo"
          || approvedDemonstrations.has(task.id)
        ))
      .sort((left, right) =>
        contentHash([
          selectionInput.taskset.contentHash,
          seed,
          selectionInput.split,
          left.id,
        ]).localeCompare(
          contentHash([
            selectionInput.taskset.contentHash,
            seed,
            selectionInput.split,
            right.id,
          ]),
        )
        || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((task): FireworksTrainingRecord => ({
        id: task.id,
        input: task.input,
        expectedOutput: task.expectedOutput,
        tags: task.tags,
      }));
    if (!records.length) {
      throw new Error(`No approved ${selectionInput.split} examples were selected.`);
    }
    const source = Buffer.from(
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    if (source.byteLength > selectionInput.maximumBytes) {
      throw new Error(
        `The selected Dataset is ${source.byteLength} bytes; the provider boundary allows ${selectionInput.maximumBytes}. Reduce Training examples.`,
      );
    }
    return {
      records,
      eligibleRows: records.length,
      selectionSeed: seed,
      selectionStrategy: "stable_hash_top_n",
      taskIdsHash: contentHash(records.map((record) => record.id)),
      sourceContentHash: sha256(source),
      sourceSizeBytes: source.byteLength,
    };
  }

  return { projectArtifactRows, resolveTrainingSelection };
}

function parseTrainingRecords(value: string): FireworksTrainingRecord[] {
  const lines = value.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length || lines.length > 100_000) {
    throw new Error("Projected Dataset contains an invalid number of examples.");
  }
  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Projected Dataset row ${index + 1} is not valid JSON.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Projected Dataset row ${index + 1} must be an object.`);
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.id !== "string"
      || !record.id.trim()
      || !record.input
      || typeof record.input !== "object"
      || Array.isArray(record.input)
      || !Array.isArray(record.tags)
      || !record.tags.every((tag) => typeof tag === "string")
      || (
        record.expectedOutput !== undefined
        && (
          !record.expectedOutput
          || typeof record.expectedOutput !== "object"
          || Array.isArray(record.expectedOutput)
        )
      )
    ) {
      throw new Error(`Projected Dataset row ${index + 1} has an invalid schema.`);
    }
    return {
      id: record.id,
      input: record.input as Record<string, unknown>,
      expectedOutput: record.expectedOutput as Record<string, unknown> | undefined,
      tags: record.tags as string[],
    };
  });
}
