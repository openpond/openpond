import { describe, expect, it } from "vitest";

import { createHarnessRefinerBenchmarkModelStream } from "./harness-refiner-benchmark-model.js";

const pricing = {
  version: "test",
  source: "test",
  effectiveAt: "2026-08-11T00:00:00.000Z",
  inputUsdPerMillionTokens: 1,
  cachedInputUsdPerMillionTokens: 0.5,
  outputUsdPerMillionTokens: 2,
};

describe("Harness Refiner benchmark model stream", () => {
  it("publishes usage before decision text so an early consumer cannot discard accounting", async () => {
    const stream = createHarnessRefinerBenchmarkModelStream(async function* () {
      yield { type: "text_delta", text: '{"decision":"no_action"}', raw: {} } as const;
      yield {
        type: "usage",
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
        },
        raw: {},
      } as const;
      yield { type: "finish", finishReason: "stop", raw: {} } as const;
    });

    const iterator = stream({
      model: { providerId: "openpond", modelId: "openpond-chat" },
      messages: [{ role: "user", content: "Review this turn." }],
      signal: new AbortController().signal,
      pricing,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
        },
        costUsd: 0.00012,
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { text: '{"decision":"no_action"}' },
    });

    await iterator.return?.();
  });

  it("fails closed when a completed provider response has no usage", async () => {
    const stream = createHarnessRefinerBenchmarkModelStream(async function* () {
      yield { type: "text_delta", text: '{"decision":"no_action"}', raw: {} } as const;
      yield { type: "finish", finishReason: "stop", raw: {} } as const;
    });

    const consume = async () => {
      for await (const _delta of stream({
        model: { providerId: "openpond", modelId: "openpond-chat" },
        messages: [{ role: "user", content: "Review this turn." }],
        signal: new AbortController().signal,
        pricing,
      })) {
        // Consume the complete stream.
      }
    };

    await expect(consume()).rejects.toThrow(
      "Harness Refiner benchmark provider response is missing usage.",
    );
  });
});
