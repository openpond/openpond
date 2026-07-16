import { describe, expect, test } from "vitest";
import { normalizeModelUsageTokens } from "../apps/server/src/runtime/model-usage-normalization";

describe("model usage normalization", () => {
  test("normalizes OpenAI-style usage keys", () => {
    expect(normalizeModelUsageTokens({
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
    })).toEqual({
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
    });
  });

  test("normalizes camelCase and input/output token keys", () => {
    expect(normalizeModelUsageTokens({
      inputTokens: "42",
      outputTokens: 8,
    })).toEqual({
      promptTokens: 42,
      completionTokens: 8,
      totalTokens: 50,
    });
  });

  test("stores reported total without estimating missing splits", () => {
    expect(normalizeModelUsageTokens({ totalTokens: 77 })).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: 77,
    });
  });

  test("returns null counts when provider usage is missing", () => {
    expect(normalizeModelUsageTokens(null)).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
  });
});
