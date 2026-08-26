import { describe, expect, it } from "vitest";

import { contentHash } from "@openpond/harness";

import {
  bindTasksetExecutionReleases,
  createArtifactManifest,
  createAttemptReceipt,
  createComparisonAssignment,
  createEnvironmentRelease,
  createHarnessCompatibilityReceipt,
  createPreferenceCalibrationReport,
  createPreferenceComparisonRelease,
  createPreferenceReceipt,
  createPreferenceRewardComponents,
  materializePreferenceDatasetRelease,
  createRunManifest,
  createVerifierSetRelease,
  aggregatePreferenceReceipts,
  projectPairwiseWinFraction,
  verifyComparisonAssignment,
  verifyPreferenceAggregationReceipt,
  verifyPreferenceCalibrationReport,
  verifyPreferenceComparisonRelease,
  verifyPreferenceReceipt,
} from "../src/index.js";
import { genericToolConformance } from "../src/conformance.js";

const NOW = "2026-08-24T12:00:00.000Z";
const REVIEWER = { id: "fixture-human-reviewer-v1", contentHash: contentHash("fixture-human-reviewer-v1") };
const JUDGE = { id: "fixture-vision-judge-v1", contentHash: contentHash("fixture-vision-judge-v1") };

describe("preference comparison contracts", () => {
  it("records a four-candidate ranking with ties and projects normalized pairwise rewards", () => {
    const fixture = comparisonFixture(4);
    const receipt = humanReceipt(fixture, "human-tied", [[fixture.ids[0]!], [fixture.ids[1]!, fixture.ids[2]!], [fixture.ids[3]!]]);

    expect(verifyPreferenceComparisonRelease(fixture.release)).toBe(true);
    expect(verifyComparisonAssignment(fixture.assignment)).toBe(true);
    expect(verifyPreferenceReceipt(receipt)).toBe(true);
    expect(projectPairwiseWinFraction({ assignment: fixture.assignment, comparisonRelease: fixture.release, result: receipt })).toEqual({
      [fixture.ids[0]!]: 1,
      [fixture.ids[1]!]: 0.5,
      [fixture.ids[2]!]: 0.5,
      [fixture.ids[3]!]: 0,
    });
  });

  it("rejects incomplete orders, duplicate candidates, and unreviewable artifacts", () => {
    const fixture = comparisonFixture(2);
    expect(() => createPreferenceReceipt({
      id: "incomplete-order",
      assignment: fixture.assignment,
      comparisonRelease: fixture.release,
      reviewer: { kind: "human", releaseRef: REVIEWER },
      order: [[fixture.ids[0]!]],
      rejectAll: false,
      startedAt: NOW,
      completedAt: NOW,
    })).toThrow("rank every assignment candidate");

    const invalidCandidate = structuredClone(fixture.candidates[0]!);
    invalidCandidate.visibleArtifactIds = ["missing-artifact"];
    expect(() => createComparisonAssignment({
      id: "missing-artifact-assignment",
      comparisonRelease: fixture.release,
      taskset: fixture.taskset,
      candidates: [invalidCandidate, fixture.candidates[1]!],
      purpose: "validation",
      createdAt: NOW,
    })).toThrow("missing, uncollected, or unreviewable");
  });

  it("allows structured-output comparisons without artifacts", () => {
    const fixture = comparisonFixture(2, { presentation: "attempt_output" });
    const candidates = fixture.candidates.map((entry) => ({
      ...entry,
      visibleArtifactIds: [],
    }));

    const assignment = createComparisonAssignment({
      id: "structured-output-assignment",
      comparisonRelease: fixture.release,
      taskset: fixture.taskset,
      candidates,
      purpose: "validation",
      createdAt: NOW,
    });

    expect(assignment.candidates.every((candidate) => candidate.visibleArtifactIds.length === 0)).toBe(true);
  });

  it("requires artifacts when the comparison presentation includes them", () => {
    const fixture = comparisonFixture(2);
    const candidateWithoutArtifact = {
      ...fixture.candidates[0]!,
      visibleArtifactIds: [],
    };

    expect(() => createComparisonAssignment({
      id: "artifact-required-assignment",
      comparisonRelease: fixture.release,
      taskset: fixture.taskset,
      candidates: [candidateWithoutArtifact, fixture.candidates[1]!],
      purpose: "validation",
      createdAt: NOW,
    })).toThrow("requires each candidate to expose a reviewable artifact");
  });

  it("keeps reject-all distinct from an ordinary low-quality loss", () => {
    const fixture = comparisonFixture(2);
    const receipt = humanReceipt(fixture, "human-reject-all", [], true);
    const scores = projectPairwiseWinFraction({
      assignment: fixture.assignment,
      comparisonRelease: fixture.release,
      result: receipt,
    });
    expect(scores).toEqual({ [fixture.ids[0]!]: 0, [fixture.ids[1]!]: 0 });
  });

  it("aggregates multiple votes with the release quorum and retains immutable receipt lineage", () => {
    const fixture = comparisonFixture(2, { quorum: 2 });
    const first = humanReceipt(fixture, "human-vote-first", [[fixture.ids[0]!], [fixture.ids[1]!]]);
    const second = humanReceipt(fixture, "human-vote-second", [[fixture.ids[0]!], [fixture.ids[1]!]]);
    const aggregate = aggregatePreferenceReceipts({
      id: "aggregate-two-votes",
      assignment: fixture.assignment,
      comparisonRelease: fixture.release,
      receipts: [first, second],
      createdAt: NOW,
    });
    expect(aggregate).toMatchObject({
      order: [[fixture.ids[0]!], [fixture.ids[1]!]],
      pairwiseWinFractions: { [fixture.ids[0]!]: 1, [fixture.ids[1]!]: 0 },
    });
    expect(verifyPreferenceAggregationReceipt(aggregate)).toBe(true);
  });

  it("allows a frozen baseline-versus-candidate comparison only with explicit Harness compatibility", () => {
    const fixture = comparisonFixture(2, { purpose: "frozen_eval" });
    const { contentHash: _oldHash, ...runContent } = fixture.candidates[1]!.runManifest;
    const alternativeRun = createRunManifest({
      ...runContent,
      id: "preference-fixture-candidate-run",
      harnessRelease: { id: "preference-fixture-candidate-harness", contentHash: contentHash("candidate-harness") },
      model: { ...runContent.model, model: "candidate-model" },
    });
    const alternativeCandidate = candidate(
      "candidate-compatible",
      alternativeRun,
      fixture.taskset.tasks[0]!.id,
    );
    expect(() => createComparisonAssignment({
      id: "incompatible-baseline-candidate",
      comparisonRelease: fixture.release,
      taskset: fixture.taskset,
      candidates: [fixture.candidates[0]!, alternativeCandidate],
      purpose: "frozen_eval",
      createdAt: NOW,
    })).toThrow("compatibility receipt");

    const compatibility = createHarnessCompatibilityReceipt({
      schemaVersion: "openpond.harnessCompatibility.v1",
      id: "preference-fixture-harness-compatibility",
      baseHarnessRelease: fixture.candidates[0]!.runManifest.harnessRelease,
      candidateHarnessRelease: alternativeRun.harnessRelease,
      tasksetRelease: { id: fixture.taskset.id, contentHash: fixture.taskset.contentHash },
      environmentHash: contentHash(fixture.taskset.environment),
      toolContractHash: contentHash(fixture.taskset.tools),
      policyHash: contentHash(fixture.taskset.policy),
      graderInterfaceHash: contentHash("preference-fixture-grader-interface"),
      metadata: {},
    });
    const assignment = createComparisonAssignment({
      id: "compatible-baseline-candidate",
      comparisonRelease: fixture.release,
      taskset: fixture.taskset,
      candidates: [fixture.candidates[0]!, alternativeCandidate],
      harnessCompatibilityReceipts: [compatibility],
      purpose: "frozen_eval",
      createdAt: NOW,
    });
    expect(assignment.lineage.harnessReleases).toHaveLength(2);
    expect(assignment.lineage.runManifestRefs).toHaveLength(2);
  });

  it("requires held-out non-frozen human evidence to calibrate a model judge", () => {
    const fixture = comparisonFixture(2, { minimumSamples: 2 });
    const pairs = ["one", "two"].map((suffix) => {
      const human = humanReceipt(fixture, `human-calibration-${suffix}`, [[fixture.ids[0]!], [fixture.ids[1]!]]);
      const model = modelReceipt(fixture, `model-calibration-${suffix}`, [[fixture.ids[0]!], [fixture.ids[1]!]]);
      const swappedModel = modelReceipt(fixture, `model-calibration-swapped-${suffix}`, [[fixture.ids[0]!], [fixture.ids[1]!]]);
      return { assignment: fixture.assignment, human, model, swappedModel };
    });
    const report = createPreferenceCalibrationReport({
      id: "calibration-passed",
      comparisonRelease: fixture.release,
      pairs,
      createdAt: NOW,
    });
    expect(report).toMatchObject({ passed: true, orderAgreement: 1, tieAgreement: 1, orderSwapAgreement: 1 });
    expect(verifyPreferenceCalibrationReport(report)).toBe(true);

    const frozen = comparisonFixture(2, { purpose: "frozen_eval", minimumSamples: 1 });
    expect(() => createPreferenceCalibrationReport({
      id: "calibration-frozen",
      comparisonRelease: frozen.release,
      pairs: [{
        assignment: frozen.assignment,
        human: humanReceipt(frozen, "human-frozen", [[frozen.ids[0]!], [frozen.ids[1]!]]),
        model: modelReceipt(frozen, "model-frozen", [[frozen.ids[0]!], [frozen.ids[1]!]]),
      }],
      createdAt: NOW,
    })).toThrow("Frozen-evaluation");
  });

  it("makes uncalibrated model judgments and invalid attempts reward-ineligible without treating either as an aesthetic loss", () => {
    const fixture = comparisonFixture(2, { minimumSamples: 1 });
    const model = modelReceipt(fixture, "uncalibrated-model", [[fixture.ids[0]!], [fixture.ids[1]!]]);
    const uncalibrated = createPreferenceRewardComponents({
      assignment: fixture.assignment,
      comparisonRelease: fixture.release,
      result: model,
    });
    expect(uncalibrated[fixture.ids[0]!]).toMatchObject({ status: "unscorable", rewardEligible: false, failureOwner: "verifier" });

    const human = humanReceipt(fixture, "human-invalid-attempt", [[fixture.ids[0]!], [fixture.ids[1]!]]);
    const components = createPreferenceRewardComponents({
      assignment: fixture.assignment,
      comparisonRelease: fixture.release,
      result: human,
      candidates: [{ attemptRef: fixture.assignment.candidates[1]!.attemptRef, eligible: false, failureOwner: "collector" }],
    });
    expect(components[fixture.ids[0]!]).toMatchObject({ status: "scored", normalizedScore: 1, rewardEligible: true });
    expect(components[fixture.ids[1]!]).toMatchObject({ status: "unscorable", normalizedScore: null, rewardEligible: false, failureOwner: "collector" });
  });

  it("keeps synthetic fixture labels smoke-only and distinct from human qualification", () => {
    const fixture = comparisonFixture(2, { minimumSamples: 1 });
    const synthetic = createPreferenceReceipt({
      id: "synthetic-smoke-label",
      assignment: fixture.assignment,
      comparisonRelease: fixture.release,
      reviewer: {
        kind: "fixture",
        releaseRef: { id: "fixture-labeler-v1", contentHash: contentHash("fixture-labeler-v1") },
        fixtureRelease: { id: "artifact-fixture-v1", contentHash: contentHash("artifact-fixture-v1") },
        labelSource: "synthetic",
        qualificationEligibility: "smoke_only",
      },
      order: [[fixture.ids[0]!], [fixture.ids[1]!]],
      rejectAll: false,
      startedAt: NOW,
      completedAt: NOW,
    });

    expect(verifyPreferenceReceipt(synthetic)).toBe(true);
    expect(createPreferenceRewardComponents({
      assignment: fixture.assignment,
      comparisonRelease: fixture.release,
      result: synthetic,
    })[fixture.ids[0]!]).toMatchObject({
      status: "unscorable",
      rewardEligible: false,
    });
    expect(createPreferenceRewardComponents({
      assignment: fixture.assignment,
      comparisonRelease: fixture.release,
      result: synthetic,
      rewardScope: "synthetic_smoke",
    })[fixture.ids[0]!]).toMatchObject({
      status: "scored",
      rewardEligible: true,
      normalizedScore: 1,
    });

    const model = modelReceipt(fixture, "model-against-fixture", [[fixture.ids[0]!], [fixture.ids[1]!]]);
    expect(() => createPreferenceCalibrationReport({
      id: "fixture-cannot-qualify-model",
      comparisonRelease: fixture.release,
      pairs: [{ assignment: fixture.assignment, human: synthetic, model }],
      createdAt: NOW,
    })).toThrow("one human and one automated model receipt");
  });

  it("materializes fixture receipts as group-preserving smoke-only dataset evidence", () => {
    const fixture = comparisonFixture(4);
    const receipt = createPreferenceReceipt({
      id: "synthetic-dataset-label",
      assignment: fixture.assignment,
      comparisonRelease: fixture.release,
      reviewer: {
        kind: "fixture",
        releaseRef: { id: "fixture-labeler-v1", contentHash: contentHash("fixture-labeler-v1") },
        fixtureRelease: { id: "artifact-fixture-v1", contentHash: contentHash("artifact-fixture-v1") },
        labelSource: "synthetic",
        qualificationEligibility: "smoke_only",
      },
      order: [[fixture.ids[0]!], [fixture.ids[1]!, fixture.ids[2]!], [fixture.ids[3]!]],
      rejectAll: false,
      startedAt: NOW,
      completedAt: NOW,
    });
    const release = materializePreferenceDatasetRelease({
      id: "fixture-preference-dataset-v1",
      revision: 1,
      tasksetRelease: fixture.taskset,
      comparisonRelease: fixture.release,
      authority: "synthetic_fixture",
      groups: [{ assignment: fixture.assignment, receipt, partition: "reward_train" }],
      createdAt: NOW,
    });

    expect(release).toMatchObject({
      authority: "synthetic_fixture",
      qualificationEligibility: "smoke_only",
      fixtureRelease: receipt.reviewer.kind === "fixture" ? receipt.reviewer.fixtureRelease : null,
    });
    expect(release.groups[0]?.attemptRefs).toHaveLength(4);
    expect(release.groups[0]?.artifactManifestRefs).toHaveLength(4);
    expect(release.derivedPairs).toHaveLength(6);
    expect(new Set(release.derivedPairs.map((pair) => pair.groupId))).toEqual(
      new Set([release.groups[0]!.id]),
    );
  });
});

