import { describe, expect, test } from "vitest";
import {
  estimateTrainingTaskSizing,
  recommendedTrainingSequenceLength,
  TasksetSchema,
  type Taskset,
  type TrainingPlan,
} from "../packages/contracts/src";
import { validateTrainingCompatibility } from "../packages/training-sdk/src/compatibility";
import { tasksetFixture } from "./helpers/training-fixtures";
import {
  fireworksRftRecipe,
  rftTasksetFixture,
} from "./helpers/fireworks-destination-fixtures";

describe("training trajectory sizing", () => {
  test("sizes structured tool messages instead of only their prompt and final text", () => {
    const taskset = structuredTaskset();
    const sizing = estimateTrainingTaskSizing(taskset.tasks[0]!);

    expect(sizing.assistantTargetCount).toBe(2);
    expect(sizing.renderedTokens).toBeGreaterThan(2_048);
    expect(sizing.maximumAssistantTargetTokens).toBeGreaterThan(128);
    expect(recommendedTrainingSequenceLength(taskset)).toBe(4_096);
  });

  test("blocks truncated assistant targets but allows explicit context truncation with a warning", () => {
    const taskset = structuredTaskset();
    const blocked = validateTrainingCompatibility({
      taskset,
      plan: planFor(taskset, 128),
      capabilities: capabilities(),
    });
    expect(blocked.compatible).toBe(false);
    expect(blocked.issues.map((issue) => issue.code)).toContain("training_completions_truncated");

    const bounded = validateTrainingCompatibility({
      taskset,
      plan: planFor(taskset, 512),
      capabilities: capabilities(),
    });
    expect(bounded.compatible).toBe(true);
    expect(bounded.issues.map((issue) => issue.code)).toContain("training_context_truncated");
  });

  test("allows the explicitly staged SFT bootstrap for a GRPO-primary Taskset", () => {
    const taskset = structuredTaskset();
    const staged = TasksetSchema.parse({
      ...taskset,
      capabilities: {
        ...taskset.capabilities,
        compatibleMethods: ["grpo"],
      },
      readiness: {
        ...taskset.readiness!,
        recommendedMethod: "grpo",
        trainingPath: {
          primaryMethod: "grpo",
          bootstrap: {
            method: "sft",
            purpose: "trajectory_bootstrap",
            demonstrationRefs: ["demo_train"],
            limitations: [
              "The SFT bootstrap imitates approved trajectories; it does not optimize verifier reward.",
            ],
          },
        },
      },
    });

    const report = validateTrainingCompatibility({
      taskset: staged,
      plan: planFor(staged, 4_096),
      capabilities: capabilities(),
    });

    expect(report.compatible).toBe(true);
    expect(report.issues.map((issue) => issue.code)).not.toContain(
      "taskset_method_incompatible",
    );
  });

  test("uses registered artifact split counts instead of requiring inline RFT rows", () => {
    const base = rftTasksetFixture();
    const taskset = {
      ...base,
      tasks: [],
      datasetArtifact: {
        schemaVersion: "openpond.datasetArtifact.v1",
        id: "dataset_artifact_compatibility",
        tasksetId: base.id,
        tasksetRevision: 1,
        contentHash: "artifacthash0000",
        format: "parquet",
        schema: {
          schemaVersion: "openpond.datasetSemanticSchema.v1",
          fields: [{
            name: "messages",
            semanticRole: "messages",
            logicalType: "messages",
            nullable: false,
            policy: "visible",
          }],
          schemaHash: "schemahash000000",
        },
        shards: [{
          id: "shard_train",
          split: "train",
          path: "data/train.parquet",
          contentHash: "shardhash000000",
          schemaHash: "schemahash000000",
          sizeBytes: 100,
          rowCount: 20,
          rowGroupCount: 1,
        }],
        rowCount: 20,
        splitCounts: {
          train: 20,
          validation: 0,
          test: 0,
          frozen_eval: 0,
        },
        sourceReceiptRefs: ["receipt_fixture"],
        mappingHash: "mappinghash0000",
        qualityReportHash: "qualityhash0000",
        createdAt: "2026-07-20T00:00:00.000Z",
      },
    } as Taskset;
    const recipe = fireworksRftRecipe();
    const plan: TrainingPlan = {
      schemaVersion: "openpond.trainingPlan.v1",
      id: "plan-artifact-rft",
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      destinationId: "fireworks",
      recipe,
      environmentPlacement: "provider_native",
      compatibility: null,
      dataPolicy: {
        exportApproved: true,
        approvedSourceIds: taskset.sourceRefs.map((source) => source.id),
        retentionDays: 7,
        region: null,
      },
      estimatedCostUsd: 3,
      createdAt: "2026-07-20T00:00:00.000Z",
      contentHash: "planhash-artifact-rft",
    };
    const report = validateTrainingCompatibility({
      taskset,
      plan,
      capabilities: {
        schemaVersion: "openpond.trainingDestinationCapabilities.v1",
        destinationId: "fireworks",
        available: true,
        methods: ["sft", "grpo"],
        parameterizations: ["lora"],
        modelAllowlist: [recipe.baseModel.id],
        maxDatasetBytes: 1_000_000,
        environmentPlacements: ["provider_native"],
        nonProduction: false,
        unavailableReason: null,
        checkedAt: "2026-07-20T00:00:00.000Z",
      },
    });

    expect(report.issues.map((issue) => issue.code)).not.toContain(
      "rft_train_split_empty",
    );
  });
});

