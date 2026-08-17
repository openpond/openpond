import { describe, expect, it } from "vitest";

import { contentHash } from "@openpond/harness";

import {
  buildArtifactManifest,
  createAttemptReceipt,
  createCanonicalRolloutRecord,
  createEnvironmentRelease,
  createRewardReceipt,
  createVerifierSetRelease,
  optimizerEligibleRollouts,
  qualifyRolloutBatch,
  verifyCanonicalRolloutRecord,
  verifyRequiredOutputs,
  type RewardReceipt,
} from "../src/index.js";
import { genericToolConformance } from "../src/conformance.js";

const NOW = "2026-08-17T12:00:00.000Z";
const TASK_ID = genericToolConformance.taskset.tasks[0]!.id;

function fixture(score: 0 | 1 | null, ordinal: number) {
  const environment = createEnvironmentRelease({
    schemaVersion: "openpond.environmentRelease.v1",
    id: "environment-local-rollout-v1",
    revision: 1,
    contract: genericToolConformance.taskset.environment,
    actionSchemaRef: null,
    observationSchemaRef: null,
    stateSchemaRef: null,
    artifactCollection: { maxArtifacts: 100, maxTotalBytes: 1_000_000 },
    adapterConformanceHashes: { local: contentHash("local-rollout-adapter-v1") },
    metadata: {},
  });
  const verifierSet = createVerifierSetRelease({
    schemaVersion: "openpond.verifierSetRelease.v1",
    id: "verifier-local-rollout-v1",
    revision: 1,
    graders: genericToolConformance.taskset.graders,
    isolation: {
      processBoundary: "isolated_process",
      networkPolicy: "none",
      defaultTimeoutMs: 10_000,
    },
    calibrationReceiptRefs: [],
    metadata: {},
  });
  const attemptReceipt = createAttemptReceipt({
    schemaVersion: "openpond.attemptReceipt.v1",
    id: `attempt-rollout-${ordinal}`,
    runManifest: { id: "run-local-rollout", contentHash: contentHash("run-local-rollout") },
    taskId: TASK_ID,
    seed: String(ordinal),
    terminal: score !== null,
    failureClass: score === null ? "infrastructure_failure" : score === 0 ? "policy_failure" : null,
    outputHash: score === null ? null : contentHash(`output-${ordinal}`),
    traceHash: contentHash(`trace-${ordinal}`),
    artifactRefs: [],
    graderEvidenceRefs: [],
    startedAt: NOW,
    completedAt: NOW,
    latencyMs: 0,
    costUsd: 0,
    legacyAttemptRef: null,
    metadata: {},
  });
  const manifest = buildArtifactManifest({
    id: `artifact-manifest-rollout-${ordinal}`,
    attemptRef: { id: attemptReceipt.id, contentHash: attemptReceipt.contentHash },
    requiredOutputs: [{
      path: "index.html",
      mediaType: "text/html",
      schemaRef: null,
      maxBytes: 1_000,
      metadata: {},
    }],
    collectedArtifacts: [{
      path: "index.html",
      artifact: {
        id: `artifact-index-${ordinal}`,
        contentHash: contentHash(`<html>${ordinal}</html>`),
        mediaType: "text/html",
        sizeBytes: 14,
      },
      detectedMediaType: "text/html",
      status: "collected",
      parseStatus: "passed",
    }],
    createdAt: NOW,
  });
  const [verified] = verifyRequiredOutputs({
    requiredOutputs: [{
      path: "index.html",
      mediaType: "text/html",
      schemaRef: null,
      maxBytes: 1_000,
      metadata: {},
    }],
    manifest,
  });
  const rewardReceipt = createRewardReceipt({
    id: `reward-rollout-${ordinal}`,
    attemptRef: { id: attemptReceipt.id, contentHash: attemptReceipt.contentHash },
    verifierSet,
    artifactManifest: manifest,
    outcomeClass: score === null ? "provider_failure" : score === 0 ? "policy_failure" : "completed",
    failureOwner: score === null ? "provider" : score === 0 ? "policy" : null,
    components: [{
      ...verified!,
      rawScore: score ?? verified!.rawScore,
      normalizedScore: score ?? verified!.normalizedScore,
      passed: score === null ? verified!.passed : score === 1,
    }],
    createdAt: NOW,
  });
  return { environment, verifierSet, attemptReceipt, manifest, rewardReceipt };
}

