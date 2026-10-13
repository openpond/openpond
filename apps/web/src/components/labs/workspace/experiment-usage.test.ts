import { expect, it } from "vitest";
import { aggregateExperimentUsage } from "./experiment-usage";

// A missing cost receipt must not make an experiment look free or understate its total.
it("keeps measured token usage independent from missing or incomplete billing receipts", () => {
  const first = { usage: { inputTokens: 16671, outputTokens: 335, totalTokens: 17006, costUsd: null } };
  expect(aggregateExperimentUsage([first], 1)).toEqual(first.usage);
  const second = { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.0123 } };
  expect(aggregateExperimentUsage([first, second], 2)).toEqual({ inputTokens: 16681, outputTokens: 340, totalTokens: 17021, costUsd: null });
  expect(aggregateExperimentUsage([second], 1).costUsd).toBe(0.0123);
  expect(aggregateExperimentUsage([second], 2)).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null });
});
