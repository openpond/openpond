import { describe, expect, it } from "vitest";

import {
  assertTasksetExecutableForTraining,
  trainingExecutionBlockers,
} from "../apps/server/src/training/training-execution-readiness.js";

const HASH = "a".repeat(64);

function tasksetWithBlockers(
  blockers: Array<{ code: string; message: string; path: string }>,
) {
  return {
    contentHash: HASH,
    readiness: {
      tasksetHash: HASH,
      blockers,
    },
  } as never;
}

describe("training execution readiness authority", () => {
  it("does not turn evaluation and recommendation findings into execution gates", () => {
    const taskset = tasksetWithBlockers([
      { code: "frozen_eval_missing", message: "no frozen eval", path: "tasks" },
      { code: "independent_evaluation_missing", message: "limited clusters", path: "tasks" },
      { code: "capability_diagnosis_missing", message: "no diagnosis", path: "metadata" },
      { code: "training_not_recommended", message: "not recommended", path: "metadata" },
      { code: "grader_audit_failed", message: "calibration failed", path: "graders" },
      { code: "grader_hacking", message: "legacy calibration label", path: "graders" },
      { code: "grader_adversarial_calibration_failed", message: "calibration failed", path: "graders" },
    ]);

    expect(trainingExecutionBlockers(taskset)).toEqual([]);
    expect(() => assertTasksetExecutableForTraining(taskset)).not.toThrow();
  });

  it("retains executable-data, authorization, integrity, security, and safety blockers", () => {
    const taskset = tasksetWithBlockers([
      { code: "online_reward_missing", message: "reward missing", path: "rewards" },
      { code: "sft_demonstrations_unapproved", message: "not approved", path: "signals" },
      { code: "example_provenance_missing", message: "origin missing", path: "tasks" },
      { code: "environment_leakage", message: "leak", path: "environment" },
      { code: "infrastructure_reward", message: "unsafe", path: "fixtures" },
    ]);

    expect(trainingExecutionBlockers(taskset).map((blocker) => blocker.code)).toEqual([
      "online_reward_missing",
      "sft_demonstrations_unapproved",
      "example_provenance_missing",
      "environment_leakage",
      "infrastructure_reward",
    ]);
    expect(() => assertTasksetExecutableForTraining(taskset)).toThrow(
      "Taskset cannot execute training",
    );
  });

  it("fails closed for stale or unknown readiness evidence", () => {
    expect(trainingExecutionBlockers({
      contentHash: HASH,
      readiness: { tasksetHash: "b".repeat(64), blockers: [] },
    } as never)[0]?.code).toBe("training_readiness_stale");
    expect(trainingExecutionBlockers({
      contentHash: HASH,
      readiness: null,
    } as never)[0]?.code).toBe("training_readiness_missing");
  });
});
