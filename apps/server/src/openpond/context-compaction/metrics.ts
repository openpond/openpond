import type { CompactionMetrics } from "./types.js";

export function estimateTextTokens(value: string): number {
  return Math.max(0, Math.ceil(value.length / 4));
}

export function createCompactionMetrics(input: {
  sourceEvents: number;
  summarizedEvents: number;
  preservedEvents: number;
  summaryInputChars: number;
  retainedTailTokens: number;
  retainedTailBudgetTokens: number;
  finalProviderContextTokens: number;
  durationMs: number;
  fileLedgerEntries: number;
  splitTurnId: string | null;
}): CompactionMetrics {
  return {
    sourceEvents: input.sourceEvents,
    summarizedEvents: input.summarizedEvents,
    preservedEvents: input.preservedEvents,
    summaryInputChars: input.summaryInputChars,
    summaryInputTokens: Math.max(0, Math.ceil(input.summaryInputChars / 4)),
    retainedTailTokens: input.retainedTailTokens,
    retainedTailBudgetTokens: input.retainedTailBudgetTokens,
    finalProviderContextTokens: input.finalProviderContextTokens,
    durationMs: Math.max(0, Math.floor(input.durationMs)),
    fileLedgerEntries: input.fileLedgerEntries,
    splitTurnId: input.splitTurnId,
    tokenSource: "heuristic",
  };
}
