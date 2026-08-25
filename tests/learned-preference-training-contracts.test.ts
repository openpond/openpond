import { describe, expect, it } from "vitest";

import {
  RewardModelVersionSchema,
  RewardModelRunSchema,
  RewardModelRecipeSchema,
  RftRecipeSchema,
} from "@openpond/contracts";
import { createRewardModelQualificationReport } from "@openpond/evals";

import { bindLearnedPreferenceReward } from "../apps/server/src/training/learned-preference-reward-binding.js";
import { managedRftRecipe } from "./helpers/managed-training-fixtures.js";

const HASH = "a".repeat(64);
const ref = (id: string) => ({ id, contentHash: HASH });

describe("learned preference training contracts", () => {
  it("represents Reward Models as a separate role with scalar-head artifacts", () => {
    const version = RewardModelVersionSchema.parse({
      schemaVersion: "openpond.rewardModelVersion.v1",
      id: "reward-r0",
      modelId: "taste-model",
      profileId: "profile-one",
      version: 1,
      role: "reward",
      scope: "synthetic_smoke",
      status: "available",
      baseModel: {
        schemaVersion: "openpond.baseModelPreference.v1",
        modelId: "small-multimodal-model",
        revision: "revision-one",
        tokenizerRevision: "tokenizer-one",
        chatTemplateHash: HASH,
        modelAssetId: null,
        source: "managed",
      },
      runtime: {
        baseModel: {
          source: "huggingface",
          repoId: "small-multimodal-model",
          revision: "b".repeat(40),
          configHash: HASH,
          tokenizerHash: HASH,
          licenseId: "apache-2-0",
          gated: false,
        },
        processor: {
          repository: "small-multimodal-model",
          revision: "b".repeat(40),
          configHash: HASH,
        },
      },
      taskset: { id: "taskset-one", revision: 1, contentHash: HASH },
      preferenceDatasetRelease: ref("preference-dataset-d0"),
      releaseGraph: {
        resolvedBundleHash: HASH,
        profileRelease: { id: "profile-one", revision: 1, contentHash: HASH },
        harnessRelease: ref("harness-one"),
        grader: ref("grader-one"),
      },
      artifacts: {
        checkpoint: {
          id: "reward-checkpoint",
          contentHash: HASH,
          objectRef: "r2://bucket/tenants/team/jobs/rm0/checkpoints/r0",
          files: [
            "adapter/adapter_config.json",
            "adapter/adapter_model.safetensors",
            "scalar-head.pt",
            "bucket-head.pt",
            "processor/preprocessor_config.json",
          ].map((path, index) => ({ path, sizeBytes: index + 1, sha256: HASH })),
        },
        adapter: ref("reward-adapter"),
        scalarHead: ref("scalar-head"),
        bucketHead: ref("bucket-head"),
        processorRelease: ref("processor"),
      },
      qualificationReport: ref("synthetic-smoke-report"),
      createdAt: "2026-08-25T12:00:00.000Z",
      contentHash: HASH,
    });
    expect(version.role).toBe("reward");
  });

  it("derives the frozen scorer runtime from the immutable Reward Model Version", () => {
    const version = RewardModelVersionSchema.parse({
      schemaVersion: "openpond.rewardModelVersion.v1",
      id: "reward-r0-runtime",
      modelId: "taste-model",
      profileId: "profile-one",
      version: 1,
      role: "reward",
      scope: "synthetic_smoke",
      status: "available",
      baseModel: {
        schemaVersion: "openpond.baseModelPreference.v1",
        modelId: "small-multimodal-model",
        revision: "revision-one",
        tokenizerRevision: "tokenizer-one",
        chatTemplateHash: HASH,
        modelAssetId: null,
        source: "managed",
      },
      runtime: {
        baseModel: { source: "huggingface", repoId: "small-multimodal-model", revision: "b".repeat(40), configHash: HASH, tokenizerHash: HASH, licenseId: "apache-2-0", gated: false },
        processor: { repository: "small-multimodal-model", revision: "b".repeat(40), configHash: HASH },
      },
      taskset: { id: "taskset-one", revision: 1, contentHash: HASH },
      preferenceDatasetRelease: ref("preference-dataset-d0"),
      releaseGraph: { resolvedBundleHash: HASH, profileRelease: { id: "profile-one", revision: 1, contentHash: HASH }, harnessRelease: ref("harness-one"), grader: ref("grader-one") },
      artifacts: {
        checkpoint: { id: "reward-checkpoint", contentHash: HASH, objectRef: "r2://bucket/tenants/team/jobs/rm0/checkpoints/r0", files: ["adapter/adapter_config.json", "adapter/adapter_model.safetensors", "scalar-head.pt", "bucket-head.pt", "processor/preprocessor_config.json"].map((path, index) => ({ path, sizeBytes: index + 1, sha256: HASH })) },
        adapter: ref("reward-adapter"), scalarHead: ref("scalar-head"), bucketHead: ref("bucket-head"), processorRelease: ref("processor"),
      },
      qualificationReport: ref("synthetic-smoke-report"),
      createdAt: "2026-08-25T12:00:00.000Z",
      contentHash: HASH,
    });
    const report = createRewardModelQualificationReport({
      schemaVersion: "openpond.rewardModelQualificationReport.v1",
      id: "synthetic-smoke-report",
      kind: "synthetic_smoke",
      rewardModelVersion: ref(version.id),
      preferenceDatasetRelease: version.preferenceDatasetRelease,
      tasksetRelease: { id: version.taskset.id, contentHash: version.taskset.contentHash },
      processorRelease: version.artifacts.processorRelease,
      metrics: { sampleCount: 8, finiteScoreRate: 1, scoreVariance: 0.1, checkpointReloadPassed: true, processorCompatibilityPassed: true, invalidAttemptExclusionPassed: true, orderedPairAccuracy: null, bucketAccuracy: null, tieAgreement: null },
      passed: true,
      productionRewardEligible: false,
      createdAt: "2026-08-25T12:00:00.000Z",
      metadata: {},
    });
    const binding = bindLearnedPreferenceReward({
      version,
      qualificationReport: report,
      rewardComposerRelease: ref("reward-composer"),
    });
    expect(binding.runtime).toEqual(version.runtime);
  });

  it("bounds synthetic Reward Model recipes independently from Policy recipes", () => {
    const recipe = RewardModelRecipeSchema.parse({
      schemaVersion: "openpond.rewardModelRecipe.v1",
      method: "reward_model",
      parameterization: "lora_with_scalar_head",
      runScope: "synthetic_smoke",
      baseModel: {
        id: "small-multimodal-model",
        revision: "revision-one",
        tokenizerRevision: "tokenizer-one",
        processorRevision: "processor-one",
        chatTemplateHash: HASH,
      },
      tasksetRelease: ref("taskset-one"),
      preferenceDatasetRelease: ref("preference-dataset-d0"),
      processorRelease: ref("processor-one"),
      lora: { rank: 8, alpha: 16, dropout: 0, targetModules: ["q_proj"] },
      heads: { scalar: "pooled_hidden_state_linear", bucket: "three_class" },
      loss: { ranking: "bradley_terry", rankingWeight: 1, bucketWeight: 0.25, tieWeight: 0.1 },
      optimizer: {
        learningRate: 0.0001,
        maxSteps: 2,
        batchSize: 2,
        gradientAccumulationSteps: 1,
        seed: 17,
        checkpointEverySteps: 1,
      },
      resourceLimits: {
        wallTimeMs: 600_000,
        maxExamples: 64,
        maxImagePixels: 1_000_000,
        maximumSpendUsd: 10,
      },
    });
    expect(recipe.method).toBe("reward_model");
    expect(() => RewardModelRecipeSchema.parse({
      ...recipe,
      resourceLimits: { ...recipe.resourceLimits, maximumSpendUsd: 10.01 },
    })).toThrow("USD 10");
  });

  it("keeps Reward Model training as a separately inspectable managed Run", () => {
    const run = RewardModelRunSchema.parse({
      schemaVersion: "openpond.rewardModelRun.v1",
      id: "reward-run-rm0",
      rewardModelId: "taste-model",
      rewardModelVersionId: "reward-r0",
      profileId: "profile-one",
      role: "reward",
      scope: "synthetic_smoke",
      status: "succeeded",
      taskset: { id: "taskset-one", revision: 1, contentHash: HASH },
      preferenceDatasetRelease: ref("preference-dataset-d0"),
      recipeRelease: ref("reward-recipe-one"),
      destinationId: "openpond_managed",
      quote: { maximumSpendUsd: 5, hourlyCostUsd: 0.5 },
      managedRunId: "managed-rm0",
      progress: { completedSteps: 2, totalSteps: 2, latestLoss: 0.4 },
      receipt: {
        schemaVersion: "openpond.rewardModelRunReceipt.v1",
        provider: "managed",
        providerRunId: "managed-rm0",
        resolvedBundleHash: HASH,
        finalCheckpoint: { ...ref("checkpoint-final"), objectRef: "r2://bucket/tenants/team/jobs/rm0/checkpoints/r0" },
        adapter: ref("adapter"),
        scalarHead: ref("scalar-head"),
        bucketHead: ref("bucket-head"),
        processorRelease: ref("processor"),
        optimizerEvidence: ref("optimizer-evidence"),
        parameterDeltaHash: HASH,
        cleanup: { computeReleased: true, providerTerminalObserved: true },
        contentHash: HASH,
      },
      qualificationReport: ref("synthetic-smoke-report"),
      accruedSpendUsd: 1,
      failureOwner: null,
      failure: null,
      startedAt: "2026-08-25T12:00:00.000Z",
      completedAt: "2026-08-25T12:01:00.000Z",
      updatedAt: "2026-08-25T12:01:00.000Z",
    });
    expect(run.role).toBe("reward");
    expect(run.receipt?.cleanup.providerTerminalObserved).toBe(true);
  });

  it("pins an exact learned Reward Model into a GRPO recipe", () => {
    const base = managedRftRecipe();
    const recipe = RftRecipeSchema.parse({
      ...base,
      reward: {
        ...base.reward,
        learnedPreference: {
          rewardModelVersion: ref("reward-r0"),
          qualificationReport: ref("synthetic-smoke-report"),
          checkpoint: {
            id: "reward-checkpoint",
            contentHash: HASH,
            objectRef: "r2://bucket/tenants/team/jobs/rm0/checkpoints/r0",
            files: [
              "adapter/adapter_config.json",
              "adapter/adapter_model.safetensors",
              "scalar-head.pt",
              "bucket-head.pt",
              "processor/preprocessor_config.json",
            ].map((path, index) => ({ path, sizeBytes: index + 1, sha256: HASH })),
          },
          runtime: {
            baseModel: { source: "huggingface", repoId: "google/siglip-base-patch16-224", revision: "b".repeat(40), configHash: HASH, tokenizerHash: HASH, licenseId: "apache-2.0", gated: false },
            processor: { repository: "google/siglip-base-patch16-224", revision: "b".repeat(40), configHash: HASH },
          },
          processorRelease: ref("processor-one"),
          rewardComposerRelease: ref("reward-composer-one"),
          qualificationKind: "synthetic_smoke",
        },
      },
    });
    expect(recipe.reward.learnedPreference?.rewardModelVersion.id).toBe("reward-r0");
  });
});
