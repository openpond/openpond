import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  selectPreferredRftSignalReport,
  type BaselineReport,
  type RftRecipe,
  type Taskset,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";

export function withAuthoritativeRecipeHashes(
  taskset: Taskset,
  recipe: unknown,
): unknown {
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
    return recipe;
  }
  const candidate = recipe as Record<string, unknown>;
  if (candidate.method === "dpo") {
    const policyModel = record(candidate.policyModel);
    const referenceModel = record(candidate.referenceModel);
    const dataset = record(candidate.dataset);
    const invalidationHash = contentHash({
      tasksetHash: taskset.contentHash,
      preferenceSignals: taskset.learningSignals.preferences.map((signal) => ({
        id: signal.id,
        artifactRef: signal.artifactRef,
        prompt: signal.prompt,
        chosen: signal.chosen,
        rejected: signal.rejected,
        approved: signal.approved,
      })),
      policyModel,
      referenceModel,
      dataset,
    });
    return {
      ...candidate,
      referenceLogprobs: {
        cacheSchemaVersion: "openpond.dpoReferenceLogprobs.v1",
        cacheKey: contentHash(["dpo-reference-logprobs", invalidationHash]),
        invalidationHash,
      },
    };
  }
  if (candidate.method === "ppo") {
    const policyOptimization = record(candidate.policyOptimization);
    const policyModel = record(policyOptimization.policyModel);
    const referenceModel = record(policyOptimization.referenceModel);
    const optimizer = record(policyOptimization.optimizer);
    const valueModel = record(optimizer.valueModel);
    const dataset = record(policyOptimization.dataset);
    const reward = record(policyOptimization.reward);
    const policyHash = contentHash(policyModel);
    const referenceHash = contentHash(referenceModel);
    const valueModelHash = contentHash(valueModel);
    return {
      ...candidate,
      policyOptimization: {
        ...policyOptimization,
        dataset: {
          ...dataset,
          tasksetId: taskset.id,
          tasksetHash: taskset.contentHash,
        },
        reward: {
          ...reward,
          graderHash: contentHash(taskset.graders),
        },
      },
      resume: {
        ...record(candidate.resume),
        policyHash,
        referenceHash,
        valueModelHash,
      },
    };
  }
  if (candidate.method !== "grpo") return recipe;
  const reward =
    candidate.reward
    && typeof candidate.reward === "object"
    && !Array.isArray(candidate.reward)
      ? candidate.reward as Record<string, unknown>
      : {};
  const baseModel = record(candidate.baseModel);
  const dataset = record(candidate.dataset);
  const rollout = record(candidate.rollout);
  const optimizer = record(candidate.optimizer);
  const loss = record(candidate.loss);
  const resourceLimits = record(candidate.resourceLimits);
  const maxExamples = positiveInteger(dataset.maxExamples, 1);
  const groupSize = positiveInteger(rollout.groupSize, 2);
  const maxOutputTokens = positiveInteger(rollout.maxOutputTokens, 1);
  const maxPromptTokens = positiveInteger(dataset.maxPromptTokens, 1);
  const maxSteps = positiveInteger(optimizer.maxSteps, 1);
  return {
    ...candidate,
    reward: {
      ...reward,
      graderHash: contentHash(taskset.graders),
    },
    policyOptimization: {
      schemaVersion: "openpond.policyOptimization.v1",
      policyModel: baseModel,
      referenceModel: baseModel,
      dataset: {
        tasksetId: taskset.id,
        tasksetHash: taskset.contentHash,
        split: "train",
        selectionStrategy: dataset.selectionStrategy,
        selectionSeed: rollout.seed,
        maxExamples,
      },
      sampler: {
        temperature: rollout.temperature,
        topP: rollout.topP,
        maxOutputTokens,
        maxTurns: rollout.maxTurns,
        concurrency: rollout.concurrency,
      },
      environment: {
        id: reward.environmentId,
        version: reward.environmentVersion,
        toolContractHash: reward.toolContractHash,
      },
      reward: {
        graderId: reward.graderId,
        graderHash: contentHash(taskset.graders),
      },
      kl: {
        coefficient: loss.klBeta ?? null,
        referenceConstraint: "fixed_reference",
      },
      budgets: {
        maxRollouts: positiveInteger(resourceLimits.maxRollouts, maxExamples * groupSize),
        maxEnvironmentExecutions: positiveInteger(resourceLimits.maxRollouts, maxExamples * groupSize),
        maxInputTokens: maxExamples * groupSize * maxPromptTokens,
        maxOutputTokens: maxExamples * groupSize * maxOutputTokens,
        maxOptimizerSteps: maxSteps,
        wallTimeMs: positiveInteger(resourceLimits.wallTimeMs, 180_000),
        maximumCostUsd: null,
      },
      checkpointEverySteps: Math.max(1, Math.min(10, maxSteps)),
      seed: rollout.seed,
      evaluationSplit: "frozen_eval",
      optimizer: {
        method: "grpo",
        groupSize,
        normalization: "group_standardized",
        loss: loss.method ?? "grpo",
      },
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ""
    && !relative.startsWith("..")
    && !path.isAbsolute(relative);
}

export async function assertArtifactIntegrity(
  artifactPath: string,
  expectedHash: string,
  expectedSize: number,
): Promise<void> {
  const bytes = await readFile(artifactPath);
  if (
    bytes.byteLength !== expectedSize
    || sha256(bytes) !== expectedHash
  ) {
    throw new Error(
      "Model promotion refused an artifact that failed integrity verification.",
    );
  }
}

export async function requireFireworksApprovalActor(
  resolveApprovalActor: (() => Promise<string | null>) | undefined,
): Promise<string> {
  const actor = (await resolveApprovalActor?.())?.trim() ?? "";
  if (!actor) {
    throw new Error(
      "Fireworks training requires a signed-in OpenPond account profile with a handle.",
    );
  }
  return actor;
}

export function matchingRftSignalGate(
  reports: BaselineReport[],
  recipe: RftRecipe,
) {
  const report = selectPreferredRftSignalReport(reports, {
    split: "train",
    taskCount: recipe.dataset.maxExamples,
    attemptsPerTask: recipe.rollout.groupSize,
    selectionSeed: recipe.rollout.seed,
    selectionStrategy: recipe.dataset.selectionStrategy,
    model: {
      providerId: "fireworks",
      modelId: recipe.baseModel.id,
    },
    sampling: {
      maxOutputTokens: recipe.rollout.maxOutputTokens,
      temperature: recipe.rollout.temperature,
      topP: recipe.rollout.topP,
    },
  });
  if (!report?.scope || !report.rftSignal) return null;
  return {
    baselineReportId: report.id,
    baselineReportHash: contentHash(report),
    scope: report.scope,
    signal: report.rftSignal,
  };
}
