import { describe, expect, it } from "vitest";

import { contentHash } from "@openpond/harness";

import {
  createPreferenceDatasetRelease,
  createRewardModelQualificationReport,
  verifyPreferenceDatasetRelease,
  verifyRewardModelQualificationReport,
} from "../src/index.js";

const NOW = "2026-08-25T12:00:00.000Z";
const ref = (id: string) => ({ id, contentHash: contentHash(id) });

describe("learned preference releases", () => {
  it("preserves group evidence and constrains synthetic datasets to smoke scope", () => {
    const attempts = [ref("attempt-a"), ref("attempt-b")];
    const release = createPreferenceDatasetRelease({
      schemaVersion: "openpond.preferenceDatasetRelease.v1",
      id: "synthetic-preference-dataset",
      revision: 1,
      tasksetRelease: ref("taskset-v1"),
      comparisonRelease: ref("comparison-v1"),
      authority: "synthetic_fixture",
      qualificationEligibility: "smoke_only",
      fixtureRelease: ref("layered-artifact-fixture-v1"),
      groups: [{
        id: "group-one",
        assignmentRef: ref("assignment-one"),
        scenarioRef: ref("scenario-one"),
        scenarioSplit: "train",
        preferenceResultRef: ref("fixture-receipt-one"),
        receiptRefs: [ref("fixture-receipt-one")],
        attemptRefs: attempts,
        artifactManifestRefs: [ref("manifest-a"), ref("manifest-b")],
        orderedBuckets: [[attempts[0]!.id], [attempts[1]!.id]],
        rejectAll: false,
        partition: "reward_train",
        metadata: {},
      }],
      derivedPairs: [{
        groupId: "group-one",
        preferredAttemptRef: attempts[0]!,
        dispreferredAttemptRef: attempts[1]!,
        relation: "preferred",
      }],
      createdAt: NOW,
      metadata: {},
    });

    expect(verifyPreferenceDatasetRelease(release)).toBe(true);
    const { contentHash: _contentHash, ...releaseContent } = release;
    expect(() => createPreferenceDatasetRelease({
      ...releaseContent,
      qualificationEligibility: "human_heldout",
    })).toThrow("smoke-only");
  });

  it("allows a synthetic smoke report but never grants production reward eligibility", () => {
    const base = {
      schemaVersion: "openpond.rewardModelQualificationReport.v1" as const,
      id: "reward-model-smoke-report",
      kind: "synthetic_smoke" as const,
      rewardModelVersion: ref("reward-model-r0"),
      preferenceDatasetRelease: ref("synthetic-preference-dataset"),
      tasksetRelease: ref("taskset-v1"),
      processorRelease: ref("processor-v1"),
      metrics: {
        sampleCount: 8,
        finiteScoreRate: 1,
        scoreVariance: 0.1,
        checkpointReloadPassed: true,
        processorCompatibilityPassed: true,
        invalidAttemptExclusionPassed: true,
        orderedPairAccuracy: 1,
        bucketAccuracy: 1,
        tieAgreement: 1,
      },
      passed: true,
      productionRewardEligible: false,
      createdAt: NOW,
      metadata: {},
    };
    const report = createRewardModelQualificationReport(base);

    expect(verifyRewardModelQualificationReport(report)).toBe(true);
    expect(() => createRewardModelQualificationReport({
      ...base,
      productionRewardEligible: true,
    })).toThrow("can never grant production reward eligibility");
  });

  it("requires human-heldout eligibility to match its frozen pass result", () => {
    expect(() => createRewardModelQualificationReport({
      schemaVersion: "openpond.rewardModelQualificationReport.v1",
      id: "human-heldout-mismatch",
      kind: "human_heldout",
      rewardModelVersion: ref("reward-model-r1"),
      preferenceDatasetRelease: ref("human-preference-dataset"),
      tasksetRelease: ref("taskset-v1"),
      processorRelease: ref("processor-v1"),
      metrics: {
        sampleCount: 100,
        finiteScoreRate: 1,
        scoreVariance: 0.2,
        checkpointReloadPassed: true,
        processorCompatibilityPassed: true,
        invalidAttemptExclusionPassed: true,
        orderedPairAccuracy: 0.9,
        bucketAccuracy: 0.8,
        tieAgreement: 0.7,
      },
      passed: false,
      productionRewardEligible: true,
      createdAt: NOW,
      metadata: {},
    })).toThrow("must match");
  });
});
