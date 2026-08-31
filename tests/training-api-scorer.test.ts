import { describe, expect, test, vi } from "vitest";

import type { Taskset } from "@openpond/contracts";
import { createTrainingApi } from "../apps/server/src/training/training-api";
import { tasksetFixture } from "./helpers/training-fixtures";

describe("training API scorer releases", () => {
  test("publishes a new immutable Taskset revision with the attached scorer", async () => {
    const original = tasksetFixture({ ready: true });
    let current: Taskset = original;
    const upsertTaskset = vi.fn(async (taskset: Taskset) => {
      current = taskset;
      return taskset;
    });
    const readiness = vi.fn(async () => ({ ready: true }));
    const api = createTrainingApi({
      store: {
        getTaskset: vi.fn(async () => current),
        upsertTaskset,
      },
      evaluation: { readiness },
    } as never);
    const grader = {
      id: "legal_quality",
      version: "1",
      label: "Legal quality",
      kind: "human",
      weight: 1,
      hardGate: false,
      rewardEligible: false,
      privileged: false,
      rubric: "Assess accuracy, completeness, and clarity.",
      reviewerRole: "Contract reviewer",
      metadata: {},
    } as const;

    const result = await api.request("create_scorer", {
      grader,
      tasksetId: original.id,
      modelProjectId: null,
    }) as { taskset: Taskset; hostedSync: { state: string } };

    expect(original.graders).not.toContainEqual(grader);
    expect(result.taskset.revision).toBe(original.revision + 1);
    expect(result.taskset.contentHash).not.toBe(original.contentHash);
    expect(result.taskset.graders).toContainEqual(grader);
    expect(result.hostedSync.state).toBe("local");
    expect(upsertTaskset).toHaveBeenCalledOnce();
    expect(readiness).toHaveBeenCalledWith(original.id);
  });

  test("rejects a duplicate scorer release on the selected Taskset", async () => {
    const grader = {
      id: "human_quality",
      version: "1",
      label: "Human quality",
      kind: "human",
      weight: 1,
      hardGate: false,
      rewardEligible: false,
      privileged: false,
      rubric: "Assess the response.",
      reviewerRole: "Reviewer",
      metadata: {},
    } as const;
    const taskset = tasksetFixture({ graders: [grader] });
    const upsertTaskset = vi.fn();
    const api = createTrainingApi({
      store: {
        getTaskset: vi.fn(async () => taskset),
        upsertTaskset,
      },
    } as never);

    await expect(api.request("create_scorer", {
      grader,
      tasksetId: taskset.id,
    })).rejects.toThrow("already attached");
    expect(upsertTaskset).not.toHaveBeenCalled();
  });
});
