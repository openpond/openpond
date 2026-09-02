import type { Taskset, TrainingPlan } from "@openpond/contracts";
import { describe, expect, it } from "vitest";

import { resolveManagedValidationTaskSource } from "./managed-training-validation-tasks.js";

const entryRef = {
  seriesId: "series-a",
  entryId: "entry-p1",
  scheduleEntryId: "schedule-p1",
  ordinal: 1,
  releaseHash: "a".repeat(64),
};

function taskset(id: string, splits: Array<"train" | "validation" | "frozen_eval">): Taskset {
  return {
    id,
    revision: 1,
    profileId: "profile-a",
    contentHash: `${id === "train" ? "b" : "c"}`.repeat(64),
    tasks: splits.map((split, index) => ({ id: `${id}-${index}`, split })),
    environment: { kind: "stateful_harness" },
  } as Taskset;
}

function plan(comparisonSeriesEntry: typeof entryRef | null): TrainingPlan {
  return { comparisonSeriesEntry } as TrainingPlan;
}

describe("managed continual-learning validation source", () => {
  it("uses validation rows already present in the training Taskset", async () => {
    const training = taskset("train", ["train", "validation"]);
    const result = await resolveManagedValidationTaskSource({
      store: {} as never,
      trainingPlan: plan(null),
      trainingTaskset: training,
    });
    expect(result.taskset.id).toBe("train");
    expect(result.tasks.map((task) => task.id)).toEqual(["train-1"]);
  });

  it("resolves the exact sealed development panel for a train-only series release", async () => {
    const training = taskset("train", ["train"]);
    const development = taskset("development", ["train", "validation", "frozen_eval"]);
    const store = {
      getModelComparisonSeriesEntry: async () => ({ ...entryRef, id: entryRef.entryId }),
      getModelComparisonSeries: async () => ({
        profileId: "profile-a",
        scheduleSealedAt: "2026-09-01T00:00:00.000Z",
        evaluationTasksets: {
          development: {
            id: development.id,
            revision: development.revision,
            contentHash: development.contentHash,
          },
        },
      }),
      getTasksetRevision: async () => development,
    };
    const result = await resolveManagedValidationTaskSource({
      store: store as never,
      trainingPlan: plan(entryRef),
      trainingTaskset: training,
    });
    expect(result.taskset.id).toBe("development");
    expect(result.tasks.map((task) => task.id)).toEqual([
      "development-1",
      "development-2",
    ]);
  });
});
