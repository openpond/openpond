import { describe, expect, test } from "vitest";

import {
  HarnessRunOverlaySchema,
  HarnessCrossRunRefinementRequestSchema,
  HarnessRefinementCandidateSchema,
  HarnessRefinerActivityReceiptSchema,
  ImprovementObservationSchema,
  HarnessEvaluationReviewReceiptSchema,
  HarnessEvaluationReviewModelDecisionSchema,
  HostedHarnessRefinerRequestSchema,
  HostedHarnessRefinerResponseSchema,
  LocalHarnessRefinerDecisionSchema,
  LocalHarnessRefinerDecisionV2Schema,
  RefinerReviewProfileSchema,
  RefinerReleaseSchema,
  DEFAULT_REFINER_REVIEW_PROFILE,
  createRefinerRelease,
  admitLocalHarnessRefinerDecision,
  ToolDeclarationSchema,
  contentHash,
} from "../src/index.js";

describe("@openpond/harness public API", () => {
  test("exports the portable Harness primitives without Eval contracts", () => {
    expect(contentHash({ harness: true })).toMatch(/^[a-f0-9]{64}$/);
    expect(ToolDeclarationSchema).toBeDefined();
    expect(HarnessRunOverlaySchema).toBeDefined();
    expect(HarnessCrossRunRefinementRequestSchema).toBeDefined();
    expect(HarnessRefinementCandidateSchema).toBeDefined();
    expect(HarnessRefinerActivityReceiptSchema).toBeDefined();
    expect(ImprovementObservationSchema).toBeDefined();
    expect(HarnessEvaluationReviewReceiptSchema).toBeDefined();
    expect(HarnessEvaluationReviewModelDecisionSchema).toBeDefined();
    expect(LocalHarnessRefinerDecisionSchema).toBeDefined();
    expect(LocalHarnessRefinerDecisionV2Schema).toBeDefined();
    expect(RefinerReviewProfileSchema.parse(DEFAULT_REFINER_REVIEW_PROFILE)).toEqual(DEFAULT_REFINER_REVIEW_PROFILE);
    expect(createRefinerRelease({
      profile: DEFAULT_REFINER_REVIEW_PROFILE,
      coreVersion: "test",
      corePrompt: "core",
      createdAt: "2026-08-26T00:00:00.000Z",
    })).toMatchObject({ schemaVersion: "openpond.refinerRelease.v1" });
    expect(RefinerReleaseSchema).toBeDefined();
    expect(HostedHarnessRefinerRequestSchema).toBeDefined();
    expect(HostedHarnessRefinerResponseSchema).toBeDefined();
    expect(admitLocalHarnessRefinerDecision).toBeTypeOf("function");
  });
});
