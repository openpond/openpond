import { randomUUID } from "node:crypto";
import {
  DEFAULT_OPENPOND_CHAT_MODEL,
  type ChatProvider,
  type RuntimeEvent,
  type Session,
} from "@openpond/contracts";
import { streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn } from "@openpond/runtime";
import type { HostedChatMessage } from "@openpond/cloud";
import { formatPromptWithAttachmentContext } from "../chat-attachments.js";
import {
  estimateHostedMessageTokens,
  hostedContextLimit,
  hostedContextProvider,
  usableHostedContextLimit,
} from "./context-usage.js";
import { buildChatMessagesForProvider } from "./hosted-chat.js";
import { textFromUnknown } from "../utils.js";

export type HostedCompactionProvider = ChatProvider;

export type ContextCompactionStreamDelta = {
  text?: string;
  reasoningText?: string;
  usage?: unknown;
  raw?: unknown;
};

export type ContextCompactionStream = (input: {
  provider: ChatProvider;
  model: string;
  messages: HostedChatMessage[];
  requestId: string;
  signal?: AbortSignal;
}) => AsyncGenerator<ContextCompactionStreamDelta, void, unknown>;

export type HostedCompactionResult = {
  summary: string;
  model: string;
  compactedThroughEventId: string | null;
  compactedThroughTurnId: string | null;
  preservedFromEventId: string | null;
  preservedResourceRefs: string[];
  sourceEventCount: number;
  preservedEventCount: number;
  inputTokensBefore: number;
  inputTokensAfter: number;
  maxContextTokens: number;
  tokenSource: "heuristic";
};

export type HostedAutoCompactionDecision = {
  shouldCompact: boolean;
  projectedTokens: number;
  thresholdTokens: number;
  usableContextTokens: number;
  maxContextTokens: number;
  tokenSource: "heuristic";
};

type HostedCompactionInput = {
  session: Session;
  events: RuntimeEvent[];
  provider: HostedCompactionProvider;
  model?: string | null;
  maxContextTokens?: number | null;
  signal?: AbortSignal;
  streamCompactionChatTurn?: ContextCompactionStream;
};

const HOSTED_AUTO_COMPACT_THRESHOLD_RATIO = 0.85;
const MAX_SERIALIZED_EVENT_CHARS = 6_000;
const MAX_COMPACTION_INPUT_CHARS = 180_000;
const MIN_COMPACTION_INPUT_CHARS = 12_000;
const COMPACTION_INPUT_CHARS_PER_CONTEXT_TOKEN = 3;

