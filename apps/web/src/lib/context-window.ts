import {
  ContextUsageSnapshotSchema,
  type ChatProvider,
  type ContextUsageSnapshot,
  type RuntimeEvent,
} from "@openpond/contracts";

export type ContextWindowTone = "low" | "medium" | "high" | "unknown";

export type ContextWindowStatus = {
  usedTokens: number;
  maxTokens: number | null;
  percent: number | null;
  summary: string;
  tokensLabel: string;
  detail: string | null;
  tooltip: string;
  tone: ContextWindowTone;
};

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const value = tokens / 1000;
  if (value >= 10 || Number.isInteger(value)) return `${Math.round(value)}k`;
  return `${value.toFixed(1)}k`;
}

function contextTone(percent: number | null): ContextWindowTone {
  if (percent === null) return "unknown";
  if (percent >= 85) return "high";
  if (percent >= 65) return "medium";
  return "low";
}

export function latestContextUsageFromEvents(events: RuntimeEvent[]): ContextUsageSnapshot | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index];
    if (item?.name !== "session.context.updated") continue;
    const parsed = ContextUsageSnapshotSchema.safeParse(item.data);
    if (parsed.success) return parsed.data;
  }
  return null;
}

export function contextWindowStatusFromUsage(input: {
  provider: ChatProvider;
  snapshot: ContextUsageSnapshot | null;
}): ContextWindowStatus {
  if (input.snapshot && input.snapshot.provider === input.provider) {
    const usedTokens = input.snapshot.usedTokens;
    const maxTokens = input.snapshot.maxContextTokens;
    const percent = Math.min(100, Math.round(input.snapshot.percentFull));
    const summary = `${percent}% full`;
    const tokensLabel = `${formatTokenCount(usedTokens)} / ${formatTokenCount(maxTokens)} tokens used`;

    return {
      usedTokens,
      maxTokens,
      percent,
      summary,
      tokensLabel,
      detail: null,
      tooltip: `Context window: ${summary} ${tokensLabel}.`,
      tone: contextTone(percent),
    };
  }

  if (input.provider === "codex") {
    const detail = "Context is managed by Codex app-server.";
    return {
      usedTokens: 0,
      maxTokens: null,
      percent: null,
      summary: "Managed externally",
      tokensLabel: "Codex app-server",
      detail,
      tooltip: `Context window: ${detail}`,
      tone: "unknown",
    };
  }

  const detail = "Send a message to measure hosted context.";
  return {
    usedTokens: 0,
    maxTokens: null,
    percent: null,
    summary: "Not measured yet",
    tokensLabel: "Hosted context",
    detail,
    tooltip: `Context window: ${detail}`,
    tone: "unknown",
  };
}
