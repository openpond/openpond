export type AgentCompactionHost<TResult> = {
  started(): Promise<void>;
  compact(): Promise<TResult>;
  failed(error: unknown): Promise<void>;
};

export type AgentCompactionEvent = {
  id: string;
  turnId?: string | null;
};

export type AgentCompactionSelection<TEvent extends AgentCompactionEvent> = {
  summaryEvents: TEvent[];
  preservedEvents: TEvent[];
  preservedEventIds: string[];
  retainedTailTokens: number;
  retainedTailBudgetTokens: number;
  splitTurnId: string | null;
};

export type AgentCompactionProgramResult<TLedger, TMetrics> = {
  summary: string;
  model: string;
  compactedThroughEventId: string | null;
  compactedThroughTurnId: string | null;
  preservedFromEventId: string | null;
  preservedEventIds: string[];
  preservedResourceRefs: string[];
  sourceEventCount: number;
  preservedEventCount: number;
  fileLedger: TLedger[];
  inputTokensBefore: number;
  inputTokensAfter: number;
  maxContextTokens: number;
  tokenSource: "heuristic";
  metrics: TMetrics;
};

export type AgentCompactionProgramHost<
  TEvent extends AgentCompactionEvent,
  TRecord,
  TLedger,
  TMessage,
  TMetrics,
> = {
  projectEvents(events: readonly TEvent[]): TEvent[];
  selectEvents(
    events: readonly TEvent[],
    maxContextTokens: number,
  ): AgentCompactionSelection<TEvent>;
  normalizeRecords(events: TEvent[]): TRecord[];
  buildFileLedger(records: readonly TRecord[]): TLedger[];
  inputCharBudget(maxContextTokens: number): number;
  serializeRecords(
    records: readonly TRecord[],
    maxInputChars: number,
  ): { text: string; inputChars: number };
  buildSummaryMessages(input: {
    serializedHistory: string;
    fileLedger: TLedger[];
  }): TMessage[];
  streamSummary(input: {
    model: string;
    messages: TMessage[];
    signal?: AbortSignal;
  }): Promise<string>;
  estimateProjection(input: {
    events: TEvent[];
    preservedEvents: TEvent[];
    summary: string;
  }): { inputTokensBefore: number; inputTokensAfter: number };
  durableResourceRefs(events: readonly TEvent[]): string[];
  lastTurnId(events: readonly TEvent[]): string | null;
  createMetrics(input: {
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
  }): TMetrics;
};

export type AgentCompactionDecision = {
  shouldCompact: boolean;
  projectedTokens: number;
  thresholdTokens: number;
  usableContextTokens: number;
  maxContextTokens: number;
  tokenSource: "heuristic";
};

/** Owns the provider-neutral context threshold decision. */
export function agentCompactionDecision(input: {
  projectedTokens: number;
  maxContextTokens: number | null;
  usableContextTokens: number | null;
  triggerPercent?: number;
}): AgentCompactionDecision {
  if (!input.maxContextTokens || !input.usableContextTokens) {
    return {
      shouldCompact: false,
      projectedTokens: input.projectedTokens,
      thresholdTokens: Number.MAX_SAFE_INTEGER,
      usableContextTokens: 0,
      maxContextTokens: 0,
      tokenSource: "heuristic",
    };
  }
  const triggerRatio = Math.max(0.01, Math.min(1, (input.triggerPercent ?? 85) / 100));
  const thresholdTokens = Math.max(1, Math.floor(input.usableContextTokens * triggerRatio));
  return {
    shouldCompact: input.projectedTokens >= thresholdTokens,
    projectedTokens: input.projectedTokens,
    thresholdTokens,
    usableContextTokens: input.usableContextTokens,
    maxContextTokens: input.maxContextTokens,
    tokenSource: "heuristic",
  };
}

/**
 * Owns the transport-neutral compaction lifecycle while the host supplies
 * persistence, provider access, and its native or summary implementation.
 */
export async function runAgentCompaction<TResult>(
  host: AgentCompactionHost<TResult>,
): Promise<TResult> {
  await host.started();
  try {
    return await host.compact();
  } catch (error) {
    await host.failed(error);
    throw error;
  }
}

/**
 * Owns the complete provider-neutral compaction program. Hosts adapt their
 * event/message projections and persistence-specific record shapes through
 * typed ports; they do not independently reorder the compaction lifecycle.
 */
export async function runAgentCompactionProgram<
  TEvent extends AgentCompactionEvent,
  TRecord,
  TLedger,
  TMessage,
  TMetrics,
>(input: {
  events: readonly TEvent[];
  model: string;
  maxContextTokens: number;
  signal?: AbortSignal;
  host: AgentCompactionProgramHost<
    TEvent,
    TRecord,
    TLedger,
    TMessage,
    TMetrics
  >;
}): Promise<AgentCompactionProgramResult<TLedger, TMetrics>> {
  const projectionEvents = input.host.projectEvents(input.events);
  const selection = input.host.selectEvents(
    projectionEvents,
    input.maxContextTokens,
  );
  const { summaryEvents, preservedEvents, preservedEventIds } = selection;
  if (summaryEvents.length === 0) {
    throw new Error("There is not enough prior context to compact.");
  }

  const summaryRecords = input.host.normalizeRecords(summaryEvents);
  const fileLedger = input.host.buildFileLedger(
    input.host.normalizeRecords(projectionEvents),
  );
  const serialized = input.host.serializeRecords(
    summaryRecords,
    input.host.inputCharBudget(input.maxContextTokens),
  );
  if (!serialized.text.trim()) {
    throw new Error("There is not enough prior context to compact.");
  }

  const messages = input.host.buildSummaryMessages({
    serializedHistory: serialized.text,
    fileLedger,
  });
  const startedAtMs = Date.now();
  const summary = (
    await input.host.streamSummary({
      model: input.model,
      messages,
      signal: input.signal,
    })
  ).trim();
  const durationMs = Date.now() - startedAtMs;
  if (!summary) throw new Error("Compaction summary was empty.");

  const projection = input.host.estimateProjection({
    events: projectionEvents,
    preservedEvents,
    summary,
  });
  const metrics = input.host.createMetrics({
    sourceEvents: projectionEvents.length,
    summarizedEvents: summaryEvents.length,
    preservedEvents: preservedEvents.length,
    summaryInputChars: serialized.inputChars,
    retainedTailTokens: selection.retainedTailTokens,
    retainedTailBudgetTokens: selection.retainedTailBudgetTokens,
    finalProviderContextTokens: projection.inputTokensAfter,
    durationMs,
    fileLedgerEntries: fileLedger.length,
    splitTurnId: selection.splitTurnId,
  });

  return {
    summary,
    model: input.model,
    compactedThroughEventId:
      projectionEvents[projectionEvents.length - 1]?.id ?? null,
    compactedThroughTurnId: input.host.lastTurnId(projectionEvents),
    preservedFromEventId: preservedEvents[0]?.id ?? null,
    preservedEventIds,
    preservedResourceRefs: input.host.durableResourceRefs(input.events),
    sourceEventCount: summaryEvents.length,
    preservedEventCount: preservedEvents.length,
    fileLedger,
    inputTokensBefore: projection.inputTokensBefore,
    inputTokensAfter: projection.inputTokensAfter,
    maxContextTokens: input.maxContextTokens,
    tokenSource: "heuristic",
    metrics,
  };
}
