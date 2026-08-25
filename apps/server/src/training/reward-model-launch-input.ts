import { readFile } from "node:fs/promises";

import type {
  RewardModelRecipe,
  TaskAttemptArtifact,
  TaskAttemptResult,
} from "@openpond/contracts";
import type { PreferenceDatasetRelease } from "@openpond/evals";
import { contentHash } from "@openpond/harness";
import { sha256 } from "@openpond/taskset-sdk";

type ManagedArtifact = {
  objectRef: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
};

export type ManagedRewardModelBase = {
  source: "huggingface";
  repoId: string;
  revision: string;
  configHash: string;
  tokenizerHash: string;
  licenseId: string;
  gated: boolean;
};

export async function buildManagedRewardModelLaunchInput(input: {
  idempotencyKey: string;
  name: string;
  sourceRunRef: string;
  taskset: { id: string; revision: number; contentHash: string };
  dataset: PreferenceDatasetRelease;
  recipe: RewardModelRecipe;
  managedBaseModel: ManagedRewardModelBase;
  uploadArtifact: (input: {
    bytes: Uint8Array;
    mediaType: string;
    idempotencyKey: string;
  }) => Promise<ManagedArtifact>;
  attempts: TaskAttemptResult[];
  artifacts: TaskAttemptArtifact[];
}): Promise<Record<string, unknown>> {
  if (
    input.recipe.preferenceDatasetRelease.id !== input.dataset.id ||
    input.recipe.preferenceDatasetRelease.contentHash !== input.dataset.contentHash
  ) {
    throw new Error("Reward Model recipe must pin the materialized preference dataset.");
  }
  const attempts = new Map(input.attempts.map((attempt) => [attempt.id, attempt]));
  const attemptsByReceipt = new Map<string, TaskAttemptResult>();
  for (const attempt of input.attempts) {
    const receipt = attempt.metadata.portableAttemptReceipt;
    if (
      receipt
      && typeof receipt === "object"
      && "id" in receipt
      && typeof receipt.id === "string"
    ) {
      attemptsByReceipt.set(receipt.id, attempt);
    }
  }
  const imageByAttempt = new Map<string, TaskAttemptArtifact>();
  for (const artifact of input.artifacts) {
    if (!artifact.mediaType?.startsWith("image/")) continue;
    if (!imageByAttempt.has(artifact.attemptId)) imageByAttempt.set(artifact.attemptId, artifact);
  }
  const groups = await Promise.all(
    input.dataset.groups
      .filter((group) => group.partition === "reward_train" || group.partition === "reward_validation")
      .map(async (group) => {
        if (group.rejectAll || group.orderedBuckets.length < 2) {
          throw new Error(`Preference group ${group.id} has no ordered signal for Reward Model training.`);
        }
        const bucketByAttempt = new Map<string, "love" | "like" | "reject">();
        for (const [index, bucket] of group.orderedBuckets.entries()) {
          const label = index === 0 ? "love" : index === group.orderedBuckets.length - 1 ? "reject" : "like";
          for (const attemptId of bucket) bucketByAttempt.set(attemptId, label);
        }
        const candidates = await Promise.all(group.attemptRefs.map(async (attemptRef) => {
          const attempt = attempts.get(attemptRef.id) ?? attemptsByReceipt.get(attemptRef.id);
          const artifact = attempt ? imageByAttempt.get(attempt.id) : undefined;
          const bucket = bucketByAttempt.get(attemptRef.id);
          if (!attempt || !artifact || !bucket) {
            throw new Error(`Preference group ${group.id} is missing an Attempt, rendered image, or label.`);
          }
          const mediaType = artifact.mediaType;
          if (!mediaType?.startsWith("image/")) {
            throw new Error(`Preference group ${group.id} artifact ${artifact.id} is not an image.`);
          }
          const bytes = await readFile(artifact.path);
          if (bytes.byteLength !== artifact.sizeBytes || sha256(bytes) !== artifact.sha256) {
            throw new Error(`Rendered artifact ${artifact.id} changed before managed Reward Model upload.`);
          }
          const uploaded = await input.uploadArtifact({
            bytes,
            mediaType,
            idempotencyKey: `${input.idempotencyKey}:artifact:${artifact.sha256}`,
          });
          if (uploaded.sha256 !== artifact.sha256 || uploaded.sizeBytes !== bytes.byteLength) {
            throw new Error(`Managed artifact upload did not preserve ${artifact.id}.`);
          }
          return {
            id: attempt.id,
            text: JSON.stringify(attempt.output),
            bucket,
            artifact: uploaded,
          };
        }));
        return {
          id: group.id,
          partition: group.partition,
          candidates,
        };
      }),
  );
  if (!groups.some((group) => group.partition === "reward_train") || !groups.some((group) => group.partition === "reward_validation")) {
    throw new Error("Reward Model launch requires D0 train and validation groups.");
  }
  const content = {
    schemaVersion: "openpond.managedRlRewardModelLaunchRequest.v1",
    name: input.name,
    idempotencyKey: input.idempotencyKey,
    sourceRunRef: input.sourceRunRef,
    taskset: input.taskset,
    preferenceDatasetRelease: { id: input.dataset.id, contentHash: input.dataset.contentHash },
    scope: input.recipe.runScope === "synthetic_smoke" ? "synthetic_smoke" as const : "production" as const,
    rewardModelTraining: {
      schemaVersion: "openpond.managedRlRewardModelTraining.v1",
      preferenceDatasetRelease: { id: input.dataset.id, contentHash: input.dataset.contentHash },
      baseModel: input.managedBaseModel,
      processor: {
        repository: input.recipe.baseModel.id,
        revision: input.recipe.baseModel.processorRevision,
        configHash: input.recipe.processorRelease.contentHash,
      },
      groups,
      recipe: {
        lora: { rank: input.recipe.lora.rank, alpha: input.recipe.lora.alpha, dropout: input.recipe.lora.dropout },
        learningRate: input.recipe.optimizer.learningRate,
        maxSteps: input.recipe.optimizer.maxSteps,
        seed: input.recipe.optimizer.seed,
        bucketWeight: input.recipe.loss.bucketWeight,
        tieWeight: input.recipe.loss.tieWeight,
      },
    },
    maximumSpendUsd: input.recipe.resourceLimits.maximumSpendUsd,
  };
  return {
    ...content,
    requestHash: contentHash(content),
  };
}
