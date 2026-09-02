import type { Taskset } from "@openpond/contracts";
import { describe, expect, it } from "vitest";

import {
  managedRlSandboxCompletion,
  resolveManagedRlExecutionTask,
} from "./managed-rl-local-rollout-executor.js";

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

  it("preserves every policy result required by a multi-turn Harness receipt", () => {
    const policyResults = [
      { servedPolicyVersion: 0, trainingSample: { modelRequestId: "turn-1" } },
      { servedPolicyVersion: 0, trainingSample: { modelRequestId: "turn-2" } },
    ];

    expect(managedRlSandboxCompletion({
      status: "succeeded",
      executorId: "desktop-executor",
      environmentSha256: "a".repeat(64),
      policyResult: policyResults[1],
      policyResults,
      trace: {
        schemaVersion: "openpond.managedRlLocalHarnessReceipt.v2",
        trainingSampleSha256s: ["sample-1", "sample-2"],
      },
      evaluationEvidence: { private: "not part of the completion contract" },
    })).toEqual({
      status: "succeeded",
      executorId: "desktop-executor",
      environmentSha256: "a".repeat(64),
      policyResult: policyResults[1],
      policyResults,
      trace: {
        schemaVersion: "openpond.managedRlLocalHarnessReceipt.v2",
        trainingSampleSha256s: ["sample-1", "sample-2"],
      },
    });
  });
});
