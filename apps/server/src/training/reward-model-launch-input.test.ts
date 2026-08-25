import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { sha256 } from "@openpond/taskset-sdk";

import { managedSyntheticRewardSmokeRecipe } from "./managed-reward-model-recipes.js";
import { buildManagedRewardModelLaunchInput } from "./reward-model-launch-input.js";

describe("managed Reward Model launch input", () => {
  test("resolves canonical preference receipt refs back to stored Attempts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-reward-launch-"));
    const imagePath = path.join(directory, "candidate.png");
    const image = new Uint8Array([137, 80, 78, 71]);
    await writeFile(imagePath, image);
    const imageHash = sha256(image);
    const tasksetReleaseRef = {
      id: "taskset-release-t0-r1",
      contentHash: "a".repeat(64),
    };
    const tasksetRelease = {
      ...tasksetReleaseRef,
      revision: 1,
    } as never;
    const datasetRef = { id: "preferences-d0", contentHash: "b".repeat(64) };
    const receiptIds = ["receipt-love", "receipt-like", "receipt-reject"];
    const attempts = receiptIds.map((receiptId, index) => ({
      id: `attempt-${index}`,
      output: { text: `candidate-${index}` },
      metadata: { portableAttemptReceipt: { id: receiptId } },
    }));
    const artifacts = attempts.map((attempt, index) => ({
      id: `artifact-${index}`,
      attemptId: attempt.id,
      mediaType: "image/png",
      path: imagePath,
      sizeBytes: image.byteLength,
      sha256: imageHash,
    }));
    const uploadArtifact = vi.fn(async () => ({
      objectRef: "r2://managed-rl/candidate.png",
      sha256: imageHash,
      sizeBytes: image.byteLength,
      mediaType: "image/png",
      sideEffectsStarted: false,
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
      artifacts: artifacts as never,
      uploadArtifact,
    });

    expect(uploadArtifact).toHaveBeenCalledTimes(6);
    const groups = (launch.rewardModelTraining as {
      groups: Array<{
        candidates: Array<{
          id: string;
          bucket: string;
          artifact: Record<string, unknown>;
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
    expect(groups[0]?.candidates[0]?.artifact).toEqual({
      objectRef: "r2://managed-rl/candidate.png",
      sha256: imageHash,
      sizeBytes: image.byteLength,
      mediaType: "image/png",
    });
  });
});
