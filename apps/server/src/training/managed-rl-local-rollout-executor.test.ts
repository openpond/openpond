import type { Taskset } from "@openpond/contracts";
import { describe, expect, it } from "vitest";

import { resolveManagedRlExecutionTask } from "./managed-rl-local-rollout-executor.js";

function taskset(
  id: string,
  tasks: Array<{ id: string; split: "train" | "validation" }>,
): Taskset {
  return {
    id,
    revision: 1,
    profileId: "profile-a",
    contentHash: `${id === "training" ? "a" : "b"}`.repeat(64),
    tasks,
    environment: { kind: "stateful_harness" },
  } as Taskset;
}

describe("Managed RL local execution task resolution", () => {
  it("resolves a private validation claim from its exact validation Taskset", () => {
    const training = taskset("training", [{ id: "train-1", split: "train" }]);
    const validation = taskset("development", [
      { id: "validation-1", split: "validation" },
    ]);

    const result = resolveManagedRlExecutionTask({
      claimTaskId: "validation-1",
      trainingTaskset: training,
      validationTaskset: validation,
    });

    expect(result.taskset.id).toBe("development");
    expect(result.task.id).toBe("validation-1");
  });
});
