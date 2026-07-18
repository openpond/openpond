import type { RuntimeEvent } from "@openpond/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function latestReadyLocalCreateImproveProfileRefreshKey(
  events: RuntimeEvent[],
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const runtimeEvent = events[index]!;
    if (runtimeEvent.name !== "create_improve.updated") continue;
    const data = asRecord(runtimeEvent.data);
    const run = asRecord(data?.createImproveRun);
    if (run?.state !== "ready_local" && run?.state !== "released") continue;
    const adapter = asRecord(run.adapter);
    if (adapter?.kind !== "local") continue;

    const runId = text(run.id) ?? runtimeEvent.id;
    return [
      runtimeEvent.sessionId ?? "global",
      runtimeEvent.turnId ?? "turn",
      runId,
    ].join(":");
  }

  return null;
}
