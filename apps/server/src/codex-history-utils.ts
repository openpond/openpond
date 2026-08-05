import os from "node:os";
import path from "node:path";

export type CodexRecord = {
  arguments?: string;
  call_id?: string;
  content?: unknown;
  id?: string;
  input?: unknown;
  internal_chat_message_metadata_passthrough?: unknown;
  name?: string;
  output?: unknown;
  type?: string;
  role?: string;
  phase?: string;
  record_type?: string;
  timestamp?: string;
  payload?: unknown;
};

export type CodexControlMessage = {
  kind: "goal_context" | "turn_aborted";
  text: string;
};

export function isCodexInjectedUserMessage(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed.startsWith("# AGENTS.md instructions for ")
    || trimmed.startsWith("<environment_context>")
    || trimmed.startsWith("<summary>")
    || trimmed.startsWith("<user_info>")
  );
}

export function codexControlMessage(content: string): CodexControlMessage | null {
  const trimmed = content.trim();
  const match = /^<(goal_context|turn_aborted)>\s*([\s\S]*?)\s*<\/\1>$/.exec(trimmed);
  if (match) {
    const kind = match[1] as CodexControlMessage["kind"];
    return { kind, text: match[2]?.trim() || defaultCodexControlText(kind) };
  }
  if (trimmed === "<turn_aborted>") {
    return { kind: "turn_aborted", text: defaultCodexControlText("turn_aborted") };
  }
  if (trimmed === "<goal_context>") {
    return { kind: "goal_context", text: defaultCodexControlText("goal_context") };
  }
  return null;
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n[truncated ${
    value.length - maxLength
  } characters from Codex history]`;
}

export function normalizeTitleText(value: string): string {
  return value.replace(/[^\S\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export function parseMaybeJson(value: string): unknown | null {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function parseJson(value: string): CodexRecord | null {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value) as CodexRecord;
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringMap(record: Record<string, unknown> | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!record) return map;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.trim()) map.set(key, value.trim());
  }
  return map;
}

export function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 96) || "item";
}

export function latestMillis(values: Array<number | null | undefined>): number {
  let latest = 0;
  for (const value of values) {
    if (typeof value === "number" && value > latest) latest = value;
  }
  return latest;
}

export function latestIso(values: Array<string | null | undefined>): string {
  const latest = latestMillis(values.map(millisFromIso));
  return new Date(latest || Date.now()).toISOString();
}

export function millisFromIso(value: string | null | undefined): number {
  if (!value) return 0;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : 0;
}

export function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().replace(/(\.\d{3})\d+(Z)$/i, "$1$2");
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

export function isoFromEpochSeconds(value: number | null): string | null {
  if (value === null) return null;
  const millis = value * 1000;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

export function isoFromFileName(filePath: string): string | null {
  const match = /rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-/.exec(
    path.basename(filePath),
  );
  if (!match) return null;
  return isoTimestamp(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.000Z`);
}

export function codexHomePath(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

function defaultCodexControlText(kind: CodexControlMessage["kind"]): string {
  return kind === "turn_aborted"
    ? "The previous turn was interrupted."
    : "Goal context updated.";
}
