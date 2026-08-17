import { describe, expect, it } from "vitest";

import { contentHash } from "@openpond/harness";

import {
  bindTasksetExecutionReleases,
  buildArtifactManifest,
  classifyAttemptOutcome,
  createEnvironmentRelease,
  createRewardReceipt,
  createVerifierSetRelease,
  regradeRewardReceipt,
  verifyArtifactManifest,
  verifyRequiredOutputs,
  verifyRewardReceipt,
} from "../src/index.js";
import { genericToolConformance } from "../src/conformance.js";

const NOW = "2026-08-17T12:00:00.000Z";
const ATTEMPT_REF = { id: "attempt-local-1", contentHash: contentHash("attempt-local-1") };
const ARTIFACT = {
  id: "artifact-index-html",
  contentHash: contentHash("<html><body>ok</body></html>"),
  mediaType: "text/html",
  sizeBytes: 28,
};

function executionReleases() {
  const environment = createEnvironmentRelease({
    schemaVersion: "openpond.environmentRelease.v1",
    id: "environment-local-work-v1",
    revision: 1,
    contract: genericToolConformance.taskset.environment,
    actionSchemaRef: null,
    observationSchemaRef: null,
    stateSchemaRef: null,
    artifactCollection: { maxArtifacts: 100, maxTotalBytes: 10_000_000 },
    adapterConformanceHashes: { local: contentHash("local-adapter-v1") },
    metadata: {},
  });
  const verifierSet = createVerifierSetRelease({
    schemaVersion: "openpond.verifierSetRelease.v1",
    id: "verifier-set-local-v1",
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
  return { environment, verifierSet };
}

function requiredOutput() {
  return {
    path: "index.html",
    mediaType: "text/html",
    schemaRef: null,
    maxBytes: 1_000,
    metadata: {},
  } as const;
}

function manifestWithArtifact() {
  return buildArtifactManifest({
    id: "manifest-local-1",
    attemptRef: ATTEMPT_REF,
    requiredOutputs: [requiredOutput()],
    collectedArtifacts: [{
      path: "index.html",
      artifact: ARTIFACT,
      detectedMediaType: "text/html",
      status: "collected",
      parseStatus: "passed",
    }],
    createdAt: NOW,
  });
}

describe("canonical execution receipts", () => {
  it("binds matching Environment and Verifier releases to a Taskset release", () => {
    const { environment, verifierSet } = executionReleases();
    const bound = bindTasksetExecutionReleases({
      taskset: genericToolConformance.taskset,
      environment,
      verifierSet,
    });
    expect(bound.environmentRelease).toEqual({ id: environment.id, contentHash: environment.contentHash });
    expect(bound.verifierSetRelease).toEqual({ id: verifierSet.id, contentHash: verifierSet.contentHash });
    expect(bound.contentHash).not.toBe(genericToolConformance.taskset.contentHash);
  });

  it("records a trusted hard-gate failure as an eligible zero reward", () => {
    const { verifierSet } = executionReleases();
    const manifest = manifestWithArtifact();
    const [component] = verifyRequiredOutputs({
      requiredOutputs: [{ ...requiredOutput(), mediaType: "application/pdf" }],
      manifest,
    });
    const receipt = createRewardReceipt({
      id: "reward-policy-failure",
      attemptRef: ATTEMPT_REF,
      verifierSet,
      artifactManifest: manifest,
      outcomeClass: "policy_failure",
      failureOwner: "policy",
      components: [component!],
      createdAt: NOW,
    });
    expect(receipt).toMatchObject({
      status: "scored",
      reward: 0,
      learningEligible: true,
      passed: false,
      outcomeClass: "policy_failure",
      failureOwner: "policy",
    });
    expect(verifyRewardReceipt(receipt)).toBe(true);
  });

  it("distinguishes a scored task deadline from an unscorable infrastructure timeout", () => {
    const { verifierSet } = executionReleases();
    const manifest = manifestWithArtifact();
    const [component] = verifyRequiredOutputs({ requiredOutputs: [requiredOutput()], manifest });
    const taskDeadline = classifyAttemptOutcome({ failureClass: "timeout", timeoutKind: "task_deadline" });
    const hostTimeout = classifyAttemptOutcome({ failureClass: "timeout", timeoutKind: "infrastructure_timeout" });
    const scored = createRewardReceipt({
      id: "reward-task-deadline",
      attemptRef: ATTEMPT_REF,
      verifierSet,
      artifactManifest: manifest,
      ...taskDeadline,
      components: [{ ...component!, normalizedScore: 0, rawScore: 0, passed: false }],
      createdAt: NOW,
    });
    const unscorable = createRewardReceipt({
      id: "reward-host-timeout",
      attemptRef: ATTEMPT_REF,
      verifierSet,
      artifactManifest: manifest,
      ...hostTimeout,
      components: [component!],
      createdAt: NOW,
    });
    expect(scored).toMatchObject({ status: "scored", reward: 0, learningEligible: true });
    expect(unscorable).toMatchObject({ status: "unscorable", reward: null, learningEligible: false });
  });

  it.each([
    ["environment_failure", "environment"],
    ["collector_failure", "collector"],
    ["verifier_failure", "verifier"],
    ["provider_failure", "provider"],
    ["host_failure", "host"],
    ["cancelled", "user"],
  ] as const)("marks %s as unscorable", (outcomeClass, failureOwner) => {
    const { verifierSet } = executionReleases();
    const manifest = manifestWithArtifact();
    const [component] = verifyRequiredOutputs({ requiredOutputs: [requiredOutput()], manifest });
    const receipt = createRewardReceipt({
      id: `reward-${outcomeClass}`,
      attemptRef: ATTEMPT_REF,
      verifierSet,
      artifactManifest: manifest,
      outcomeClass,
      failureOwner,
      components: [component!],
      createdAt: NOW,
    });
    expect(receipt).toMatchObject({ status: "unscorable", reward: null, learningEligible: false });
  });

  it("preserves missing output as policy evidence and collector ambiguity as unscorable", () => {
    const missing = buildArtifactManifest({
      id: "manifest-missing",
      attemptRef: ATTEMPT_REF,
      requiredOutputs: [requiredOutput()],
      collectedArtifacts: [],
      createdAt: NOW,
    });
    const ambiguous = buildArtifactManifest({
      id: "manifest-ambiguous",
      attemptRef: ATTEMPT_REF,
      requiredOutputs: [requiredOutput()],
      collectedArtifacts: [
        { path: "index.html", artifact: ARTIFACT, detectedMediaType: "text/html", status: "collected" },
        { path: "index.html", artifact: { ...ARTIFACT, id: "artifact-duplicate" }, detectedMediaType: "text/html", status: "collected" },
      ],
      createdAt: NOW,
    });
    expect(verifyArtifactManifest(missing)).toBe(true);
    expect(verifyRequiredOutputs({ requiredOutputs: [requiredOutput()], manifest: missing })[0]).toMatchObject({
      status: "scored",
      normalizedScore: 0,
      rewardEligible: true,
      failureOwner: "policy",
    });
    expect(verifyRequiredOutputs({ requiredOutputs: [requiredOutput()], manifest: ambiguous })[0]).toMatchObject({
      status: "unscorable",
      normalizedScore: null,
      rewardEligible: false,
      failureOwner: "collector",
    });
  });

  it("appends a hash-bound regrade without mutating the original receipt", () => {
    const { verifierSet } = executionReleases();
    const manifest = manifestWithArtifact();
    const [component] = verifyRequiredOutputs({ requiredOutputs: [requiredOutput()], manifest });
    const original = createRewardReceipt({
      id: "reward-original",
      attemptRef: ATTEMPT_REF,
      verifierSet,
      artifactManifest: manifest,
      outcomeClass: "completed",
      failureOwner: null,
      components: [component!],
      createdAt: NOW,
    });
    const originalSnapshot = structuredClone(original);
    const regraded = regradeRewardReceipt({
      original,
      id: "reward-regraded",
      verifierSet,
      artifactManifest: manifest,
      components: [{ ...component!, rawScore: 0, normalizedScore: 0, passed: false }],
      outcomeClass: "policy_failure",
      failureOwner: "policy",
      createdAt: "2026-08-17T12:01:00.000Z",
    });
    expect(original).toEqual(originalSnapshot);
    expect(regraded.supersedes).toEqual({ id: original.id, contentHash: original.contentHash });
    expect(regraded).toMatchObject({ reward: 0, outcomeClass: "policy_failure" });
    expect(verifyRewardReceipt(regraded)).toBe(true);
  });
});
