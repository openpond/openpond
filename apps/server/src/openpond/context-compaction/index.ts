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
  maxContextTokens?: number | null;
  triggerPercent?: number;
}): HostedAutoCompactionDecision {
  const hostedProvider = hostedContextProvider(input.provider);
  const maxContextTokens = input.maxContextTokens ?? (hostedProvider ? hostedContextLimit(hostedProvider, input.model) : null);
  if (!maxContextTokens) {
    return agentCompactionDecision({
      projectedTokens: estimateHostedMessageTokens(input.messages),
      maxContextTokens: null,
      usableContextTokens: null,
      triggerPercent: input.triggerPercent,
    });
  }
  const usableContextTokens = usableHostedContextLimit(maxContextTokens);
  return agentCompactionDecision({
    projectedTokens: estimateHostedMessageTokens(input.messages),
    usableContextTokens,
    maxContextTokens,
    triggerPercent: input.triggerPercent,
  });
}

export async function runHostedContextCompaction(input: HostedCompactionInput): Promise<HostedCompactionResult> {
  const model = hostedCompactionModel(input.provider, input.model);
  const maxContextTokens = hostedCompactionContextLimit(input.provider, model, input.maxContextTokens);
  return runAgentCompactionProgram({
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