function structuredTaskset() {
  const base = tasksetFixture({ ready: true });
  return TasksetSchema.parse({
    ...base,
    tasks: [{
      ...base.tasks[0],
      split: "train",
      input: { messages: [
        { role: "system", content: "Use tools." },
        { role: "user", content: "Reconcile every unmatched payment." },
      ] },
      expectedOutput: { messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "search_crm", arguments: JSON.stringify({ query: "*", fields: ["account_id", "name", "aliases"], cursor: null, limit: 50 }) } }] },
        { role: "tool", tool_call_id: "call_1", content: "x".repeat(4_000) },
        { role: "assistant", content: "y".repeat(300) },
      ] },
    }],
  });
}

function planFor(taskset: Taskset, maxSequenceLength: number): TrainingPlan {
  return {
    schemaVersion: "openpond.trainingPlan.v1",
    id: `plan-${maxSequenceLength}`,
    tasksetId: taskset.id,
    tasksetHash: taskset.contentHash,
    destinationId: "local_cpu_fixture",
    recipe: {
      schemaVersion: "openpond.sftRecipe.v1",
      method: "sft",
      parameterization: "lora",
      baseModel: { id: "fixture", revision: "revision", tokenizerRevision: "tokenizer", chatTemplateHash: "templatehash" },
      dataset: { trainSplit: "train", validationSplit: "frozen_eval", completionOnly: true, maxSequenceLength },
      lora: { rank: 2, alpha: 4, dropout: 0, targetModules: ["c_attn"] },
      optimizer: { learningRate: 0.01, epochs: 1, maxSteps: 2, batchSize: 1, gradientAccumulationSteps: 1, seed: 17 },
      resourceLimits: { cpuThreads: 2, memoryBytes: 2_000_000_000, wallTimeMs: 120_000 },
    },
    environmentPlacement: "none",
    compatibility: null,
    dataPolicy: { exportApproved: true, approvedSourceIds: taskset.sourceRefs.map((source) => source.id), retentionDays: null, region: null },
    estimatedCostUsd: 0,
    createdAt: "2026-07-15T00:00:00.000Z",
    contentHash: `hash-${maxSequenceLength}`,
  };
}

function capabilities() {
  return {
    schemaVersion: "openpond.trainingDestinationCapabilities.v1" as const,
    destinationId: "local_cpu_fixture",
    available: true,
    methods: ["sft" as const],
    parameterizations: ["lora" as const],
    modelAllowlist: [],
    maxDatasetBytes: null,
    environmentPlacements: ["local" as const],
    nonProduction: true,
    unavailableReason: null,
    checkedAt: "2026-07-15T00:00:00.000Z",
  };
}
