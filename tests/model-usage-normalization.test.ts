import { describe, expect, test } from "vitest";

import { normalizeModelUsageTokens } from "../apps/server/src/runtime/model-usage-normalization";

describe("model usage normalization", () => {
  test("normalizes OpenAI-compatible nested cached token usage", () => {
    expect(normalizeModelUsageTokens({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 60 },
    })).toEqual({
      promptTokens: 100,
      cachedPromptTokens: 60,
      uncachedPromptTokens: 40,
      cacheWritePromptTokens: null,
      cacheTelemetrySource: "provider_usage_body",
      completionTokens: 20,
      totalTokens: 120,
    });
  });

  test("normalizes Anthropic cache read and creation tokens into one prompt total", () => {
    expect(normalizeModelUsageTokens({
      input_tokens: 20,
      output_tokens: 5,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 10,
    })).toEqual({
      promptTokens: 90,
      cachedPromptTokens: 60,
      uncachedPromptTokens: 30,
      cacheWritePromptTokens: 10,
      cacheTelemetrySource: "provider_usage_body",
      completionTokens: 5,
      totalTokens: 95,
    });
  });

  test("normalizes DeepSeek cache hit and miss token usage", () => {
    expect(normalizeModelUsageTokens({
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_cache_hit_tokens: 72,
      prompt_cache_miss_tokens: 28,
    })).toEqual({
      promptTokens: 100,
      cachedPromptTokens: 72,
      uncachedPromptTokens: 28,
      cacheWritePromptTokens: null,
      cacheTelemetrySource: "provider_usage_body",
      completionTokens: 5,
      totalTokens: 105,
    });
  });

  test("derives the DeepSeek prompt total when only cache hit and miss counts are present", () => {
    expect(normalizeModelUsageTokens({
      prompt_cache_hit_tokens: 64,
      prompt_cache_miss_tokens: 16,
    })).toMatchObject({
      promptTokens: 80,
      cachedPromptTokens: 64,
      uncachedPromptTokens: 16,
      cacheTelemetrySource: "provider_usage_body",
      totalTokens: null,
    });
  });

  test("preserves response-header cache telemetry provenance", () => {
    expect(normalizeModelUsageTokens({
      prompt_tokens: 80,
      cached_input_tokens: 50,
      cache_telemetry_source: "provider_response_headers",
    })).toMatchObject({
      promptTokens: 80,
      cachedPromptTokens: 50,
      uncachedPromptTokens: 30,
      cacheTelemetrySource: "provider_response_headers",
    });
  });

  test("keeps unavailable and malformed cache telemetry null instead of reporting a miss", () => {
    expect(normalizeModelUsageTokens({ prompt_tokens: 80 })).toMatchObject({
      cachedPromptTokens: null,
      uncachedPromptTokens: null,
      cacheWritePromptTokens: null,
      cacheTelemetrySource: null,
    });
    expect(normalizeModelUsageTokens({
      prompt_tokens: 80,
      prompt_tokens_details: { cached_tokens: "unknown" },
    })).toMatchObject({
      cachedPromptTokens: null,
      uncachedPromptTokens: null,
      cacheWritePromptTokens: null,
      cacheTelemetrySource: null,
    });
    expect(normalizeModelUsageTokens({
      prompt_tokens: 80,
      cached_input_tokens: "unknown",
      prompt_tokens_details: { cached_tokens: 20 },
    })).toMatchObject({
      cachedPromptTokens: 20,
      uncachedPromptTokens: 60,
      cacheTelemetrySource: "provider_usage_body",
    });
  });

  test("bounds impossible included-cache counts to the reported prompt total", () => {
    expect(normalizeModelUsageTokens({
      prompt_tokens: 25,
      cached_input_tokens: 40,
    })).toMatchObject({
      promptTokens: 25,
      cachedPromptTokens: 25,
      uncachedPromptTokens: 0,
    });
  });
});
