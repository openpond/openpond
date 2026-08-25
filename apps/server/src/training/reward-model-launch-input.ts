import type {
  RewardModelRecipe,
  TaskAttemptResult,
} from "@openpond/contracts";
import type { PreferenceDatasetRelease } from "@openpond/evals";
import type { TasksetRelease } from "@openpond/evals";
import { contentHash } from "@openpond/harness";

export type ManagedRewardModelBase = {
  source: "huggingface";
  repoId: string;
  revision: string;
  configHash: string;
  tokenizerHash: string;
  licenseId: string;
  gated: boolean;
};

export function managedRewardModelIdempotencyKey(input: {
  runId: string;
  recipeHash: string;
}): string {
  return `openpond-reward-model:${contentHash({
    runId: input.runId,
    recipeHash: input.recipeHash,
  }).slice(0, 48)}`;
}

export async function buildManagedRewardModelLaunchInput(input: {
  idempotencyKey: string;
  name: string;
  sourceRunRef: string;
  taskset: { id: string; revision: number; contentHash: string };
  tasksetRelease: TasksetRelease;
  dataset: PreferenceDatasetRelease;
  recipe: RewardModelRecipe;
  managedBaseModel: ManagedRewardModelBase;
  attempts: TaskAttemptResult[];
}): Promise<Record<string, unknown>> {
  if (
    input.recipe.tasksetRelease.id !== input.tasksetRelease.id ||
    input.recipe.tasksetRelease.contentHash !== input.tasksetRelease.contentHash ||
    input.dataset.tasksetRelease.id !== input.tasksetRelease.id ||
    input.dataset.tasksetRelease.contentHash !== input.tasksetRelease.contentHash
  ) {
    throw new Error("Reward Model launch must use the exact Taskset release pinned by D0 and the recipe.");
  }
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
  const tasks = new Map(input.tasksetRelease.tasks.map((task) => [task.id, task]));
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
        const candidates = group.attemptRefs.map((attemptRef) => {
          const attempt = attempts.get(attemptRef.id) ?? attemptsByReceipt.get(attemptRef.id);
          const bucket = bucketByAttempt.get(attemptRef.id);
          const task = attempt ? tasks.get(attempt.taskId) : undefined;
          if (!attempt || !task || !bucket) {
            throw new Error(`Preference group ${group.id} is missing an Attempt, Scenario, or label.`);
          }
          const text = JSON.stringify({
            schemaVersion: "openpond.structuredPreferenceCandidate.v1",
            scenario: task.input,
            candidate: structuredCandidateOutput(attempt),
          });
          if (text.length > input.recipe.input.maxCharacters) {
            throw new Error(`Preference candidate ${attempt.id} exceeds the Reward Model input limit.`);
          }
          return {
            id: attempt.id,
            text,
            bucket,
          };
        });
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
    taskset: {
      id: input.tasksetRelease.id,
      revision: input.tasksetRelease.revision,
      contentHash: input.tasksetRelease.contentHash,
    },
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

function structuredCandidateOutput(attempt: TaskAttemptResult): unknown {
  const outputText = attempt.output.text;
  if (typeof outputText !== "string") {
    throw new Error(`Preference candidate ${attempt.id} does not contain structured JSON text.`);
  }
  try {
    const parsed: unknown = JSON.parse(outputText);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Structured candidate output must be a JSON object.");
    }
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Preference candidate ${attempt.id} is not valid structured JSON: ${detail}`);
  }
}
