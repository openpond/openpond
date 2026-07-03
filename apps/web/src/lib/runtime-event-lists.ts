import type { RuntimeEvent } from "@openpond/contracts";

export function mergeRuntimeEventLists(first: RuntimeEvent[], second: RuntimeEvent[]): RuntimeEvent[] {
  if (first.length === 0) return second;
  if (second.length === 0) return first;
  const seen = new Set<string>();
  const merged: RuntimeEvent[] = [];
  for (const event of [...first, ...second]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  return merged;
}

export function mergeBootstrapRuntimeEvents(
  bootstrapEvents: RuntimeEvent[],
  currentEvents: RuntimeEvent[],
): RuntimeEvent[] {
  if (currentEvents.length === 0) return bootstrapEvents;
  if (bootstrapEvents.length === 0) return currentEvents;

  const bootstrapEventIds = new Set(bootstrapEvents.map((event) => event.id));
  const latestBootstrapSequence = latestSequence(bootstrapEvents);
  const newestBootstrapTimestamp = newestTimestamp(bootstrapEvents);
  const currentEventsAfterBootstrap = currentEvents.filter((event) => {
    if (bootstrapEventIds.has(event.id)) return false;
    if (typeof event.sequence === "number") {
      return latestBootstrapSequence === null || event.sequence > latestBootstrapSequence;
    }
    const timestamp = Date.parse(event.timestamp);
    if (Number.isFinite(timestamp) && newestBootstrapTimestamp !== null) {
      return timestamp >= newestBootstrapTimestamp;
    }
    return true;
  });

  return mergeRuntimeEventLists(bootstrapEvents, currentEventsAfterBootstrap);
}

function latestSequence(events: RuntimeEvent[]): number | null {
  let latest: number | null = null;
  for (const event of events) {
    if (typeof event.sequence !== "number") continue;
    latest = latest === null ? event.sequence : Math.max(latest, event.sequence);
  }
  return latest;
}

function newestTimestamp(events: RuntimeEvent[]): number | null {
  let newest: number | null = null;
  for (const event of events) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    newest = newest === null ? timestamp : Math.max(newest, timestamp);
  }
  return newest;
}
