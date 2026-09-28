import assert from "node:assert/strict";
import test from "node:test";

import { quoteRfqHostedModelRequest, settleRfqHostedModelCharge } from "./rfq-model-charge.js";

function catalog(pricing: Record<string, unknown> = {}): Record<string, unknown> {
  return { metadata: { billing: { pricing: {
    version: "test-revision", source: "fireworks-serverless",
    effectiveAt: "2026-09-27T00:00:00.000Z",
    inputUsdPerMillionTokens: 0.22,
    cachedInputUsdPerMillionTokens: 0.007,
    outputUsdPerMillionTokens: 0.66,
    ...pricing,
  } } } };
}

test("RFQ quote reserves retail, expensive tiers, and ambiguous usage at their maximum", () => {
  const quote = quoteRfqHostedModelRequest({ modelCatalogRaw: catalog(),
    maximumInputTokens: 1_048_576, maximumOutputTokens: 8_192 });
  // Provider cost alone is about $0.236; Sandbox bills the retail gross-up.
  assert.equal(quote.maximumCents, 32);
  assert.equal(settleRfqHostedModelCharge(quote, {}), null);
  assert.equal(settleRfqHostedModelCharge(quote, { prompt_tokens: 1_000, completion_tokens: 100 }), 1);
  assert.throws(() => settleRfqHostedModelCharge(quote,
    { prompt_tokens: 1_048_577, completion_tokens: 1 }), /ceiling/);

  const tiered = quoteRfqHostedModelRequest({ modelCatalogRaw: catalog({
    longContextPricing: { inputUsdPerMillionTokens: 1.5,
      cachedInputUsdPerMillionTokens: 1.2, outputUsdPerMillionTokens: 3 },
  }), maximumInputTokens: 1_048_576, maximumOutputTokens: 8_192 });
  assert.ok(tiered.maximumCents > quote.maximumCents);
  assert.throws(() => quoteRfqHostedModelRequest({ modelCatalogRaw: catalog({
    cacheWriteUsdPerMillionTokens: "unknown",
  }), maximumInputTokens: 1000, maximumOutputTokens: 100 }), /invalid optional token rate/);
});
