import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ContinualLearningDailyBatchSchema, type ContinualLearningDailyBatch } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { describe, expect, it } from "vitest";

import { SqliteStore } from "../store/store.js";

const NOW = "2026-09-02T12:00:00.000Z";

function batch(): ContinualLearningDailyBatch {
  return ContinualLearningDailyBatchSchema.parse({
    schemaVersion: "openpond.continualLearningDailyBatch.v1",
    id: "daily-batch-1",
    seriesId: "series-1",
    scheduleEntryId: "series-1-p1",
    dayOrdinal: 1,
    label: "Day 1",
    source: "json_upload",
    sourceFileName: "day-1.json",
    sourceTaskset: { id: "eligible-1", revision: 1, contentHash: contentHash("eligible-1") },
    tasks: [{
      taskId: "task-1",
      taskContentHash: contentHash("task-1"),
      familyKey: "family-1",
      disposition: null,
      oracleReview: "pending",
      note: "",
      observedAttempt: null,
    }],
    status: "pending",
    queuedEntry: null,
    reviewedBy: null,
    reviewedAt: null,
    availableAt: NOW,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe("daily Evals batch persistence", () => {
  it("persists review progress with optimistic revisions and immutable intake identity", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-daily-evals-"));
    const store = new SqliteStore(directory);
    try {
      const original = await store.saveContinualLearningDailyBatch(batch());
      const reviewedAt = "2026-09-02T13:00:00.000Z";
      const reviewed = await store.saveContinualLearningDailyBatch({
        ...original,
        tasks: original.tasks.map((task) => ({ ...task, disposition: "include" as const, oracleReview: "confirmed" as const })),
        status: "reviewed",
        reviewedBy: "reviewer-1",
        reviewedAt,
        revision: 2,
        updatedAt: reviewedAt,
      });
      expect(reviewed.status).toBe("reviewed");
      expect(await store.listContinualLearningDailyBatches({ seriesId: "series-1" })).toEqual([reviewed]);
      await expect(store.saveContinualLearningDailyBatch({
        ...reviewed,
        scheduleEntryId: "series-1-p2",
        revision: 3,
      })).rejects.toThrow("preserve its intake identity");
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires a complete oracle and learning decision before review completion", () => {
    expect(() => ContinualLearningDailyBatchSchema.parse({
      ...batch(),
      status: "reviewed",
      reviewedBy: "reviewer-1",
      reviewedAt: NOW,
    })).toThrow("Every task requires a decision and oracle review");
  });
});
