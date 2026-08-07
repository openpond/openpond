import { describe, expect, test } from "vitest";
import type { TrainingStateResponse } from "@openpond/contracts";
import { projectTrainingActivity } from "../apps/server/src/training/training-activity";

describe("training activity projection", () => {
  test("creates a stable compact revision and counts active work", () => {
    const state = activityState();
    const first = projectTrainingActivity({
      profileId: "default",
      state,
      generatedAt: "2026-08-05T00:00:00.000Z",
    });
    const reordered = projectTrainingActivity({
      profileId: "default",
      state: { ...state, jobs: [...state.jobs].reverse() },
      generatedAt: "2026-08-05T00:01:00.000Z",
    });

    expect(first.active).toBe(true);
    expect(first.activeCounts).toEqual({
      jobs: 1,
      creations: 1,
      minerRuns: 1,
      datasetImports: 1,
    });
    expect(reordered.revision).toBe(first.revision);
  });

  test("changes revision when watched lifecycle state changes", () => {
    const state = activityState();
    const before = projectTrainingActivity({ profileId: "default", state });
    const after = projectTrainingActivity({
      profileId: "default",
      state: {
        ...state,
        jobs: state.jobs.map((job) => ({
          ...job,
          status: "succeeded",
          updatedAt: "2026-08-05T00:02:00.000Z",
        })),
        creations: [],
        minerRuns: [],
        datasetImports: [],
      },
    });

    expect(after.active).toBe(false);
    expect(after.revision).not.toBe(before.revision);
  });
});

function activityState(): Pick<
  TrainingStateResponse,
  "jobs" | "creations" | "minerRuns" | "datasetImports"
> {
  return {
    jobs: [
      lifecycleItem({ id: "job-b", status: "succeeded" }),
      lifecycleItem({ id: "job-a", status: "running" }),
    ] as TrainingStateResponse["jobs"],
    creations: [
      lifecycleItem({ id: "creation-a", state: "materializing" }),
    ] as TrainingStateResponse["creations"],
    minerRuns: [
      lifecycleItem({ id: "miner-a", status: "running" }),
    ] as TrainingStateResponse["minerRuns"],
    datasetImports: [
      lifecycleItem({ id: "import-a", status: "validating" }),
    ] as TrainingStateResponse["datasetImports"],
  };
}

function lifecycleItem<T extends object>(value: T): T & { updatedAt: string } {
  return { ...value, updatedAt: "2026-08-05T00:00:00.000Z" };
}
