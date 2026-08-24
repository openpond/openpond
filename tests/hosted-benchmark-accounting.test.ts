import { describe, expect, test } from "vitest";

import {
  hostedTokenPricingFromCatalog,
  hostedTokenPricingFromValue,
  hostedUsageCostUsd,
} from "../apps/server/src/training/hosted-token-pricing.js";
import {
  hostedRetryDelayMs,
  retryableHostedError,
} from "../apps/server/src/training/hosted-provider-retry.js";
import { createHarnessRefinerBenchmarkModelStream } from "../apps/server/src/training/harness-refiner-benchmark-model.js";

const pricing = {
  version: "provider-2026-08-09",
  source: "provider-api",
  effectiveAt: "2026-08-09T00:00:00.000Z",
  inputUsdPerMillionTokens: 1,
  cachedInputUsdPerMillionTokens: 0.1,
  outputUsdPerMillionTokens: 2,
};

describe("hosted benchmark accounting", () => {
  test("requires a provider catalog rate card and prices cached tokens separately", () => {
    expect(hostedTokenPricingFromCatalog({
      metadata: { billing: { pricing } },
    })).toEqual(pricing);
    expect(hostedUsageCostUsd({
      prompt_tokens: 1_000_000,
      completion_tokens: 500_000,
      prompt_tokens_details: { cached_tokens: 200_000 },
    }, pricing)).toBeCloseTo(1.82, 10);
    expect(hostedUsageCostUsd({
      input_tokens: 20,
      output_tokens: 5,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 10,
    }, pricing)).toBeCloseTo(0.000046, 10);
    expect(() => hostedTokenPricingFromCatalog({ metadata: {} })).toThrow(
      "pricing version",
    );
    expect(hostedTokenPricingFromValue(pricing)).toEqual(pricing);
    expect(hostedTokenPricingFromValue({ version: "incomplete" })).toBeNull();
  });

  test("recognizes retryable provider failures and honors bounded retry-after", () => {
    const failure = new Error(
      'OpenPond request failed: 502 {"retryable":true,"retry_after":60}',
    );
    expect(retryableHostedError(failure)).toBe(true);
    expect(hostedRetryDelayMs(failure, 0)).toBe(60_000);
    expect(retryableHostedError(new Error("invalid request: 400"))).toBe(false);
  });

  test("recognizes Node fetch transport failures without retrying request errors", () => {
    const transport = new TypeError("fetch failed", {
      cause: new Error("read ECONNRESET"),
    });
    expect(retryableHostedError(transport)).toBe(true);
    expect(retryableHostedError(new Error("UND_ERR_HEADERS_TIMEOUT"))).toBe(true);
    expect(retryableHostedError(new Error("schema validation failed"))).toBe(false);
  });

  test("runs Refiner with the same admitted hosted model whose price card is used", async () => {
    const requestedModels: string[] = [];
    const stream = createHarnessRefinerBenchmarkModelStream((async function* (input: {
      model: string;
    }) {
      requestedModels.push(input.model);
      yield {
        type: "usage",
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      };
    }) as never);

    const deltas = [];
    for await (const delta of stream({
      model: { providerId: "openpond", modelId: "openpond-research" },
      messages: [{ role: "user", content: "Review the cohort." }],
      signal: new AbortController().signal,
      pricing,
    })) {
      deltas.push(delta);
    }

    expect(requestedModels).toEqual(["openpond-research"]);
    expect(deltas[0]).toMatchObject({ costUsd: 0.000014 });
  });
});
