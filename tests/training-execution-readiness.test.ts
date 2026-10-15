import { describe, expect, it } from "vitest";
import { createRewardBinding, createRewardRelease } from "@openpond/evals/rewards";
import { learningRef } from "@openpond/evals/learning";
import { computeTasksetHash } from "@openpond/taskset-sdk";
import { buildTasksetReadiness } from "../apps/server/src/training/readiness.js";
import { rewardTasksetFixture } from "./helpers/training-fixtures.js";

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
  // A published executable binding is sufficient without duplicate legacy
  // signals, but evaluation-only or tampered bindings must never admit GRPO.
  it("admits only exact executable bound training rewards while retaining source gates", () => {
    const reward = createRewardRelease({
      schemaVersion: "openpond.rewardRelease.v1", id: "schema-reward", revision: 1,
      name: "Greeting schema", description: "", assets: [], rawScore: { minimum: 0, maximum: 1 },
      implementation: { kind: "schema", config: { jsonSchema: { type: "object" } } },
    });
    const source = { graderId: "expected_output", reward: learningRef(reward), role: "training" as const,
      normalization: { kind: "identity" as const }, weight: 1, required: true,
      hardGate: true, privileged: true, fixtureRefs: [] };
    const bindingFor = (sources: Array<typeof source | Omit<typeof source, "role"> & { role: "evaluation" }>) => createRewardBinding({
      schemaVersion: "openpond.rewardBinding.v1", id: "greeting-binding", revision: 1,
      sources, aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required",
    }, [reward]);
    const binding = bindingFor([source]);
    const fixture = rewardTasksetFixture();
    const taskset = { ...fixture, learningSignals: { ...fixture.learningSignals, rewards: [] },
      metadata: { ...fixture.metadata, trainingMethod: "grpo", rewardBinding: learningRef(binding),
        rewardExecution: { binding, rewards: [reward] } } };
    const report = (value = taskset) => buildTasksetReadiness({ taskset: { ...value, contentHash: computeTasksetHash(value) } });
    const ready = report();
    expect(ready.ready).toBe(true);
    expect(ready.methodReadiness.find((entry) => entry.method === "grpo")?.reasonCodes).toEqual([]);
    expect(() => assertTasksetExecutableForTraining({ ...taskset, contentHash: ready.tasksetHash, readiness: ready })).not.toThrow();
    for (const sources of [[{ ...source, role: "evaluation" as const }],
      [{ ...source, weight: 0 }, { ...source, graderId: "evaluation", role: "evaluation" as const }]]) {
      const evaluationBinding = bindingFor(sources);
      const rejected = report({ ...taskset, learningSignals: fixture.learningSignals,
        metadata: { ...taskset.metadata, rewardBinding: learningRef(evaluationBinding), rewardExecution: { binding: evaluationBinding, rewards: [reward] } } });
      expect(rejected.blockers.some((entry) => entry.code === "online_reward_missing")).toBe(true);
    }
    expect(() => report({ ...taskset, metadata: { ...taskset.metadata,
      rewardBinding: { ...learningRef(binding), contentHash: "b".repeat(64) } } })).toThrow();
    expect(() => report({ ...taskset, metadata: { ...taskset.metadata,
      rewardExecution: { binding, rewards: [{ ...reward, name: "Tampered" }] } } })).toThrow();
    const unreviewed = report({ ...taskset, sourceRefs: taskset.sourceRefs.map((entry) => ({ ...entry, secretScanStatus: "pending" as const })) });
    expect(unreviewed.blockers.some((entry) => entry.code === "source_secret_scan")).toBe(true);
  });

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
