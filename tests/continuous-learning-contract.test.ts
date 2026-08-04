import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  CONTINUOUS_LEARNING_RECEIPT_CONTRACT_VERSION,
  CONTINUOUS_LEARNING_RECOMMENDATION_PROMPT,
  CONTINUOUS_LEARNING_SCOPE_OPTIONS,
  ContinuousLearningReceiptSchema,
  GET_CONVERSATIONS_CONTRACT_VERSION,
  GetConversationsToolInputSchema,
  GetConversationsToolResultSchema,
  MAX_REVIEW_CONVERSATIONS,
} from "../packages/contracts/src";

function sourceReference(index: number, scope: "personal" | "my_team" = "personal") {
  return {
    referenceId: `source-${index}`,
    surface: "desktop" as const,
    scope,
    experience: "chat" as const,
    revision: `revision-${index}`,
    occurredAt: "2026-08-03T12:00:00.000Z",
    contentHash: `hash-${index}`,
  };
}

function conversation(index: number, scope: "personal" | "my_team" = "personal") {
  return {
    sourceReference: sourceReference(index, scope),
    title: `Conversation ${index}`,
    messages: [
      {
        role: "user" as const,
        text: "Please perform the recurring workflow.",
        createdAt: "2026-08-03T12:00:00.000Z",
      },
    ],
  };
}

const emptyExcludedCounts = {
  notEligible: 0,
  revoked: 0,
  notCreatedByOwner: 0,
  multiParticipant: 0,
  outsideLookback: 0,
  dismissedFingerprint: 0,
  budgetBound: 0,
};

describe("continuous-learning contracts", () => {
  it("passes the shared recurrence, privacy, cancellation, and no-materialization fixtures", () => {
    const fixture = JSON.parse(readFileSync(
      new URL("../packages/contracts/fixtures/continuous-learning-v1.json", import.meta.url),
      "utf8",
    )) as { schemaVersion: string; cases: Array<Record<string, unknown>> };
    expect(fixture.schemaVersion).toBe("openpond.continuousLearningFixtures.v1");
    expect(fixture.cases.map((item) => item.id)).toEqual([
      "recurrence-three-independent-sources",
      "privacy-revoked-and-multi-participant",
      "cancel-does-not-advance-watermark",
      "no-recommendation-commits-reviewed-watermark",
      "recommendation-never-materializes",
    ]);
    for (const item of fixture.cases) {
      if (item.kind === "receipt") {
        expect(item.materializationInvoked).toBe(false);
        if (item.status === "cancelled") expect(item.outputWatermark).toBeNull();
        if (item.status === "no_recommendation") {
          expect(item.noRecommendationReason).toBe("insufficient_recurrence");
          expect(item.outputWatermark).toBeTruthy();
        }
      }
    }
  });
  it("backs the authoring Work item with the dedicated recommendation-only tool", () => {
    expect(CONTINUOUS_LEARNING_RECOMMENDATION_PROMPT).toContain(
      "Call get_conversations exactly once",
    );
    expect(CONTINUOUS_LEARNING_RECOMMENDATION_PROMPT).toContain(
      "Do not materialize a Taskset",
    );
  });

  it("keeps full_team visible but outside the callable scope", () => {
    expect(CONTINUOUS_LEARNING_SCOPE_OPTIONS.at(-1)).toMatchObject({
      value: "full_team",
      enabled: false,
    });
    expect(
      GetConversationsToolInputSchema.safeParse({ scope: "full_team" }).success,
    ).toBe(false);
  });

  it("does not accept runtime-bound identity in model arguments", () => {
    expect(
      GetConversationsToolInputSchema.safeParse({
        ownerId: "another-owner",
        conversationIds: ["source-1"],
        watermark: "chosen-by-model",
      }).success,
    ).toBe(false);
    expect(
      GetConversationsToolInputSchema.safeParse({}).success,
    ).toBe(true);
  });

  it("bounds conversations and requires every source to match the runtime scope", () => {
    const base = {
      schemaVersion: GET_CONVERSATIONS_CONTRACT_VERSION,
      scope: "personal" as const,
      inputWatermark: null,
      proposedWatermark: "watermark-1",
      consideredSourceCount: 12,
      excludedCounts: emptyExcludedCounts,
      emptyReason: null,
    };

    expect(
      GetConversationsToolResultSchema.safeParse({
        ...base,
        conversations: Array.from(
          { length: MAX_REVIEW_CONVERSATIONS },
          (_, index) => conversation(index),
        ),
      }).success,
    ).toBe(true);
    expect(
      GetConversationsToolResultSchema.safeParse({
        ...base,
        conversations: Array.from(
          { length: MAX_REVIEW_CONVERSATIONS + 1 },
          (_, index) => conversation(index),
        ),
      }).success,
    ).toBe(false);
    expect(
      GetConversationsToolResultSchema.safeParse({
        ...base,
        conversations: [conversation(1, "my_team")],
      }).success,
    ).toBe(false);
  });

  it("requires an explicit reason when no conversations are returned", () => {
    expect(
      GetConversationsToolResultSchema.safeParse({
        schemaVersion: GET_CONVERSATIONS_CONTRACT_VERSION,
        scope: "personal",
        inputWatermark: null,
        proposedWatermark: "watermark-1",
        consideredSourceCount: 0,
        excludedCounts: emptyExcludedCounts,
        conversations: [],
        emptyReason: "no_eligible_sources",
      }).success,
    ).toBe(true);
  });

  it("prevents failed receipts from advancing a watermark or claiming materialization", () => {
    const receipt = {
      schemaVersion: CONTINUOUS_LEARNING_RECEIPT_CONTRACT_VERSION,
      surface: "desktop" as const,
      scope: "personal" as const,
      scheduleDefinitionRef: "schedule-1",
      runRef: "run-1",
      promptVersion: "prompt-v1",
      skill: {
        name: "openpond-taskset-authoring",
        artifactVersion: "skill-v1",
        contentHash: "skill-hash",
      },
      evidenceContractVersion: GET_CONVERSATIONS_CONTRACT_VERSION,
      inputWatermark: "watermark-0",
      outputWatermark: null,
      consideredSourceCount: 0,
      excludedCounts: emptyExcludedCounts,
      selectedSourceReferences: [],
      candidateFingerprints: [],
      recommendationSummaries: [],
      model: { provider: "openai", model: "model-1" },
      usage: { inputTokens: 0, outputTokens: 0, durationMs: 0, costUsd: 0 },
      status: "failed" as const,
      noRecommendationReason: null,
      materializationInvoked: false as const,
      createdAt: "2026-08-03T12:00:00.000Z",
    };

    expect(ContinuousLearningReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(
      ContinuousLearningReceiptSchema.safeParse({
        ...receipt,
        outputWatermark: "watermark-1",
      }).success,
    ).toBe(false);
    expect(
      ContinuousLearningReceiptSchema.safeParse({
        ...receipt,
        materializationInvoked: true,
      }).success,
    ).toBe(false);
  });
});