function comparisonFixture(
  count: 2 | 4,
  options: {
    quorum?: number;
    purpose?: "calibration" | "training_reward" | "validation" | "frozen_eval";
    minimumSamples?: number;
    presentation?: "artifact" | "attempt_output";
  } = {},
) {
  const environment = createEnvironmentRelease({
    schemaVersion: "openpond.environmentRelease.v1",
    id: "preference-fixture-environment",
    revision: 1,
    contract: genericToolConformance.taskset.environment,
    actionSchemaRef: null,
    observationSchemaRef: null,
    stateSchemaRef: null,
    artifactCollection: { maxArtifacts: 100, maxTotalBytes: 1_000_000 },
    adapterConformanceHashes: { local: contentHash("preference-fixture-runtime") },
    metadata: {},
  });
  const verifierSet = createVerifierSetRelease({
    schemaVersion: "openpond.verifierSetRelease.v1",
    id: "preference-fixture-verifier-set",
    revision: 1,
    graders: genericToolConformance.taskset.graders,
    isolation: { processBoundary: "isolated_process", networkPolicy: "none", defaultTimeoutMs: 1_000 },
    calibrationReceiptRefs: [],
    metadata: {},
  });
  const taskset = bindTasksetExecutionReleases({
    taskset: genericToolConformance.taskset,
    environment,
    verifierSet,
  });
  const runManifest = createRunManifest({
    schemaVersion: "openpond.runManifest.v1",
    id: `preference-fixture-run-${count}`,
    harnessRelease: genericToolConformance.manifest.harnessRelease,
    tasksetRelease: { id: taskset.id, contentHash: taskset.contentHash },
    model: genericToolConformance.manifest.model,
    runtimeTarget: genericToolConformance.manifest.runtimeTarget,
    limits: genericToolConformance.manifest.limits,
    approval: null,
    createdAt: NOW,
    metadata: {},
  });
  const release = createPreferenceComparisonRelease({
    schemaVersion: "openpond.preferenceComparisonRelease.v1",
    id: `preference-fixture-release-${count}-${options.quorum ?? 1}-${options.minimumSamples ?? 1}`,
    revision: 1,
    tasksetRelease: { id: taskset.id, contentHash: taskset.contentHash },
    candidateCount: count,
    resultMode: "ordered_tie_groups",
    allowTies: true,
    allowRejectAll: true,
    presentation: {
      showTaskPrompt: true,
      randomizeCandidateOrder: true,
      hideModelIdentity: true,
      parts: options.presentation === "attempt_output"
        ? [{ source: "attempt_output", path: "/text", renderer: "markdown" }]
        : [{ source: "artifact", path: "candidate.png", renderer: "image" }, { source: "attempt_output", path: "/text", renderer: "markdown" }],
    },
    rubricRef: { id: "preference-fixture-rubric", contentHash: contentHash("rubric"), mediaType: "text/markdown", sizeBytes: 6 },
    criteria: [{ id: "visual-quality", label: "Visual quality", instruction: "Prefer the clearest and most cohesive result.", weight: 1 }],
    assignment: { strategy: "randomized_blinded_v1", maxAssignmentsPerCandidate: 10 },
    aggregation: { algorithm: "mean_pairwise_win_fraction_v1", quorum: options.quorum ?? 1, rejectAllThreshold: 1 },
    rewardProjection: { algorithm: "pairwise_win_fraction_v1", verifierId: "preference-judge", verifierVersion: "1", weight: 1 },
    calibration: { minimumSamples: options.minimumSamples ?? 1, minimumOrderAgreement: 0.8, minimumTieAgreement: 0.8, minimumOrderSwapAgreement: 0.8 },
    metadata: {},
  });
  const candidates = Array.from({ length: count }, (_, index) => candidate(`candidate-${count}-${index + 1}`, runManifest, taskset.tasks[0]!.id));
  const assignment = createComparisonAssignment({
    id: `preference-fixture-assignment-${count}`,
    comparisonRelease: release,
    taskset,
    candidates,
    purpose: options.purpose ?? "validation",
    presentedCandidateOrder: candidates.map((entry) => entry.attempt.id).reverse(),
    createdAt: NOW,
  });
  return { release, taskset, assignment, candidates, ids: candidates.map((entry) => entry.attempt.id) };
}