const COMPACTION_SYSTEM_PROMPT = [
  "You compact conversation history for OpenPond App.",
  "Write a concise continuation summary that preserves everything needed for future turns.",
  "Preserve exact user goals, constraints, decisions, file paths, app ids, branch names, command names, errors, tool outcomes, and pending work.",
  "Remove stale or contradicted details. Do not claim work is complete unless the transcript supports it.",
  "Do not mention that compaction happened.",
  "Use terse markdown bullets under these headings: Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps, Critical Context, Relevant Files.",
].join("\n");

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
  const { summaryEvents, preservedEvents } = splitEventsForHostedCompaction(projectionEvents);
  if (summaryEvents.length === 0) throw new Error("There is not enough prior context to compact.");

  const serialized = serializeEventsForCompaction(summaryEvents, compactionInputCharBudget(maxContextTokens));
  if (!serialized.trim()) throw new Error("There is not enough prior context to compact.");

  const messages: HostedChatMessage[] = [
    { role: "system", content: COMPACTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        "Compact the following OpenPond App transcript into a durable continuation summary.",
        "The recent tail that remains outside the summary is not included here.",
        "",
        serialized,
      ].join("\n"),
    },
  ];

  const summary = (await streamCompactionSummary({ ...input, model, messages })).trim();
  if (!summary) throw new Error("Compaction summary was empty.");

  const beforeMessages = buildChatMessagesForProvider(input.events, "", "Compaction projection");
  const preservedMessages = buildChatMessagesForProvider(preservedEvents, "", "Compaction projection").slice(1);
  const afterMessages: HostedChatMessage[] = [
    { role: "system", content: "Compaction projection" },
    { role: "system", content: summary },
    ...preservedMessages,
  ];

  return {
    summary,
    model,
    compactedThroughEventId: summaryEvents[summaryEvents.length - 1]?.id ?? null,
    compactedThroughTurnId: lastTurnId(summaryEvents),
    preservedFromEventId: preservedEvents[0]?.id ?? null,
    preservedResourceRefs: durableResourceRefs(input.events),
    sourceEventCount: summaryEvents.length,
    preservedEventCount: preservedEvents.length,
    inputTokensBefore: estimateHostedMessageTokens(beforeMessages),
    inputTokensAfter: estimateHostedMessageTokens(afterMessages),
    maxContextTokens,
    tokenSource: "heuristic",
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

function compactionInputCharBudget(maxContextTokens: number): number {
  return Math.min(
    MAX_COMPACTION_INPUT_CHARS,
    Math.max(MIN_COMPACTION_INPUT_CHARS, Math.floor(maxContextTokens * COMPACTION_INPUT_CHARS_PER_CONTEXT_TOKEN)),
  );
}

function splitEventsForHostedCompaction(events: RuntimeEvent[]): {
  summaryEvents: RuntimeEvent[];
  preservedEvents: RuntimeEvent[];
} {
  const turnStartIndexes = events
    .map((item, index) => (item.name === "turn.started" ? index : -1))
    .filter((index) => index >= 0);
  const preserveTurnCount = turnStartIndexes.length >= 3 ? 2 : turnStartIndexes.length === 2 ? 1 : 0;
  const preserveStartIndex =
    preserveTurnCount > 0 ? turnStartIndexes[turnStartIndexes.length - preserveTurnCount]! : events.length;
  return {
    summaryEvents: events.slice(0, preserveStartIndex),
    preservedEvents: events.slice(preserveStartIndex),
  };
}

function eventsForHostedCompaction(events: RuntimeEvent[]): RuntimeEvent[] {
  const compacted = latestCompletedCompaction(events);
  if (!compacted) return events;
  const preservedIndex = compacted.preservedFromEventId
    ? events.findIndex((item) => item.id === compacted.preservedFromEventId)
    : -1;
  const replayStart = preservedIndex >= 0 && preservedIndex < compacted.index ? preservedIndex : compacted.index + 1;
  return [compacted.event, ...events.slice(replayStart, compacted.index), ...events.slice(compacted.index + 1)];
}

function latestCompletedCompaction(events: RuntimeEvent[]): {
  event: RuntimeEvent;
  index: number;
  preservedFromEventId: string | null;
} | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index]!;
    if (item.name !== "session.compaction.completed" || !summaryFromCompactionEvent(item)) continue;
    return {
      event: item,
      index,
      preservedFromEventId: preservedFromCompactionEvent(item),
    };
  }
  return null;
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

function serializeEventsForCompaction(events: RuntimeEvent[], maxInputChars: number): string {
  const lines: string[] = [];
  let totalChars = 0;

  function append(block: string): void {
    if (!block.trim() || totalChars >= maxInputChars) return;
    const remaining = maxInputChars - totalChars;
    const value = block.length > remaining ? `${block.slice(0, Math.max(0, remaining - 32))}\n[compaction input truncated]` : block;
    lines.push(value);
    totalChars += value.length;
  }

  for (const item of events) {
    if (item.name === "session.context.updated" || item.name === "session.compaction.started") continue;
    if (item.name === "session.compaction.failed") continue;
    if (item.name === "session.compaction.completed") {
      const summary = summaryFromCompactionEvent(item);
      if (summary) append(section("Previous Summary", summary));
      continue;
    }
    if (item.name === "turn.started") {
      const prompt = typeof item.args?.prompt === "string" ? item.args.prompt : "";
      const attachmentContext =
        typeof item.args?.attachmentContext === "string" ? item.args.attachmentContext : "";
      append(section("User", formatPromptWithAttachmentContext(prompt, attachmentContext), item));
      continue;
    }
    if (item.name === "assistant.delta") {
      append(section("Assistant", item.output ?? "", item));
      continue;
    }
    if (item.name === "workspace_action" || item.name === "workspace_action_result") {
      append(section("Workspace Activity", eventPreview(item), item));
      continue;
    }
    if (item.name === "tool.started" || item.name === "tool.completed" || item.name === "command.output") {
      append(section("Tool Activity", eventPreview(item), item));
      continue;
    }
    if (isGoalContextEvent(item)) {
      append(section("Goal Context", goalContextPreview(item), item));
      continue;
    }
    if (item.name === "turn.failed") {
      append(section("Turn Failed", item.error ?? item.output ?? "", item));
      continue;
    }
    if (item.name === "diagnostic") continue;
    append(section(item.name, eventPreview(item), item));
  }

  return lines.join("\n\n");
}

