import { describe, expect, it } from "vitest";

import { parsePreferenceModelJudgment } from "./preference-comparison-model-judge.js";

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
});
