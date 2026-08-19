import { describe, expect, test, vi } from "vitest";

import { createTrainingModelRuntime } from "./training-model-runtime.js";

const pricing = {
  version: "test-v1",
  source: "test",
  effectiveAt: "2026-08-19T00:00:00.000Z",
  inputUsdPerMillionTokens: 0.14,
  cachedInputUsdPerMillionTokens: 0.028,
  outputUsdPerMillionTokens: 0.28,
};

describe("training model runtime hosted retries", () => {
  test("recovers from a short sequence of pre-response 502 failures", async () => {
    vi.useFakeTimers();
    try {
      let requests = 0;
      const runtime = createTrainingModelRuntime({
        loadLocalByokRuntimeState: vi.fn(),
        getManagedAdapterChatRuntime: () => ({
          appliesTo: async () => false,
          stream: vi.fn(),
        }) as never,
        streamOpenPondHostedChatTurn: (async function* () {
          requests += 1;
          if (requests <= 3) {
            throw new Error("OpenPond OpChat request failed: 502 Bad gateway");
          }
          yield { type: "text_delta", text: "recovered" };
          yield {
            type: "usage",
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          };
        }) as never,
      });

      const completion = runtime.trainingModelText({
        model: { providerId: "openpond", modelId: "test-model" },
        messages: [{ role: "user", content: "hello" }],
        signal: new AbortController().signal,
        requestId: "retry-test",
        hostedTokenPricing: pricing,
      });
      await vi.runAllTimersAsync();

      await expect(completion).resolves.toBe("recovered");
      expect(requests).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
