import {
  ResolvedTrainingPlanSchema,
  RftRecipeSchema,
} from "@openpond/contracts";
import {
  createHarnessRunManifest,
} from "@openpond/training-sdk";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import { describe, expect, test } from "vitest";

import { createSandboxM8InputBundle } from "../apps/server/src/training/configured-sandbox-m8.js";
import {
  createManifestFixture,
  fixtureTimestamp,
} from "./helpers/portable-training-fixtures.js";

describe("configured Sandbox M8 composition", () => {
  test("projects one exact OpenPond GRPO plan into the M8 input contract", () => {
    const recipe = RftRecipeSchema.parse({
      schemaVersion: "openpond.rftRecipe.v1",
      method: "grpo",
      parameterization: "lora",
      baseModel: {
        id: "Qwen/Qwen3-4B-Instruct-2507",
        revision: "c".repeat(40),
        tokenizerRevision: "c".repeat(40),
        chatTemplateHash: sha256("renderer"),
      },
      dataset: {
        trainSplit: "train",
        validationSplit: "frozen_eval",
        maxPromptTokens: 3_072,
        maxExamples: 8,
      },
      lora: { rank: 16 },
      rollout: {
        groupSize: 4,
        concurrency: 4,
        maxTurns: 64,
        maxOutputTokens: 1_024,
        temperature: 0.8,
        topP: 0.95,
        seed: 17,
      },
      optimizer: {
        learningRate: 0.00001,
        maxSteps: 1,
      },
      loss: { method: "grpo", klBeta: null },
      reward: {
        graderId: "cross-system",
        graderHash: sha256("grader"),
        environmentId: "cross-system-operations",
        environmentVersion: "1",
        toolContractHash: sha256("tools"),
      },
      resourceLimits: {
        wallTimeMs: 2_400_000,
        maxRollouts: 8,
        maxPayloadBytes: 1_000_000,
      },
    });
    const source = createManifestFixture();
    const { contentHash: _sourceHash, ...sourceContent } = source;
    const workerImageDigest = `sha256:${sha256("worker")}`;
    const engineCapabilityReceipt = sha256("engine");
    const environmentHash = sha256("environment");
    const manifest = createHarnessRunManifest({
      ...sourceContent,
      model: {
        source: recipe.baseModel.id,
        revision: recipe.baseModel.revision,
        artifactHash: null,
        tokenizerRevision: recipe.baseModel.tokenizerRevision,
        chatTemplateHash: recipe.baseModel.chatTemplateHash,
      },
      recipe: {
        method: "grpo",
        version: "openpond.trainingRecipe.v1",
        configHash: contentHash(recipe),
      },
      runtimeTarget: {
        adapterId: "sandbox-latitude",
        placement: "remote",
        capabilityReceipt: sha256("runtime"),
        runtimeVersion: "verifiers-v1",
        dataPlane: {
          provider: "latitude",
          dataPlaneId: "openpond-latitude-staging",
          cellId: "openpond-latitude-staging-k8s",
          runnerPoolId: "openpond-latitude-staging-k8s:default",
          runtimeImageDigest: `sha256:${sha256("runtime-image")}`,
          capabilityReceipt: sha256("placement"),
        },
      },
      computeTarget: {
        adapterId: "prime-raw",
        kind: "managed",
        deviceOrPool: "gpu_1x_h100_sxm5",
        capabilityReceipt: sha256("compute"),
        provider: "prime",
      },
      engine: {
        adapterId: "connected-prime-rl",
        workerVersion: "0.0.38",
        workerImageDigest,
        upstreamRevision:
          "e0d60e4d85ea636873acb2e7083e794740d20226",
        capabilityReceipt: engineCapabilityReceipt,
      },
      resolvedBundleHash: environmentHash,
      approval: {
        approvalHash: sha256("approval"),
        approvedAt: fixtureTimestamp,
        maximumSpendUsd: 10,
      },
    });
    const planBase = {
      schemaVersion: "openpond.resolvedTrainingPlan.v1" as const,
      manifest,
      recipe,
      runtime: manifest.runtimeTarget,
      compute: manifest.computeTarget,
      engine: manifest.engine,
      maximumSpendUsd: 10,
      approvalHash: manifest.approval.approvalHash,
    };
    const plan = ResolvedTrainingPlanSchema.parse({
      ...planBase,
      contentHash: contentHash(planBase),
    });
    const template = {
      profileSnapshot: {
        profileId: "cross-system-operations",
      },
      taskset: {
        id: "cross-system-operations",
      },
      materialization: {
        environmentArchive: {
          schemaVersion: "openpond.harnessEnvironmentArchive.v1",
          sha256: environmentHash,
          rendererSha256: recipe.baseModel.chatTemplateHash,
        },
      },
      baseModel: {
        source: "huggingface",
        repoId: recipe.baseModel.id,
        revision: recipe.baseModel.revision,
        tokenizerHash: sha256("tokenizer"),
      },
      connectedGpu: {
        shape: "H100_80GB",
        maxHourlyUsd: "5.000000",
      },
      limits: {
        maxTotalUsd: "9.000000",
      },
    };

    const bundle = createSandboxM8InputBundle({
      plan,
      materialization: {
        materializationRef: "r2://materializations/one.json",
        materializationHash: sha256("materialization"),
        environmentArchiveRef: "r2://assets/environment.json",
        environmentArchiveHash: environmentHash,
      },
      quote: {
        providerQuote: {
          availabilityId: "availability-1",
          cloudId: "gpu_1x_h100_sxm5",
          providerType: "lambdalabs",
          dataCenterId: "us-south-2",
          region: "united_states",
          country: "US",
          security: "secure_cloud",
          socket: "SXM5",
          gpuCount: 1,
        },
      },
      template,
      expectedEngine: {
        workerImageDigest,
        upstreamRevision: plan.engine.upstreamRevision,
        capabilityReceipt: engineCapabilityReceipt,
      },
      environmentAssetHash: environmentHash,
    });

    expect(bundle).toMatchObject({
      schemaVersion: "openpond.managedRftInput.v2",
      harnessRunManifest: manifest,
      recipe: {
        adapter: { rank: 16, alpha: 32, dropout: 0 },
        maxSteps: 1,
        rolloutWorkers: 4,
        maxSequenceLength: 4_096,
        sourceConfigHash: manifest.recipe.configHash,
      },
      connectedGpu: {
        adapterId: "prime-raw",
        cloudId: "gpu_1x_h100_sxm5",
        workerImageDigest,
      },
    });
    const { manifestSha256, ...content } = bundle;
    expect(manifestSha256).toBe(contentHash(content));
  });
});
