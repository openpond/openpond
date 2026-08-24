import { randomUUID } from "node:crypto";
import {
  DEFAULT_OPENPOND_CHAT_MODEL,
  type ChatProvider,
} from "@openpond/contracts";
import { streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn } from "@openpond/runtime";
import {
  agentCompactionDecision,
  runAgentCompactionProgram,
} from "@openpond/agent-runtime";
import type { HostedChatMessage, HostedChatTool } from "@openpond/cloud";
import {
  estimateHostedRequestBudget,
  estimateHostedMessageTokens,
  estimateHostedMessageTokensForProvider,
  hostedContextLimit,
  hostedContextProvider,
  hostedRequestedOutputTokens,
  usableHostedContextLimit,
} from "../context-usage.js";
import { buildChatMessagesForProvider } from "../hosted-chat.js";
import { buildContinuationCapsule } from "./continuation-capsule.js";
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


export function hostedAutoCompactionDecision(input: {
  provider: HostedCompactionProvider;
  model: string;
  messages: HostedChatMessage[];
  tools?: readonly HostedChatTool[];
  maxOutputTokens?: number;
  maxContextTokens?: number | null;
  triggerPercent?: number;
}): HostedAutoCompactionDecision {
  const hostedProvider = hostedContextProvider(input.provider);
  const maxContextTokens = input.maxContextTokens ?? (hostedProvider ? hostedContextLimit(hostedProvider, input.model) : null);
  const requestBudget = estimateHostedRequestBudget({
    provider: input.provider,
    model: input.model,
    messages: input.messages,
    tools: input.tools,
    maxOutputTokens: input.maxOutputTokens ?? hostedRequestedOutputTokens({ maxContextTokens }),
    maxContextTokens,
  });
  if (!maxContextTokens) {
    return {
      ...agentCompactionDecision({
        projectedTokens: requestBudget.projectedTokens,
        maxContextTokens: null,
        usableContextTokens: null,
        triggerPercent: input.triggerPercent,
      }),
      requestBudget,
    };
  }
  const usableContextTokens = usableHostedContextLimit(maxContextTokens);
  return {
    ...agentCompactionDecision({
      projectedTokens: requestBudget.projectedTokens,
      usableContextTokens,
      maxContextTokens,
      triggerPercent: input.triggerPercent,
    }),
    requestBudget,
  };
}

export async function runHostedContextCompaction(input: HostedCompactionInput): Promise<HostedCompactionResult> {
  const model = hostedCompactionModel(input.provider, input.model);
  const maxContextTokens = hostedCompactionContextLimit(input.provider, model, input.maxContextTokens);
  const result = await runAgentCompactionProgram({
    events: input.events,
    model,
    maxContextTokens,
    signal: input.signal,
    host: {
      projectEvents: eventsForHostedCompaction,
      selectEvents: selectEventsForHostedCompaction,
      normalizeRecords: normalizeCompactionRecords,
      buildFileLedger: buildFileOperationLedger,
      inputCharBudget: compactionInputCharBudget,
      serializeRecords: serializeRecordsForCompaction,
      buildSummaryMessages: buildCompactionSummaryMessages,
      streamSummary: ({ model: selectedModel, messages, signal }) =>
        streamCompactionSummary({
          ...input,
          model: selectedModel,
          messages,
          signal,
        }),
      estimateProjection: ({ events, preservedEvents, summary }) => {
        const beforeMessages = buildChatMessagesForProvider(
          events,
          "",
          "Compaction projection",
        );
        const preservedMessages = buildChatMessagesForProvider(
          preservedEvents,
          "",
          "Compaction projection",
        ).slice(1);
        const afterMessages: HostedChatMessage[] = [
          { role: "system", content: "Compaction projection" },
          { role: "system", content: summary },
          ...preservedMessages,
        ];
        return {
          inputTokensBefore: estimateHostedMessageTokens(beforeMessages),
          inputTokensAfter: estimateHostedMessageTokens(afterMessages),
        };
      },
      durableResourceRefs,
      lastTurnId,
      createMetrics: createCompactionMetrics,
    },
  });
  const projectionEvents = eventsForHostedCompaction(input.events);
  const continuationCapsule = buildContinuationCapsule({
    session: input.session,
    events: projectionEvents,
    summary: result.summary,
    fileLedger: result.fileLedger,
    preservedResourceRefs: result.preservedResourceRefs,
    compactedThroughEventId: result.compactedThroughEventId,
    compactedThroughTurnId: result.compactedThroughTurnId,
    preservedFromEventId: result.preservedFromEventId,
    preservedEventIds: result.preservedEventIds,
  });
  const projectedMessages = buildChatMessagesForProvider(
    [
      ...projectionEvents,
      {
        id: `compaction-projection-${randomUUID()}`,
        name: "session.compaction.completed",
        data: {
          summary: result.summary,
          continuationCapsule,
          preservedFromEventId: result.preservedFromEventId,
          preservedEventIds: result.preservedEventIds,
          preservedResourceRefs: result.preservedResourceRefs,
        },
      },
    ],
    "",
    "Compaction projection",
  );
  const projectedEstimate = estimateHostedMessageTokensForProvider({
    provider: input.provider,
    model,
    messages: projectedMessages,
  });
  const inputTokensAfter = projectedEstimate.tokens;
  return {
    ...result,
    continuationCapsule,
    inputTokensAfter,
    tokenSource: projectedEstimate.source,
    metrics: {
      ...result.metrics,
      finalProviderContextTokens: inputTokensAfter,
      tokenSource: projectedEstimate.source,
    },
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
