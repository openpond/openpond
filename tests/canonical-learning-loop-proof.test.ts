import { describe, expect, it } from "vitest";

import {
  verifyCanonicalRolloutRecord,
  verifyRewardReceipt,
} from "@openpond/evals";

import { CANONICAL_LEARNING_PROOF_CASES } from "../benchmarks/canonical-learning-loop/cases.js";
import { runCanonicalLearningLoopProof } from "../benchmarks/canonical-learning-loop/proof.js";

describe("canonical continual-learning mechanism proof", () => {
  it("locks the 8/4/6/2 split without source-cluster overlap", () => {
    expect(CANONICAL_LEARNING_PROOF_CASES.filter((item) => item.cohort === "adaptation")).toHaveLength(8);
    expect(CANONICAL_LEARNING_PROOF_CASES.filter((item) => item.cohort === "development")).toHaveLength(4);
    expect(CANONICAL_LEARNING_PROOF_CASES.filter((item) => item.cohort === "held_out")).toHaveLength(6);
    expect(CANONICAL_LEARNING_PROOF_CASES.filter((item) => item.cohort === "control")).toHaveLength(2);
    expect(new Set(CANONICAL_LEARNING_PROOF_CASES.map((item) => item.clusterKey))).toHaveLength(
      CANONICAL_LEARNING_PROOF_CASES.length,
    );
  });

  it("proves scored failures, candidate transfer, controls, lineage, and regrade locally", () => {
    const proof = runCanonicalLearningLoopProof();
    expect(proof.evidence).toMatchObject({
      proofKind: "deterministic_protocol_conformance",
      providerCalls: 0,
      taskCounts: { adaptation: 8, development: 4, heldOut: 6, controls: 2 },
      fixtureAudit: {
        oracle: { attemptCount: 20, passCount: 20, meanReward: 1 },
        negative: { attemptCount: 20, zeroRewardCount: 20, meanReward: 0 },
        promptInjection: { attemptCount: 1, zeroRewardCount: 1, meanReward: 0 },
      },
      adaptationEvidence: { attemptCount: 8, scoredCount: 8, zeroRewardCount: 8 },
      developmentValidation: { attemptCount: 4, passCount: 4, meanReward: 1 },
      frozenComparison: {
        htmlBefore: { attemptCount: 6, passCount: 0, meanReward: 0 },
        htmlAfter: { attemptCount: 6, passCount: 6, meanReward: 1 },
        controlsBefore: { attemptCount: 2, passCount: 2, meanReward: 1 },
        controlsAfter: { attemptCount: 2, passCount: 2, meanReward: 1 },
      },
      decision: {
        developmentPassed: true,
        heldOutImproved: true,
        controlsNonRegressed: true,
        outcome: "retain_candidate",
      },
      regrade: {
        originalReward: 0,
        derivedReward: 0,
      },
    });
    const attempts = [
      ...proof.attempts.oracleFixtures,
      ...proof.attempts.negativeFixtures,
      proof.attempts.promptInjectionFixture,
      ...proof.attempts.baselineAdaptation,
      ...proof.attempts.candidateDevelopment,
      ...proof.attempts.baselineFrozen,
      ...proof.attempts.candidateFrozen,
    ];
    expect(attempts.every((attempt) => verifyRewardReceipt(attempt.rewardReceipt))).toBe(true);
    expect(attempts.every((attempt) => verifyCanonicalRolloutRecord(attempt.rollout))).toBe(true);
    expect(proof.evidence.regrade.supersedes).toEqual(
      proof.evidence.regrade.originalRewardReceipt,
    );
  });

  it("keeps the checked-in sealed evidence synchronized with the proof", async () => {
    const checked = JSON.parse(await readFile(path.resolve(
      "benchmarks/canonical-learning-loop/evidence/canonical-learning-loop-proof.json",
    ), "utf8"));
    expect(checked).toEqual(runCanonicalLearningLoopProof().evidence);
  });
});
import { readFile } from "node:fs/promises";
import path from "node:path";
