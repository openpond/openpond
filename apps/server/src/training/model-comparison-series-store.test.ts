import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ModelComparisonSeriesEntrySchema,
  ModelComparisonSeriesSchema,
  type ModelComparisonSeries,
  type ModelComparisonSeriesEntry,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import { describe, expect, it } from "vitest";

import { SqliteStore } from "../store/store.js";

const NOW = "2026-09-01T12:00:00.000Z";
const ref = (id: string) => ({ id, revision: 1, contentHash: contentHash(id) });

function series(): ModelComparisonSeries {
  return ModelComparisonSeriesSchema.parse({
    schemaVersion: "openpond.modelComparisonSeries.v1",
    id: "series-store-test",
    profileId: "profile-store-test",
    modelProjectId: "project-store-test",
    name: "Store test",
    objective: "Exercise immutable comparison persistence.",
    status: "active",
    revision: 1,
    productionBinding: { role: "chat_manual", roleTargetId: "target-store-test" },
    baseModel: { id: "base-store-test", revision: "revision-store-test" },
    seedTaskset: ref("seed-store-test"),
    eligibleTaskPool: ref("eligible-store-test"),
    evaluationTasksets: {
      development: ref("development-store-test"),
      retained: ref("retained-store-test"),
      frozenFinal: ref("frozen-store-test"),
    },
    grader: { id: "grader-store-test", contentHash: contentHash("grader") },
    residualProfile: {
      profileId: "residual-store-test",
      serializedEnvelopeRank: 32,
      maximumEnabledRank: 32,
      topology: "uniform_block_masked",
    },
    schedule: [{
      id: "schedule-p0",
      ordinal: 0,
      label: "P0",
      role: "seed",
      parentRule: "base_model",
      taskSource: "seed_taskset",
      trainableRank: 16,
      minimumTasks: 1,
      maximumTasks: 100,
    }],
    scheduleSealedAt: NOW,
    advancementPolicy: {
      id: "advancement-store-test",
      version: 1,
      requireCheckpoint: true,
      requireAppliedOptimizerUpdate: true,
      minimumCurrentCohortMeanImprovement: 0.05,
      maximumRetainedMeanRegression: 0.02,
      blockCriticalInvariantRegression: true,
      automaticDailyAdvancement: true,
    },
    executionPolicy: { startWhenReady: false },
    acceptedSeedEntryId: null,
    acceptedDailyHeadEntryId: null,
    promotedBindingId: null,
    createdBy: "actor-store-test",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function entry(): ModelComparisonSeriesEntry {
  const taskset = ref("seed-store-test");
  const parent = { kind: "base_model" as const, id: "base-store-test", revision: "revision-store-test" };
  const block = {
    id: "block-store-test",
    branchOrdinal: 0,
    rank: 16,
    offsetStart: 0,
    offsetEnd: 16,
    optimizationRole: "trainable" as const,
    artifactLineageId: null,
  };
  return ModelComparisonSeriesEntrySchema.parse({
    schemaVersion: "openpond.modelComparisonSeriesEntry.v1",
    id: "entry-store-test",
    seriesId: "series-store-test",
    profileId: "profile-store-test",
    modelProjectId: "project-store-test",
    scheduleEntryId: "schedule-p0",
    releaseHash: contentHash({ parent, taskset, block }),
    ordinal: 0,
    label: "P0",
    role: "seed",
    branch: "daily",
    status: "ready",
    parent,
    taskset,
    sourceTasksets: [taskset],
    taskSelection: null,
    trainableRank: 16,
    serializedEnvelopeRank: 32,
    enabledCumulativeRank: 16,
    trainableBlockId: block.id,
    residualBlocks: [block],
    trainingPlanId: null,
    modelRunId: null,
    modelVersionId: null,
    evaluations: [],
    decision: null,
    promotionBindingId: null,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe("Model Comparison Series persistence", () => {
  it("allows exactly one concurrent series/head mutation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-comparison-store-"));
    const store = new SqliteStore(directory);
    try {
      const original = series();
      await store.saveModelComparisonSeries(original);
      const candidate = entry();
      const mutation = (suffix: string) => store.commitModelComparisonSeriesMutation({
        expectedSeriesRevision: 1,
        series: { ...original, revision: 2, updatedAt: `2026-09-01T12:00:0${suffix}.000Z` },
        entry: { ...candidate, updatedAt: `2026-09-01T12:00:0${suffix}.000Z` },
        expectedEntryStatus: null,
      });
      const results = await Promise.allSettled([mutation("1"), mutation("2")]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect((await store.getModelComparisonSeries(original.id))?.revision).toBe(2);
      expect(await store.listModelComparisonSeriesEntries({ seriesId: original.id })).toHaveLength(1);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects sealed-definition and linked-evidence replacement", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-comparison-immutable-"));
    const store = new SqliteStore(directory);
    try {
      const original = series();
      await store.saveModelComparisonSeries(original);
      await expect(store.saveModelComparisonSeries({
        ...original,
        revision: 2,
        name: "Mutated sealed name",
        updatedAt: "2026-09-01T12:01:00.000Z",
      })).rejects.toThrow("sealed");

      const linked = { ...entry(), trainingPlanId: "plan-a" };
      await store.saveModelComparisonSeriesEntry(linked);
      await expect(store.saveModelComparisonSeriesEntry({
        ...linked,
        trainingPlanId: "plan-b",
        updatedAt: "2026-09-01T12:02:00.000Z",
      })).rejects.toThrow("replace linked evidence");
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
