import { randomUUID } from "node:crypto";
import {
  DEFAULT_OPENPOND_CHAT_MODEL,
  type ChatProvider,
} from "@openpond/contracts";
import { streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn } from "@openpond/runtime";
import type { HostedChatMessage } from "@openpond/cloud";
import {
  estimateHostedMessageTokens,
  hostedContextLimit,
  hostedContextProvider,
  usableHostedContextLimit,
} from "../context-usage.js";
import { buildChatMessagesForProvider } from "../hosted-chat.js";
import { buildFileOperationLedger } from "./file-ledger.js";
import { createCompactionMetrics } from "./metrics.js";
import {
  durableResourceRefs,
  eventsForHostedCompaction,
  lastTurnId,
  normalizeCompactionRecords,
  serializeRecordsForCompaction,
} from "./normalizer.js";
import { buildCompactionSummaryMessages, compactionInputCharBudget } from "./prompt.js";
import { selectEventsForHostedCompaction } from "./tail-selection.js";
import type {
  ContextCompactionStream,
  ContextCompactionStreamDelta,
  HostedAutoCompactionDecision,
  HostedCompactionInput,
  HostedCompactionProvider,
  HostedCompactionResult,
} from "./types.js";

export type {
  CompactionMetrics,
  CompactionRecord,
  ContextCompactionStream,
  ContextCompactionStreamDelta,
  FileLedgerEntry,
  HostedAutoCompactionDecision,
  HostedCompactionProvider,
  HostedCompactionResult,
} from "./types.js";

const HOSTED_AUTO_COMPACT_THRESHOLD_RATIO = 0.85;

export function hostedAutoCompactionDecision(input: {
  provider: HostedCompactionProvider;
  model: string;
  messages: HostedChatMessage[];
  maxContextTokens?: number | null;
  triggerPercent?: number;
}): HostedAutoCompactionDecision {
  const hostedProvider = hostedContextProvider(input.provider);
  const maxContextTokens = input.maxContextTokens ?? (hostedProvider ? hostedContextLimit(hostedProvider, input.model) : null);
  if (!maxContextTokens) {
    return {
      shouldCompact: false,
      projectedTokens: estimateHostedMessageTokens(input.messages),
      thresholdTokens: Number.MAX_SAFE_INTEGER,
      usableContextTokens: 0,
      maxContextTokens: 0,
      tokenSource: "heuristic",
    };
  }
  const usableContextTokens = usableHostedContextLimit(maxContextTokens);
  const triggerRatio = Math.max(0.01, Math.min(1, (input.triggerPercent ?? 85) / 100));
  const thresholdTokens = Math.max(1, Math.floor(usableContextTokens * triggerRatio));
  const projectedTokens = estimateHostedMessageTokens(input.messages);
  return {
    shouldCompact: projectedTokens >= thresholdTokens,
    projectedTokens,
    thresholdTokens,
    usableContextTokens,
    maxContextTokens,
    tokenSource: "heuristic",
  };
}

