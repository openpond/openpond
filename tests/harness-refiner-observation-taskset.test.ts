import { describe, expect, it } from "vitest";

import {
  buildObservationStudyTaskset,
  loadObservationStudyTasks,
} from "../benchmarks/harness-refiner/observation-study/study-taskset.js";

describe("fifty-task Harness Refiner observation Taskset", () => {
  it("materializes all fifty prompts with validated structural reward contracts", async () => {
    const tasks = await loadObservationStudyTasks();
    const taskset = buildObservationStudyTaskset(tasks);
    expect(tasks).toHaveLength(50);
    expect(taskset.tasks).toHaveLength(50);
    expect(new Set(taskset.tasks.map((task) => task.clusterKey))).toHaveLength(50);
    expect(taskset.tasks.filter((task) => task.requiredOutputs?.length)).toHaveLength(50);
    expect(taskset.tasks.filter((task) => task.split === "test")).toHaveLength(5);
    expect(taskset.graderFixtures).toHaveLength(6);
    expect(taskset.graderFixtures.filter((fixture) => fixture.infrastructureError)).toHaveLength(1);
    expect(taskset.graderFixtures.filter((fixture) =>
      !fixture.infrastructureError && !fixture.expectedPassed
    ).every((fixture) => fixture.expectedRewardEligible)).toBe(true);
  });
});
