import { TaskAttemptResultSchema, type ChatModelRef } from "@openpond/contracts";
import { describe, expect, it } from "vitest";

import {
  completedObservationPromptIds,
  observationBatchComplete,
  priorUnscorableAttemptIds,
  resolveObservationModel,
  reusableCanonicalAttempt,
  upsertObservationTask,
} from "../benchmarks/harness-refiner/observation-study/observation-resume.js";

const flash: ChatModelRef = {
  providerId: "openpond",
  modelId: "accounts/fireworks/models/deepseek-v4-flash",
};

describe("observation batch resume semantics", () => {
  it("defaults to OpenPond Chat and requires model overrides to be paired", () => {
    expect(resolveObservationModel({})).toEqual({ providerId: "openpond", modelId: "openpond-chat" });
    expect(resolveObservationModel({
      OPENPOND_REFINER_OBSERVATION_MODEL_PROVIDER: flash.providerId,
      OPENPOND_REFINER_OBSERVATION_MODEL_ID: flash.modelId,
    })).toEqual(flash);
    expect(() => resolveObservationModel({
      OPENPOND_REFINER_OBSERVATION_MODEL_PROVIDER: flash.providerId,
    })).toThrow("must be set together");
  });

  it("reuses only scored canonical evidence produced by the active model", () => {
    const attempts = [
      attempt("unscorable-flash", flash, "unscorable"),
      attempt("scored-openpond", { providerId: "openpond", modelId: "openpond-chat" }, "scored"),
      attempt("scored-flash", flash, "scored"),
    ];
    expect(reusableCanonicalAttempt(attempts, "task-1", flash)?.id).toBe("scored-flash");
    expect(priorUnscorableAttemptIds(attempts, "task-1", "scored-flash")).toEqual(["unscorable-flash"]);
  });

  it("keeps an unscorable prompt retryable and replaces it after a scored retry", () => {
    const tasks = [receiptTask(1, "unscorable")];
    expect([...completedObservationPromptIds(tasks)]).toEqual([]);
    expect(observationBatchComplete([1], tasks)).toBe(false);

    upsertObservationTask(tasks, receiptTask(1, "scored"));
    expect(tasks).toHaveLength(1);
    expect([...completedObservationPromptIds(tasks)]).toEqual([1]);
    expect(observationBatchComplete([1], tasks)).toBe(true);
  });
});

function attempt(id: string, modelRef: ChatModelRef, status: "scored" | "unscorable") {
  return TaskAttemptResultSchema.parse({
    schemaVersion: "openpond.taskAttempt.v1",
    id,
    tasksetId: "harness-refiner-observation-50-v2",
    taskId: "task-1",
    split: "test",
    attempt: 0,
    seed: 17,
    modelRef,
    startedAt: "2026-08-17T00:00:00.000Z",
    completedAt: "2026-08-17T00:00:01.000Z",
    output: {},
    runtimeEventRefs: [],
    artifactRefs: [],
    privilegedOutcomeRef: null,
    infrastructureError: status === "unscorable" ? "provider unavailable" : null,
    costUsd: null,
    latencyMs: 1_000,
    userInterventions: 0,
    metadata: { portableRewardReceipt: { status } },
  });
}

function receiptTask(promptId: number, status: "scored" | "unscorable") {
  return { promptId, canonical: { rewardReceipt: { status } } };
}
