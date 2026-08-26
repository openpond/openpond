import type { ReactNode } from "react";
import type {
  ModelUsageRecord,
  UsageCacheCohortBreakdown,
  UsageCommandBreakdown,
} from "@openpond/contracts";

const integerFormatter = new Intl.NumberFormat("en-US");
const compactNumberFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const percentFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});
const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatInteger(value: number): string { return integerFormatter.format(value); }
export function formatCompactNumber(value: number): string { return compactNumberFormatter.format(value); }
export function formatTokens(value: number | null): string {
  if (value === null) return "missing";
  return value >= 10_000 ? compactNumberFormatter.format(value) : integerFormatter.format(value);
}
export function formatDuration(value: number | null): string {
  if (value === null) return "missing";
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s` : `${integerFormatter.format(Math.round(value))}ms`;
}
export function formatPercent(value: number): string { return `${percentFormatter.format(value * 100)}%`; }
export function formatCacheRate(value: number | null): string { return value === null ? "not reported" : formatPercent(value); }
export function requestCacheLabel(row: ModelUsageRecord): string {
  if (row.cacheTelemetrySource === null) return "not reported";
  if (row.cachedPromptTokens === null || row.uncachedPromptTokens === null) return "reported";
  const total = row.cachedPromptTokens + row.uncachedPromptTokens;
  return total > 0 ? formatPercent(row.cachedPromptTokens / total) : "0%";
}
export function formatShortDate(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : shortDateFormatter.format(date);
}
export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}
export function numericValue(value: number | string | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
export function providerLabel(provider: string): string {
  const known: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", openpond: "OpenPond", openrouter: "OpenRouter", codex: "Codex" };
  return known[provider] ?? titleFromIdentifier(provider);
}
export function routeLabel(route: string): string {
  if (route === "openpond_hosted") return "OpenPond hosted";
  if (route === "local_byok") return "Local BYOK";
  if (route === "codex_app_server") return "Codex app server";
  return "Unknown";
}
export function sourceLabel(source: string): string {
  if (source === "provider_usage") return "Provider usage";
  if (source === "codex_context_usage") return "Codex context";
  if (source === "missing") return "Missing";
  return titleFromIdentifier(source);
}
export function statusLabel(status: string): string { return titleFromIdentifier(status); }
export function commandSourceLabel(source: UsageCommandBreakdown["commandSource"]): string {
  if (!source) return "Unknown source";
  const known: Record<string, string> = { composer_selection: "Composer selection", prompt_parse: "Prompt parse", server_parser: "Server parser", model_tool: "Model tool" };
  return known[source] ?? titleFromIdentifier(source);
}
export function cacheCohortLabel(cohort: UsageCacheCohortBreakdown["cohort"]): string {
  const known: Record<string, string> = { foreground: "Foreground", tool_loop: "Tool loop", compaction: "Compaction", subagent: "Subagent", refiner: "Refiner" };
  return known[cohort] ?? "Other";
}
export function requestKindLabel(kind: string): string {
  const known: Record<string, string> = { chat_turn: "Chat turn", tool_loop: "Tool loop", slash_command: "Slash command", create_improve_planner: "Create/Improve planner", harness_refiner: "Harness Refiner", context_compaction: "Compaction", subagent: "Subagent", codex_context: "Codex context" };
  return known[kind] ?? "Other";
}
export function requestContext(row: ModelUsageRecord): ReactNode {
  if (row.attribution.commandName) return row.attribution.commandName;
  return row.sessionId ? shortId(row.sessionId) : "None";
}
function titleFromIdentifier(value: string): string {
  return value.split("_").filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}
export function shortId(value: string): string { return value.length <= 14 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`; }