function section(title: string, body: string, event?: RuntimeEvent): string {
  const metadata = event
    ? [
        event.turnId ? `turn=${event.turnId}` : null,
        event.action ? `action=${event.action}` : null,
        event.status ? `status=${event.status}` : null,
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const prefix = metadata ? `### ${title} (${metadata})` : `### ${title}`;
  return `${prefix}\n${truncate(body.trim() || eventPreview(event), MAX_SERIALIZED_EVENT_CHARS)}`;
}

function eventPreview(event?: RuntimeEvent): string {
  if (!event) return "";
  const parts = [event.output, event.error, event.action, event.data ? textFromUnknown(event.data) : null].filter(
    (value): value is string => Boolean(value)
  );
  return parts.join("\n");
}

function isGoalContextEvent(event: RuntimeEvent): boolean {
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return false;
  const kind = (event.data as { kind?: unknown }).kind;
  return kind === "goal_context" || kind === "thread_goal";
}

function goalContextPreview(event: RuntimeEvent): string {
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return event.output ?? "";
  const data = event.data as Record<string, unknown>;
  const ref = event.id ? `goal-context:${event.id}` : null;
  return [ref ? `ref: ${ref}` : null, event.output, textFromUnknown(data)].filter(Boolean).join("\n");
}

function durableResourceRefs(events: RuntimeEvent[]): string[] {
  const refs = new Set<string>();
  for (const item of events) {
    if (isGoalContextEvent(item) && item.id) refs.add(`goal-context:${item.id}`);
    collectResourceRefs(item.data, refs);
    collectResourceRefs(item.args, refs);
  }
  return [...refs].slice(0, 100);
}

function collectResourceRefs(value: unknown, refs: Set<string>): void {
  if (!value) return;
  if (typeof value === "string") {
    if (isDurableResourceRef(value)) refs.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectResourceRefs(item, refs);
    return;
  }
  if (typeof value !== "object") return;
  for (const child of Object.values(value as Record<string, unknown>)) {
    collectResourceRefs(child, refs);
  }
}

function isDurableResourceRef(value: string): boolean {
  return /^(workspace:(?:file|dir):|sandbox:(?:file|dir):|git:|event:|message:|artifact:|goal-context:)/.test(value);
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n[truncated]` : value;
}

function summaryFromCompactionEvent(event: RuntimeEvent): string | null {
  if (!event.data || typeof event.data !== "object") return null;
  const summary = (event.data as { summary?: unknown }).summary;
  return typeof summary === "string" && summary.trim() ? summary.trim() : null;
}

function preservedFromCompactionEvent(event: RuntimeEvent): string | null {
  if (!event.data || typeof event.data !== "object") return null;
  const preservedFromEventId = (event.data as { preservedFromEventId?: unknown }).preservedFromEventId;
  return typeof preservedFromEventId === "string" && preservedFromEventId.trim() ? preservedFromEventId : null;
}

function lastTurnId(events: RuntimeEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const turnId = events[index]?.turnId;
    if (turnId) return turnId;
  }
  return null;
}
