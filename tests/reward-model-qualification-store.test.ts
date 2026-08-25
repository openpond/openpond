import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createRewardModelQualificationReport } from "@openpond/evals";

import {
  loadRewardModelQualificationReport,
  saveRewardModelQualificationReport,
} from "../apps/server/src/training/reward-model-qualification-store.js";

const HASH = "a".repeat(64);

describe("Reward Model qualification store", () => {
  it("persists and revalidates the exact immutable report used by a policy binding", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-reward-report-"));
    const report = createRewardModelQualificationReport({
      schemaVersion: "openpond.rewardModelQualificationReport.v1",
      id: "reward-model-qualification-rm0",
      kind: "synthetic_smoke",
      rewardModelVersion: { id: "reward-model-version-rm0", contentHash: HASH },
      preferenceDatasetRelease: { id: "preference-dataset-d0", contentHash: HASH },
      tasksetRelease: { id: "taskset-t0", contentHash: HASH },
      processorRelease: { id: "processor-r0", contentHash: HASH },
      metrics: {
        sampleCount: 4,
        finiteScoreRate: 1,
        scoreVariance: 0.1,
        checkpointReloadPassed: true,
        processorCompatibilityPassed: true,
        invalidAttemptExclusionPassed: true,
        orderedPairAccuracy: null,
        bucketAccuracy: null,
        tieAgreement: null,
      },
      passed: true,
      productionRewardEligible: false,
      createdAt: "2026-08-25T12:00:00.000Z",
      metadata: {},
    });
    try {
      await saveRewardModelQualificationReport({ storeDir, report });
      await expect(loadRewardModelQualificationReport({
        storeDir,
        id: report.id,
        contentHash: report.contentHash,
      })).resolves.toEqual(report);
      await expect(loadRewardModelQualificationReport({
        storeDir,
        id: report.id,
        contentHash: "b".repeat(64),
      })).rejects.toThrow("identity mismatch");
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});
