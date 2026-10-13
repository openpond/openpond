type ReportedUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
};

/** Missing receipts must stay unknown rather than becoming zero or a partial total. */
export function aggregateExperimentUsage(cases: { usage: ReportedUsage }[], expectedCount: number): ReportedUsage {
  const sum = (key: keyof ReportedUsage) => {
    if (cases.length !== expectedCount || !cases.length || cases.some(row => row.usage[key] === null)) return null;
    return cases.reduce((total, row) => total + row.usage[key]!, 0);
  };
  return { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), totalTokens: sum("totalTokens"), costUsd: sum("costUsd") };
}

export function experimentTokenLabel(usage: ReportedUsage): string {
  return usage.totalTokens === null ? "Tokens unavailable" : `${usage.totalTokens.toLocaleString("en-US")} tokens`;
}

export function experimentTokenDetails(usage: ReportedUsage): string {
  return `Reported tokens: ${usage.inputTokens?.toLocaleString("en-US") ?? "unknown"} input · ${usage.outputTokens?.toLocaleString("en-US") ?? "unknown"} output. Token counts are usage, not a billed dollar or credit amount.`;
}
