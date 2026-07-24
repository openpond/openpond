import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  DpoRecipeSchema,
  TrainingPlanSchema,
  type Taskset,
} from "../packages/contracts/src";
import {
  buildTrainingBundle,
  createTrainingPlan,
  validateTrainingCompatibility,
} from "../packages/training-sdk/src";
import { computeTasksetHash, contentHash } from "../packages/taskset-sdk/src";
import { withAuthoritativeRecipeHashes } from "../apps/server/src/training/training-service-helpers";
import { tasksetFixture } from "./helpers/training-fixtures";

describe("native DPO", () => {
  test("projects approved preference pairs deterministically and invalidates reference cache on pair changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openpond-dpo-"));
    try {
      const taskset = preferenceTaskset();
      const recipe = DpoRecipeSchema.parse(withAuthoritativeRecipeHashes(
        taskset,
        dpoRecipe(),
      ));
      const initial = createTrainingPlan({
        modelId: "model_dpo_fixture",
        taskset,
        destinationId: "local_cpu_fixture",
        recipe,
        exportApproved: true,
      });
      const capabilities = {
        schemaVersion: "openpond.trainingDestinationCapabilities.v1" as const,
        destinationId: "local_cpu_fixture" as const,
        available: true,
        methods: ["sft", "dpo", "ppo"] as const,
        parameterizations: ["lora"] as const,
        modelAllowlist: ["openpond/tiny-cpu-gpt2-fixture"],
        maxDatasetBytes: 10_000_000,
        environmentPlacements: ["none", "local"] as const,
        nonProduction: true,
        unavailableReason: null,
        checkedAt: "2026-07-23T12:00:00.000Z",
      };
      const compatibility = validateTrainingCompatibility({
        taskset,
        plan: initial,
        capabilities,
      });
      expect(compatibility.compatible).toBe(true);
      const plan = TrainingPlanSchema.parse({
        ...initial,
        compatibility,
        contentHash: contentHash({ ...initial, compatibility, contentHash: "" }),
      });
      const first = await buildTrainingBundle({
        taskset,
        plan,
        directory: path.join(root, "first"),
      });
      const second = await buildTrainingBundle({
        taskset,
        plan,
        directory: path.join(root, "second"),
      });
      const firstData = await readFile(path.join(root, "first/data/train.jsonl"), "utf8");
      const secondData = await readFile(path.join(root, "second/data/train.jsonl"), "utf8");
      expect(firstData).toBe(secondData);
      expect(first.files.find((file) => file.path === "data/train.jsonl")?.sha256)
        .toBe(second.files.find((file) => file.path === "data/train.jsonl")?.sha256);
      expect(JSON.parse(firstData)).toMatchObject({
        id: "preference_fixture",
        prompt: "Say hello.",
        chosen: "Hello friend.",
        rejected: "Go away.",
      });

      const changedTaskset = preferenceTaskset("Hello there.");
      const changedRecipe = DpoRecipeSchema.parse(
        withAuthoritativeRecipeHashes(changedTaskset, dpoRecipe()),
      );
      expect(changedRecipe.referenceLogprobs.invalidationHash)
        .not.toBe(recipe.referenceLogprobs.invalidationHash);
      expect(changedRecipe.referenceLogprobs.cacheKey)
        .not.toBe(recipe.referenceLogprobs.cacheKey);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function preferenceTaskset(chosen = "Hello friend."): Taskset {
  const base = tasksetFixture({ ready: true });
  const trainTask = base.tasks.find((task) => task.split === "train")!;
  const sourceId = base.sourceRefs[0]!.id;
  const draft = {
    ...base,
    capabilities: {
      ...base.capabilities,
      supportedSignals: ["preference" as const],
      compatibleMethods: ["dpo" as const],
      rewardKinds: ["none" as const],
    },
    learningSignals: {
      demonstrations: [],
      preferences: [{
        id: "preference_fixture",
        kind: "preference" as const,
        taskId: trainTask.id,
        sourceRefs: [sourceId],
        artifactRef: "preference_fixture_artifact",
        approved: true,
        confidence: 1,
        prompt: "Say hello.",
        chosen,
        rejected: "Go away.",
        rationale: "The chosen response is helpful.",
        metadata: {},
      }],
      corrections: [],
      feedback: [],
      rewards: [],
      labels: [],
    },
    readiness: null,
    contentHash: "00000000",
  };
  const tasksetHash = computeTasksetHash(draft);
  return {
    ...draft,
    contentHash: tasksetHash,
    readiness: {
      schemaVersion: "openpond.tasksetReadiness.v1",
      tasksetId: draft.id,
      tasksetHash,
      ready: true,
      recommendedMethod: "dpo",
      trainingPath: { primaryMethod: "dpo", bootstrap: null },
      methodReadiness: [{
        method: "dpo",
        status: "recommended",
        reasonCodes: [],
        reasons: [],
      }],
      compatibleDestinationClasses: ["local_cpu_fixture"],
      blockers: [],
      warnings: [],
      baselineReportId: null,
      baselineReward: null,
      generatedAt: "2026-07-23T12:00:00.000Z",
    },
  };
}

function dpoRecipe() {
  const model = {
    id: "openpond/tiny-cpu-gpt2-fixture",
    revision: "architecture-v2-seed-17-context-512",
    tokenizerRevision: "wordlevel-v1",
    chatTemplateHash: "fixture00000000",
  };
  return {
    schemaVersion: "openpond.dpoRecipe.v1",
    method: "dpo",
    parameterization: "lora",
    policyModel: model,
    referenceModel: model,
    dataset: {
      trainSplit: "train",
      validationSplit: "frozen_eval",
      maxPairs: 8,
      maxPromptTokens: 64,
      maxCompletionTokens: 64,
      selectionStrategy: "stable_hash_top_n",
      selectionSeed: 17,
    },
    lora: {
      rank: 2,
      alpha: 4,
      dropout: 0,
      targetModules: ["c_attn"],
    },
    loss: { variant: "sigmoid", beta: 0.1, labelSmoothing: 0 },
    optimizer: {
      learningRate: 0.01,
      epochs: 1,
      maxSteps: 2,
      batchSize: 1,
      gradientAccumulationSteps: 1,
      seed: 17,
    },
    referenceLogprobs: {
      cacheSchemaVersion: "openpond.dpoReferenceLogprobs.v1",
      cacheKey: "placeholder-cache",
      invalidationHash: "placeholder-invalidation",
    },
    resourceLimits: {
      cpuThreads: 2,
      memoryBytes: 2_000_000_000,
      wallTimeMs: 120_000,
    },
  } as const;
}
