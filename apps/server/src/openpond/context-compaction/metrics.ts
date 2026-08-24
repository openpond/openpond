import type { CompactionMetrics } from "./types.js";

export function estimateTextTokens(value: string): number {
  return Math.max(0, Math.ceil(value.length / 4));
}

export function createCompactionMetrics(input: {
  sourceEvents: number;
  summarizedEvents: number;
  preservedEvents: number;
  sourceRecords: number;
  includedRecords: number;
  omittedRecords: number;
  preservedRecords: number;
  truncatedRecords: number;
  summaryInputTruncated: boolean;
  sourceSelectionStrategy: string;
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
    sourceRecords: input.sourceRecords,
    includedRecords: input.includedRecords,
    omittedRecords: input.omittedRecords,
    preservedRecords: input.preservedRecords,
    truncatedRecords: input.truncatedRecords,
    summaryInputTruncated: input.summaryInputTruncated,
    sourceSelectionStrategy: "newest_useful_v1",
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
