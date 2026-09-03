import { describe, expect, it, vi } from "vitest";
import type {
  ModelComparisonSeriesEntry,
  TrainingArtifact,
  TrainingRecipe,
} from "@openpond/contracts";

import type { SqliteStore } from "../store/store.js";
import { comparisonSeriesTrainingRecipe } from "./comparison-series-training-recipe.js";

const HASH = "a".repeat(64);

function recipe(): TrainingRecipe {
  return {
    schemaVersion: "openpond.rftRecipe.v1",
    method: "grpo",
    parameterization: "lora",
    baseModel: {
      id: "base-model",
      revision: "revision-1",
      tokenizerRevision: "revision-1",
      chatTemplateHash: HASH,
    },
    dataset: {
      trainSplit: "train",
      validationSplit: "validation",
      maxPromptTokens: 1024,
      maxExamples: 100,
      selectionStrategy: "stable_hash_top_n",
    },
    lora: { rank: 16 },
    rollout: {
      groupSize: 4,
      concurrency: 1,
      maxTurns: 4,
      maxOutputTokens: 512,
      temperature: 0.7,
      topP: 1,
      seed: 7,
    },
    optimizer: {
      learningRate: 1e-5,
      maxSteps: 4,
      clipRange: 0.2,
      iterations: 2,
      microbatchSize: 1,
      gradientAccumulationSteps: 1,
      advantageEpsilon: 1e-8,
      adamw: { name: "adamw", weightDecay: 0, beta1: 0.9, beta2: 0.999, epsilon: 1e-8 },
    },
    loss: { method: "grpo", klBeta: null },
    reward: {
      graderId: "grader-1",
      graderHash: HASH,
      environmentId: "environment-1",
      environmentVersion: "1",
      toolContractHash: HASH,
    },
    resourceLimits: {
      wallTimeMs: 60_000,
      maxRollouts: 16,
      maxPayloadBytes: 1_000_000,
    },
    policyOptimization: null,
  };
}

function entry(parent: ModelComparisonSeriesEntry["parent"]): ModelComparisonSeriesEntry {
  return {
    seriesId: "series-1",
    scheduleEntryId: "schedule-p0",
    taskset: { id: "taskset-p0", revision: 1, contentHash: HASH },
    trainableRank: 3,
    parent,
  } as ModelComparisonSeriesEntry;
}

function executionStore(overrides: Record<string, unknown> = {}): SqliteStore {
  return {
    getModelComparisonSeries: vi.fn(async () => ({
      scheduleSealedAt: "2026-09-02T12:00:00.000Z",
      benchmarkProtocol: {
        resources: { maximumTrainingGpuSeconds: 180_000 },
        schedule: [{
          scheduleEntryId: "schedule-p0",
          optimizerGroupsPerTask: 1,
          trajectoriesPerGroup: 4,
        }],
      },
    })),
    getTasksetRevision: vi.fn(async () => ({ tasks: [
      { id: "task-1", split: "train" },
      { id: "task-2", split: "train" },
      { id: "held-out", split: "frozen_eval" },
    ] })),
    ...overrides,
  } as unknown as SqliteStore;
}

describe("Comparison Series executable recipe", () => {
  it("starts base-parent arms fresh at the sealed trainable rank", async () => {
    const resolved = await comparisonSeriesTrainingRecipe({
      store: executionStore(),
      recipe: { ...recipe(), continuation: {
        schemaVersion: "openpond.crossJobContinuationRequest.v1",
        parentArtifact: { id: "stale", contentHash: HASH },
        sourceArtifact: { jobId: "stale", artifactId: "stale", checkpointId: "stale", contentHash: HASH },
        optimizerMode: "reset",
      } },
      entry: entry({ kind: "base_model", id: "base-model", revision: "revision-1" }),
    });

    if (resolved.schemaVersion !== "openpond.rftRecipe.v1") throw new Error("Expected RFT recipe.");
    expect(resolved.lora.rank).toBe(3);
    expect(resolved.dataset.maxExamples).toBe(2);
    expect(resolved.rollout.groupSize).toBe(4);
    expect(resolved.optimizer.maxSteps).toBe(2);
    expect(resolved.resourceLimits.maxGpuSeconds).toBe(2_400);
    expect(resolved.resourceLimits.maxRollouts).toBe(8);
    expect("continuation" in resolved).toBe(false);
  });

  it("honors repeated sealed optimizer groups instead of collapsing a pass to one group per task", async () => {
    const store = executionStore({
      getModelComparisonSeries: vi.fn(async () => ({
        scheduleSealedAt: "2026-09-02T12:00:00.000Z",
        benchmarkProtocol: {
          resources: { maximumTrainingGpuSeconds: 180_000 },
          schedule: [{
            scheduleEntryId: "schedule-p0",
            optimizerGroupsPerTask: 16,
            trajectoriesPerGroup: 4,
          }],
        },
      })),
      getTasksetRevision: vi.fn(async () => ({ tasks: [{ id: "task-1", split: "train" }] })),
    });

    const resolved = await comparisonSeriesTrainingRecipe({
      store,
      recipe: recipe(),
      entry: entry({ kind: "base_model", id: "base-model", revision: "revision-1" }),
    });

    if (resolved.schemaVersion !== "openpond.rftRecipe.v1") throw new Error("Expected RFT recipe.");
    expect(resolved.dataset.maxExamples).toBe(1);
    expect(resolved.optimizer.maxSteps).toBe(16);
    expect(resolved.rollout.groupSize).toBe(4);
    expect(resolved.resourceLimits.maxRollouts).toBe(64);
    expect(resolved.resourceLimits.maxGpuSeconds).toBe(7_200);
  });

  it("binds a child arm to the exact Sandbox adapter and resets its optimizer", async () => {
    const artifact = {
      sha256: HASH,
      metadata: {
        provider: "sandbox",
        managedRlCandidate: true,
        managedRlJobId: "sandbox-job-1",
        managedRlOutputId: "sandbox-artifact-1",
        managedRlOutputMetadata: { checkpointId: "sandbox-checkpoint-1" },
      },
    } as unknown as TrainingArtifact;
    const store = executionStore({
      getModelVersion: vi.fn(async () => ({ contentHash: HASH, artifactLineageId: "lineage-1" })),
      getModelArtifactLineage: vi.fn(async () => ({ artifactId: "training-artifact-1" })),
      getTrainingArtifact: vi.fn(async () => artifact),
    });

    const resolved = await comparisonSeriesTrainingRecipe({
      store,
      recipe: recipe(),
      entry: entry({ kind: "model_version", id: "version-1", contentHash: HASH }),
    });

    if (resolved.schemaVersion !== "openpond.rftRecipe.v1") throw new Error("Expected RFT recipe.");
    expect(resolved.lora.rank).toBe(3);
    expect("continuation" in resolved ? resolved.continuation : null).toEqual({
      schemaVersion: "openpond.crossJobContinuationRequest.v1",
      parentArtifact: { id: "sandbox-artifact-1", contentHash: HASH },
      sourceArtifact: {
        jobId: "sandbox-job-1",
        artifactId: "sandbox-artifact-1",
        checkpointId: "sandbox-checkpoint-1",
        contentHash: HASH,
      },
      optimizerMode: "reset",
    });
  });
});
