import { describe, expect, it } from "vitest";

import { projectQualifiedRewardModel } from "../apps/server/src/training/reward-model-qualification-projection.js";

const HASH = "a".repeat(64);
const REVISION = "b".repeat(40);

function input(overrides: Record<string, unknown> = {}) {
  return {
    run: {
      id: "reward-run-rm0",
      rewardModelId: "taste-model",
      profileId: "profile-one",
      scope: "synthetic_smoke",
      status: "running",
      taskset: { id: "taskset-t0", revision: 1, contentHash: HASH },
      preferenceDatasetRelease: { id: "dataset-d0", contentHash: HASH },
    },
    baseModel: {
      schemaVersion: "openpond.baseModelPreference.v1",
      modelId: "small-multimodal-model",
      revision: REVISION,
      tokenizerRevision: REVISION,
      chatTemplateHash: null,
      modelAssetId: null,
      source: "managed",
    },
    runtime: {
      baseModel: { source: "huggingface", repoId: "small-multimodal-model", revision: REVISION, configHash: HASH, tokenizerHash: HASH, licenseId: "apache-2-0", gated: false },
      processor: { repository: "small-multimodal-model", revision: REVISION, configHash: HASH },
    },
    resolvedBundleHash: HASH,
    profileRelease: { id: "profile-one", revision: 1, contentHash: HASH },
    harnessRelease: { id: "harness-h0", contentHash: HASH },
    grader: { id: "preference-comparison", contentHash: HASH },
    providerRunId: "managed-rm0",
    checkpointPrefix: "r2://managed-rl/tenants/team/jobs/rm0/checkpoints/r0",
    artifactSha256: HASH,
    inventory: [
      "adapter/adapter_config.json",
      "scalar-head.pt",
      "bucket-head.pt",
      "processor/preprocessor_config.json",
      "optimizer.pt",
    ].map((path, index) => ({ path, sha256: HASH, sizeBytes: index + 1 })),
    evidence: {
      parameterHashBefore: "c".repeat(64),
      parameterHashAfter: "d".repeat(64),
      qualification: {
        checkpointReloadPassed: true,
        processorCompatibilityPassed: true,
        invalidAttemptExclusionPassed: true,
        finiteScoreRate: 1,
        sampleCount: 4,
        scoreVariance: 0.1,
      },
    },
    cleanup: { computeReleased: true, providerTerminalObserved: true },
    createdAt: "2026-08-25T12:00:00.000Z",
    ...overrides,
  } as never;
}

describe("Reward Model qualification projection", () => {
  it("creates a smoke-only R0 only from terminal cleanup and reload evidence", () => {
    const result = projectQualifiedRewardModel(input());
    expect(result.version.runtime?.baseModel.revision).toBe(REVISION);
    expect(result.report.kind).toBe("synthetic_smoke");
    expect(result.report.productionRewardEligible).toBe(false);
    expect(result.receipt.cleanup).toEqual({ computeReleased: true, providerTerminalObserved: true });
  });

  it("rejects non-varying validation scores and incomplete cleanup", () => {
    expect(() => projectQualifiedRewardModel(input({
      evidence: {
        qualification: { checkpointReloadPassed: true, finiteScoreRate: 1, sampleCount: 4, scoreVariance: 0 },
      },
    }))).toThrow("reload, processor, invalid-exclusion, finite, and varying-score gates");
    expect(() => projectQualifiedRewardModel(input({
      cleanup: { computeReleased: false, providerTerminalObserved: true },
    }))).toThrow("terminal managed cleanup");
  });
});