function rollout(score: 0 | 1 | null, ordinal: number, optimizer = true) {
  const evidence = fixture(score, ordinal);
  return createCanonicalRolloutRecord({
    id: `rollout-local-${ordinal}`,
    attemptReceipt: evidence.attemptReceipt,
    rewardReceipt: evidence.rewardReceipt,
    artifactManifestRef: {
      id: evidence.manifest.id,
      contentHash: evidence.manifest.contentHash,
    },
    tasksetRelease: {
      id: genericToolConformance.taskset.id,
      contentHash: genericToolConformance.taskset.contentHash,
    },
    environmentRelease: {
      id: evidence.environment.id,
      contentHash: evidence.environment.contentHash,
    },
    harnessRelease: { id: "harness-local-v1", contentHash: contentHash("harness-local-v1") },
    taskId: TASK_ID,
    split: "train",
    model: {
      provider: "local-fixture",
      model: "policy-v1",
      revision: "1",
      artifactHash: contentHash("policy-v1"),
      tokenizerRevision: "tokenizer-v1",
      chatTemplateHash: contentHash("chat-template-v1"),
    },
    seed: String(ordinal),
    traceRef: {
      id: `trace-local-${ordinal}`,
      contentHash: contentHash(`trace-local-${ordinal}`),
      mediaType: "application/json",
      sizeBytes: 100,
    },
    optimizerSample: optimizer ? {
      schemaVersion: "openpond.optimizerTrainingSample.v1",
      tokenIds: [10, 11, 12, 13],
      mask: [false, false, true, true],
      logprobs: [-0.1, -0.1, -0.2, -0.2],
      temperatures: [0.8, 0.8, 0.8, 0.8],
      envName: "local-fixture",
      modelRequestId: `request-${ordinal}`,
      promptTokenCount: 2,
      completionTokenCount: 2,
      servedPolicyVersion: 1,
    } : null,
    environmentExecutions: [{
      id: `environment-execution-${ordinal}`,
      environmentRelease: {
        id: evidence.environment.id,
        contentHash: evidence.environment.contentHash,
      },
      status: score === null ? "failed" : "completed",
      startedAt: NOW,
      completedAt: NOW,
      traceRefs: [],
      metadata: {},
    }],
    startedAt: NOW,
    completedAt: NOW,
  });
}

describe("canonical local rollout bridge", () => {
  it("exports a hash-bound rollout locally without invoking a provider", () => {
    const record = rollout(0, 1);
    expect(record).toMatchObject({
      schemaVersion: "openpond.canonicalRolloutRecord.v1",
      reward: { status: "scored", value: 0, learningEligible: true },
      optimizerSample: { modelRequestId: "request-1" },
    });
    expect(verifyCanonicalRolloutRecord(record)).toBe(true);
  });

  it("includes scored zero rewards and excludes only unscorable attempts", () => {
    const records = [rollout(0, 1), rollout(1, 2), rollout(null, 3)];
    expect(optimizerEligibleRollouts(records).map((record) => record.reward.value)).toEqual([0, 1]);
    expect(qualifyRolloutBatch({ records })).toMatchObject({
      rolloutCount: 3,
      scoredCount: 2,
      optimizerEligibleCount: 2,
      unscorableCount: 1,
      zeroRewardCount: 1,
      rewardMean: 0.5,
      rewardVariance: 0.25,
      eligibleForRl: true,
      reasons: [],
    });
  });

  it("rejects RL qualification without variance or aligned optimizer evidence", () => {
    const constant = qualifyRolloutBatch({ records: [rollout(1, 1), rollout(1, 2)] });
    expect(constant.eligibleForRl).toBe(false);
    expect(constant.reasons.join(" ")).toContain("distinct reward");
    expect(constant.reasons.join(" ")).toContain("variance");

    const missingTokens = qualifyRolloutBatch({
      records: [rollout(0, 3, false), rollout(1, 4)],
    });
    expect(missingTokens).toMatchObject({
      scoredCount: 2,
      optimizerEligibleCount: 1,
      eligibleForRl: false,
    });
    expect(missingTokens.reasons.join(" ")).toContain("optimizer token evidence");
  });

  it("refuses to bind a Reward Receipt to the wrong Attempt", () => {
    const first = fixture(1, 1);
    const second = fixture(1, 2);
    expect(() => createCanonicalRolloutRecord({
      id: "rollout-mismatched-attempt",
      attemptReceipt: first.attemptReceipt,
      rewardReceipt: second.rewardReceipt as RewardReceipt,
      artifactManifestRef: {
        id: second.manifest.id,
        contentHash: second.manifest.contentHash,
      },
      tasksetRelease: {
        id: genericToolConformance.taskset.id,
        contentHash: genericToolConformance.taskset.contentHash,
      },
      environmentRelease: {
        id: second.environment.id,
        contentHash: second.environment.contentHash,
      },
      harnessRelease: { id: "harness-local-v1", contentHash: contentHash("harness-local-v1") },
      taskId: TASK_ID,
      split: "train",
      model: { provider: "local", model: "fixture" },
      seed: "1",
      traceRef: {
        id: "trace-mismatch",
        contentHash: contentHash("trace-mismatch"),
        mediaType: "application/json",
        sizeBytes: null,
      },
      optimizerSample: null,
      environmentExecutions: [{
        id: "environment-execution-mismatch",
        environmentRelease: {
          id: second.environment.id,
          contentHash: second.environment.contentHash,
        },
        status: "completed",
        startedAt: NOW,
        completedAt: NOW,
        traceRefs: [],
        metadata: {},
      }],
      startedAt: NOW,
      completedAt: NOW,
    })).toThrow("does not match its Reward Receipt");
  });
});