function candidate(id: string, runManifest: ReturnType<typeof createRunManifest>, taskId: string) {
  const artifact = { id: `${id}-artifact`, contentHash: contentHash(`${id}-image`), mediaType: "image/png", sizeBytes: 10 };
  const attempt = createAttemptReceipt({
    schemaVersion: "openpond.attemptReceipt.v1",
    id,
    runManifest: { id: runManifest.id, contentHash: runManifest.contentHash },
    taskId,
    seed: id,
    terminal: true,
    failureClass: null,
    outputHash: contentHash(`${id}-output`),
    traceHash: contentHash(`${id}-trace`),
    artifactRefs: [artifact],
    graderEvidenceRefs: [],
    startedAt: NOW,
    completedAt: NOW,
    latencyMs: 1,
    costUsd: 0,
    metadata: {},
  });
  const artifactManifest = createArtifactManifest({
    schemaVersion: "openpond.artifactManifest.v1",
    id: `${id}-manifest`,
    attemptRef: { id: attempt.id, contentHash: attempt.contentHash },
    entries: [{
      requiredOutputPath: "candidate.png",
      collectedPath: "candidate.png",
      declaredMediaType: "image/png",
      detectedMediaType: "image/png",
      artifact,
      status: "collected",
      parseStatus: "passed",
      schemaStatus: "not_requested",
      errorCode: null,
      failureOwner: null,
      evidenceRefs: [],
      metadata: {},
    }],
    createdAt: NOW,
    metadata: {},
  });
  return { attempt, artifactManifest, runManifest, visibleArtifactIds: [artifact.id] };
}

function humanReceipt(
  fixture: ReturnType<typeof comparisonFixture>,
  id: string,
  order: string[][],
  rejectAll = false,
) {
  return createPreferenceReceipt({
    id,
    assignment: fixture.assignment,
    comparisonRelease: fixture.release,
    reviewer: { kind: "human", releaseRef: REVIEWER },
    order,
    rejectAll,
    startedAt: NOW,
    completedAt: NOW,
  });
}

function modelReceipt(
  fixture: ReturnType<typeof comparisonFixture>,
  id: string,
  order: string[][],
) {
  return createPreferenceReceipt({
    id,
    assignment: fixture.assignment,
    comparisonRelease: fixture.release,
    reviewer: { kind: "model", releaseRef: JUDGE },
    order,
    rejectAll: false,
    startedAt: NOW,
    completedAt: NOW,
  });
}
