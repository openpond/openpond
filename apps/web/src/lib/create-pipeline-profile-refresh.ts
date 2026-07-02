import type { RuntimeEvent } from "@openpond/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function latestReadyLocalCreatePipelineProfileRefreshKey(
  events: RuntimeEvent[],
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const runtimeEvent = events[index]!;
    if (runtimeEvent.name !== "create_pipeline.updated") continue;
    const data = asRecord(runtimeEvent.data);
    const snapshot = asRecord(data?.createPipeline);
    if (snapshot?.state !== "ready_local") continue;

    const request = asRecord(data?.createPipelineRequest) ?? asRecord(snapshot.request);
    const adapter = asRecord(request?.adapter);
    if (adapter?.kind !== "local") continue;

    const pipelineId = text(snapshot.id) ?? runtimeEvent.id;
    return [
      runtimeEvent.sessionId ?? "global",
      runtimeEvent.turnId ?? "turn",
      pipelineId,
    ].join(":");
  }

  return null;
}
