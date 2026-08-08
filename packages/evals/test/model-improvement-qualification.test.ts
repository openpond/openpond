import { describe, expect, test } from "vitest";

import {
  createModelImprovementQualificationReceipt,
  harnessEvaluationReviewConformance,
  verifyModelImprovementQualificationReceipt,
} from "../src/index.js";
import { verifyHarnessEvaluationReviewReceipt } from "@openpond/harness";

describe("Harness Evaluation and model-improvement conformance", () => {
  test("covers no action, runtime, product, and Taskset routing", () => {
    const fixtures = harnessEvaluationReviewConformance;

    expect(verifyHarnessEvaluationReviewReceipt(fixtures.noAction)).toBe(true);
    expect(verifyHarnessEvaluationReviewReceipt(fixtures.runtime)).toBe(true);
    expect(verifyHarnessEvaluationReviewReceipt(fixtures.product)).toBe(true);
    expect(verifyHarnessEvaluationReviewReceipt(fixtures.taskset)).toBe(true);
    expect(fixtures.runtime.nextAuthority).toBe("runtime_service");
    expect(fixtures.product.nextAuthority).toBe("product_team");
    expect(fixtures.taskset.tasksetProposal).not.toBeNull();
  });

  test("blocks weak RL and qualifies only a frozen usable reward path", () => {
    const { blockedRl, qualifiedRl, modelImprovement, taskset } =
      harnessEvaluationReviewConformance;

    expect(verifyModelImprovementQualificationReceipt(blockedRl)).toBe(true);
    expect(blockedRl).toMatchObject({
      decision: "no_training",
      signal: { kind: "scalar_reward", strength: "weak", variance: 0 },
    });
    expect(verifyModelImprovementQualificationReceipt(qualifiedRl)).toBe(true);
    expect(qualifiedRl).toMatchObject({
      decision: "rl",
      signal: {
        kind: "scalar_reward",
        strength: "usable",
        calibrated: true,
        confounded: false,
      },
    });
    expect(qualifiedRl.review).toEqual({
      id: taskset.id,
      contentHash: taskset.contentHash,
    });
    expect(verifyHarnessEvaluationReviewReceipt(modelImprovement)).toBe(true);
    expect(modelImprovement.trainingQualification).toEqual({
      id: qualifiedRl.id,
      contentHash: qualifiedRl.contentHash,
    });
  });

  test("rejects a qualified RL decision when the signal is weak", () => {
    const { contentHash: _contentHash, ...input } =
      harnessEvaluationReviewConformance.qualifiedRl;

    expect(() =>
      createModelImprovementQualificationReceipt({
        ...input,
        signal: { ...input.signal, strength: "weak", variance: 0 },
      }),
    ).toThrow(/qualified model improvement|variance/i);
  });

  test("rejects overlap between training and frozen Evaluation evidence", () => {
    const { contentHash: _contentHash, ...input } =
      harnessEvaluationReviewConformance.blockedRl;
    const overlapping = input.trainingEvidenceRefs[0]!;

    expect(() =>
      createModelImprovementQualificationReceipt({
        ...input,
        frozenEvaluationEvidenceRefs: [overlapping],
      }),
    ).toThrow(/frozen Evaluation evidence/i);
  });
});
