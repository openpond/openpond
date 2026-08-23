import type { RuntimeEvent } from "@openpond/contracts";

export function compactionAtomicGroupId(event?: RuntimeEvent): string | null {
  if (!event) return null;
  const data = asRecord(event.data);
  const value = data?.toolCallId ?? data?.workspaceToolCallId;
  if (typeof value !== "string" || !value.trim()) return null;
  return `${event.turnId ?? "session"}:${value.trim()}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
