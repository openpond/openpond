import { describe, expect, test } from "vitest";
import {
  estimateTrainingTaskSizing,
  recommendedTrainingSequenceLength,
  TasksetSchema,
  type TrainingPlan,
} from "../packages/contracts/src";
import { validateTrainingCompatibility } from "../packages/training-sdk/src/compatibility";
import { tasksetFixture } from "./helpers/training-fixtures";

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

function planFor(taskset: ReturnType<typeof structuredTaskset>, maxSequenceLength: number): TrainingPlan {
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