export async function runHostedContextCompaction(input: HostedCompactionInput): Promise<HostedCompactionResult> {
  const model = hostedCompactionModel(input.provider, input.model);
  const maxContextTokens = hostedCompactionContextLimit(input.provider, model, input.maxContextTokens);
  const projectionEvents = eventsForHostedCompaction(input.events);
  const selection = selectEventsForHostedCompaction(projectionEvents, maxContextTokens);
  const { summaryEvents, preservedEvents, preservedEventIds } = selection;
  if (summaryEvents.length === 0) throw new Error("There is not enough prior context to compact.");

  const summaryRecords = normalizeCompactionRecords(summaryEvents);
  const fileLedger = buildFileOperationLedger(normalizeCompactionRecords(projectionEvents));
  const serialized = serializeRecordsForCompaction(summaryRecords, compactionInputCharBudget(maxContextTokens));
  if (!serialized.text.trim()) throw new Error("There is not enough prior context to compact.");

  const messages = buildCompactionSummaryMessages({
    serializedHistory: serialized.text,
    fileLedger,
  });

  const startedAtMs = Date.now();
  const summary = (await streamCompactionSummary({ ...input, model, messages })).trim();
  const durationMs = Date.now() - startedAtMs;
  if (!summary) throw new Error("Compaction summary was empty.");

  const beforeMessages = buildChatMessagesForProvider(input.events, "", "Compaction projection");
  const preservedMessages = buildChatMessagesForProvider(preservedEvents, "", "Compaction projection").slice(1);
  const afterMessages: HostedChatMessage[] = [
    { role: "system", content: "Compaction projection" },
    { role: "system", content: summary },
    ...preservedMessages,
  ];
  const inputTokensBefore = estimateHostedMessageTokens(beforeMessages);
  const inputTokensAfter = estimateHostedMessageTokens(afterMessages);
  const metrics = createCompactionMetrics({
    sourceEvents: projectionEvents.length,
    summarizedEvents: summaryEvents.length,
    preservedEvents: preservedEvents.length,
    summaryInputChars: serialized.inputChars,
    retainedTailTokens: selection.retainedTailTokens,
    retainedTailBudgetTokens: selection.retainedTailBudgetTokens,
    finalProviderContextTokens: inputTokensAfter,
    durationMs,
    fileLedgerEntries: fileLedger.length,
    splitTurnId: selection.splitTurnId,
  });

  return {
    summary,
    model,
    compactedThroughEventId: projectionEvents[projectionEvents.length - 1]?.id ?? null,
    compactedThroughTurnId: lastTurnId(projectionEvents),
    preservedFromEventId: preservedEvents[0]?.id ?? null,
    preservedEventIds,
    preservedResourceRefs: durableResourceRefs(input.events),
    sourceEventCount: summaryEvents.length,
    preservedEventCount: preservedEvents.length,
    fileLedger,
    inputTokensBefore,
    inputTokensAfter,
    maxContextTokens,
    tokenSource: "heuristic",
    metrics,
  };
}

function hostedCompactionModel(provider: ChatProvider, model?: string | null): string {
  if (model?.trim()) return model.trim();
  if (provider !== "openpond") throw new Error(`Context compaction for ${provider} requires a selected model.`);
  return DEFAULT_OPENPOND_CHAT_MODEL;
}

function hostedCompactionContextLimit(
  provider: ChatProvider,
  model: string,
  maxContextTokens: number | null | undefined,
): number {
  if (maxContextTokens) return maxContextTokens;
  const hostedProvider = hostedContextProvider(provider);
  if (hostedProvider) return hostedContextLimit(hostedProvider, model);
  throw new Error(`Context compaction for ${provider} requires a trusted context limit.`);
}

async function streamCompactionSummary(input: HostedCompactionInput & {
  model: string;
  messages: HostedChatMessage[];
}): Promise<string> {
  let text = "";
  const requestId = `compact-${randomUUID()}`;
  const streamCompactionChatTurn = input.streamCompactionChatTurn ?? defaultOpenPondCompactionStream;
  for await (const delta of streamCompactionChatTurn({
    provider: input.provider,
    model: input.model,
    messages: input.messages,
    requestId,
    signal: input.signal,
  })) {
    if (delta.text) text += delta.text;
  }
  return text;
}

const defaultOpenPondCompactionStream: ContextCompactionStream = async function* (input) {
  if (input.provider !== "openpond") {
    throw new Error(`Context compaction stream is not configured for ${input.provider}.`);
  }
  for await (const delta of defaultStreamOpenPondHostedChatTurn({
    model: input.model,
    messages: input.messages,
    requestId: input.requestId,
    signal: input.signal,
  })) {
    if (delta.type === "text_delta" && delta.text) yield { text: delta.text, raw: delta.raw };
    if (delta.type === "reasoning_delta" && delta.text) yield { reasoningText: delta.text, raw: delta.raw };
    if (delta.type === "usage") yield { usage: delta.usage, raw: delta.raw };
  }
};
