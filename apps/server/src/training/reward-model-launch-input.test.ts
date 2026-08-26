import { describe, expect, test } from "vitest";

import { managedSyntheticRewardSmokeRecipe } from "./managed-reward-model-recipes.js";
import {
  buildManagedRewardModelLaunchInput,
  managedRewardModelIdempotencyKey,
} from "./reward-model-launch-input.js";

describe("managed Reward Model launch input", () => {
  test("scopes remote idempotency to the immutable local Run", () => {
    const recipeHash = "a".repeat(64);
    const first = managedRewardModelIdempotencyKey({ runId: "rm0", recipeHash });
    expect(first).toBe(managedRewardModelIdempotencyKey({ runId: "rm0", recipeHash }));
    expect(first).not.toBe(managedRewardModelIdempotencyKey({ runId: "rm1", recipeHash }));
    expect(first.length).toBeLessThanOrEqual(191);
  });

  test("resolves canonical preference receipt refs back to stored Attempts", async () => {
    const tasksetReleaseRef = {
      id: "taskset-release-t0-r1",
      contentHash: "a".repeat(64),
    };
    const tasksetRelease = {
      ...tasksetReleaseRef,
      revision: 1,
      tasks: [{ id: "scenario-1", input: { prompt: "Choose a coherent structured candidate." } }],
    } as never;
    const datasetRef = { id: "preferences-d0", contentHash: "b".repeat(64) };
    const receiptIds = ["receipt-love", "receipt-like", "receipt-reject"];
    const attempts = receiptIds.map((receiptId, index) => ({
      id: `attempt-${index}`,
      taskId: "scenario-1",
      output: { text: JSON.stringify({ traits: { background: `background-${index}` } }) },
      metadata: { portableAttemptReceipt: { id: receiptId } },
    }));
    const launch = await buildManagedRewardModelLaunchInput({
      idempotencyKey: "reward-run-rm0",
      name: "Reward RM0",
      sourceRunRef: "openpond:reward-model-run:rm0",
      taskset: { id: "taskset-t0", revision: 1, contentHash: "c".repeat(64) },
      tasksetRelease,
      dataset: {
        id: datasetRef.id,
        contentHash: datasetRef.contentHash,
        tasksetRelease,
        groups: ["reward_train", "reward_validation"].map((partition, index) => ({
          id: `group-${index}`,
          partition,
          rejectAll: false,
          attemptRefs: receiptIds.map((id) => ({ id, contentHash: "d".repeat(64) })),
          orderedBuckets: [[receiptIds[0]], [receiptIds[1]], [receiptIds[2]]],
        })),
      } as never,
      recipe: managedSyntheticRewardSmokeRecipe({
        tasksetRelease: tasksetReleaseRef,
        preferenceDatasetRelease: datasetRef,
      }),
      managedBaseModel: {
        source: "huggingface",
        repoId: "model/reward",
        revision: "revision",
        configHash: "e".repeat(64),
        tokenizerHash: "f".repeat(64),
        licenseId: "apache-2.0",
        gated: false,
      },
      attempts: attempts as never,
    });

    const groups = (launch.rewardModelTraining as {
      groups: Array<{
        candidates: Array<{
          id: string;
          bucket: string;
          text: string;
        }>;
      }>;
    }).groups;
    expect(groups.map((group) => group.candidates.map(({ id, bucket }) => ({ id, bucket })))).toEqual([
      [
        { id: "attempt-0", bucket: "love" },
        { id: "attempt-1", bucket: "like" },
        { id: "attempt-2", bucket: "reject" },
      ],
      [
        { id: "attempt-0", bucket: "love" },
        { id: "attempt-1", bucket: "like" },
        { id: "attempt-2", bucket: "reject" },
      ],
    ]);
    expect(JSON.parse(groups[0]!.candidates[0]!.text)).toEqual({
      schemaVersion: "openpond.structuredPreferenceCandidate.v1",
      scenario: { prompt: "Choose a coherent structured candidate." },
      candidate: { traits: { background: "background-0" } },
    });
    expect(JSON.stringify(launch)).not.toMatch(/data:image|imageDataUrl|artifactRenderer|\.png|\.svg/);
  });

  test("rejects non-JSON candidate output before a managed launch", async () => {
    const tasksetReleaseRef = { id: "taskset-release-t0-r1", contentHash: "a".repeat(64) };
    const datasetRef = { id: "preferences-d0", contentHash: "b".repeat(64) };
    const tasksetRelease = {
      ...tasksetReleaseRef,
      revision: 1,
      tasks: [{ id: "scenario-1", input: { prompt: "Return structured JSON." } }],
    } as never;
    const attemptRefs = ["receipt-love", "receipt-like", "receipt-reject"];

    await expect(buildManagedRewardModelLaunchInput({
      idempotencyKey: "reward-run-invalid",
      name: "Reward invalid",
      sourceRunRef: "openpond:reward-model-run:invalid",
      taskset: { id: "taskset-t0", revision: 1, contentHash: "c".repeat(64) },
      tasksetRelease,
      dataset: {
        id: datasetRef.id,
        contentHash: datasetRef.contentHash,
        tasksetRelease,
        groups: ["reward_train", "reward_validation"].map((partition, index) => ({
          id: `group-${index}`,
          partition,
          rejectAll: false,
          attemptRefs: attemptRefs.map((id) => ({ id, contentHash: "d".repeat(64) })),
          orderedBuckets: [[attemptRefs[0]], [attemptRefs[1]], [attemptRefs[2]]],
        })),
      } as never,
      recipe: managedSyntheticRewardSmokeRecipe({
        tasksetRelease: tasksetReleaseRef,
        preferenceDatasetRelease: datasetRef,
      }),
      managedBaseModel: {
        source: "huggingface",
        repoId: "model/reward",
        revision: "revision",
        configHash: "e".repeat(64),
        tokenizerHash: "f".repeat(64),
        licenseId: "apache-2.0",
        gated: false,
      },
      attempts: attemptRefs.map((receiptId, index) => ({
        id: `attempt-${index}`,
        taskId: "scenario-1",
        output: { text: "not json" },
        metadata: { portableAttemptReceipt: { id: receiptId } },
      })) as never,
    })).rejects.toThrow("is not valid structured JSON");
  });
});
