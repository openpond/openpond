import { describe, expect, it } from "vitest";

import {
  createPreferenceComparisonModelJudge,
  parsePreferenceModelJudgment,
} from "./preference-comparison-model-judge.js";

describe("preference comparison model judge parsing", () => {
  it("accepts a complete pseudonymous order and keeps criterion scores keyed by presentation label", () => {
    expect(parsePreferenceModelJudgment(
      '{"order":[["candidate-2"],["candidate-1","candidate-3"]],"rejectAll":false,"criterionScores":{"candidate-2":{"visual-quality":1}}}',
      ["candidate-1", "candidate-2", "candidate-3"],
    )).toEqual({
      order: [["candidate-2"], ["candidate-1", "candidate-3"]],
      rejectAll: false,
      criterionScores: { "candidate-2": { "visual-quality": 1 } },
    });
  });

  it("rejects incomplete and identity-leaking orders before they can become a receipt", () => {
    expect(() => parsePreferenceModelJudgment(
      '{"order":[["candidate-1"]],"rejectAll":false}',
      ["candidate-1", "candidate-2"],
    )).toThrow("rank every presented candidate exactly once");
    expect(() => parsePreferenceModelJudgment(
      '{"order":[["attempt-secret"],["candidate-2"]],"rejectAll":false}',
      ["candidate-1", "candidate-2"],
    )).toThrow("unknown presentation candidate");
  });

  it("keeps reject-all separate from a low-ranked candidate", () => {
    expect(parsePreferenceModelJudgment(
      '```json\n{"order":[],"rejectAll":true}\n```',
      ["candidate-1", "candidate-2"],
    )).toEqual({ order: [], rejectAll: true });
  });

  it("classifies caller cancellation without persisting an opaque transport failure", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));
    const judge = createPreferenceComparisonModelJudge({
      modelText: (async ({ signal }: { signal: AbortSignal }) => {
        throw signal.reason;
      }) as never,
      loadVisualCandidates: async () => [],
    });
    const outcome = await judge.judge({
      id: "receipt-1",
      assignment: {
        id: "assignment-1",
        candidates: [
          { attemptRef: { id: "attempt-a" } },
          { attemptRef: { id: "attempt-b" } },
        ],
        presentedCandidateOrder: ["attempt-a", "attempt-b"],
      } as never,
      comparisonRelease: {
        presentation: { showTaskPrompt: true, parts: [{ renderer: "text" }] },
      } as never,
      reviewer: { kind: "model", releaseRef: { id: "reviewer", contentHash: "a".repeat(64) } },
      model: { providerId: "openpond", modelId: "judge" },
      rubric: "Rank quality.",
      signal: controller.signal,
    });

    expect(outcome).toMatchObject({
      status: "unscorable",
      code: "judge_cancelled",
      failureOwner: "caller",
    });
  });

  it("uses the explicit swapped presentation order for native image review", async () => {
    let imageOrder: string[] = [];
    const judge = createPreferenceComparisonModelJudge({
      modelText: (async ({ messages }: { messages: Array<{ images?: Array<{ url: string }> }> }) => {
        imageOrder = messages.flatMap((message) => message.images?.map((image) => image.url) ?? []);
        return '{"order":[["candidate-1"],["candidate-2"]],"rejectAll":false}';
      }) as never,
      loadVisualCandidates: async () => [
        { attemptId: "attempt-a", images: [{ url: "data:image/png;base64,YQ==", detail: "high" }] },
        { attemptId: "attempt-b", images: [{ url: "data:image/png;base64,Yg==", detail: "high" }] },
      ],
    });
    await judge.judge({
      id: "receipt-2",
      assignment: {
        id: "assignment-2",
        candidates: [
          { attemptRef: { id: "attempt-a" } },
          { attemptRef: { id: "attempt-b" } },
        ],
        presentedCandidateOrder: ["attempt-a", "attempt-b"],
      } as never,
      comparisonRelease: {
        presentation: { showTaskPrompt: true, parts: [{ renderer: "text" }, { renderer: "image" }] },
      } as never,
      reviewer: { kind: "model", releaseRef: { id: "reviewer", contentHash: "a".repeat(64) } },
      model: { providerId: "openpond", modelId: "judge" },
      rubric: "Rank quality.",
      presentedCandidateOrder: ["attempt-b", "attempt-a"],
      signal: new AbortController().signal,
    });

    expect(imageOrder).toEqual([
      "data:image/png;base64,Yg==",
      "data:image/png;base64,YQ==",
    ]);
  });
});
