import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPreferenceComparisonRelease,
} from "@openpond/evals";
import { genericToolConformance } from "@openpond/evals/conformance";
import { contentHash } from "@openpond/harness";

import { SqliteStore } from "../store/store.js";

const NOW = "2026-08-24T12:00:00.000Z";

describe("preference comparison persistence", () => {
  it("persists a portable release and fail-closes assignment creation after consent revocation", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-preference-comparison-"));
    const store = new SqliteStore(storeDir);
    const release = createPreferenceComparisonRelease({
      schemaVersion: "openpond.preferenceComparisonRelease.v1",
      id: "preference-store-release",
      revision: 1,
      tasksetRelease: {
        id: genericToolConformance.taskset.id,
        contentHash: genericToolConformance.taskset.contentHash,
      },
      candidateCount: 2,
      resultMode: "ordered_tie_groups",
      allowTies: true,
      allowRejectAll: true,
      presentation: {
        showTaskPrompt: true,
        randomizeCandidateOrder: true,
        hideModelIdentity: true,
        parts: [{ source: "attempt_output", path: "/text", renderer: "markdown" }],
      },
      rubricRef: {
        id: "preference-store-rubric",
        contentHash: contentHash("rubric"),
        mediaType: "text/markdown",
        sizeBytes: 6,
      },
      criteria: [],
      assignment: { strategy: "randomized_blinded_v1", maxAssignmentsPerCandidate: 10 },
      aggregation: { algorithm: "mean_pairwise_win_fraction_v1", quorum: 1, rejectAllThreshold: 1 },
      rewardProjection: { algorithm: "pairwise_win_fraction_v1", verifierId: "preference-judge", verifierVersion: "1", weight: 1 },
      calibration: { minimumSamples: 1, minimumOrderAgreement: 0.8, minimumTieAgreement: 0.8, minimumOrderSwapAgreement: 0.8 },
      metadata: {},
    });
    try {
      const saved = await store.savePreferenceComparisonRelease({
        schemaVersion: "openpond.preferenceComparisonReleaseRecord.v1",
        id: release.id,
        tasksetId: "taskset-local",
        tasksetRelease: genericToolConformance.taskset,
        release,
        publishedBy: "publisher-local",
        sourceConsent: "authorized",
        retentionUntil: null,
        createdAt: NOW,
      });
      expect(saved.release.contentHash).toBe(release.contentHash);
      expect((await store.listPreferenceComparisonReleases("taskset-local"))).toHaveLength(1);

      const revoked = await store.revokePreferenceComparisonRelease({
        id: release.id,
        retentionUntil: "2026-09-24T12:00:00.000Z",
      });
      expect(revoked.sourceConsent).toBe("revoked");
      await expect(store.savePreferenceComparisonRelease({
        ...saved,
        sourceConsent: "authorized",
      })).rejects.toThrow("cannot be restored");
    } finally {
      await store.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});
