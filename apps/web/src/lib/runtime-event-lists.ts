import type { RuntimeEvent } from "@openpond/contracts";

export const MAX_LIVE_RUNTIME_EVENTS = 5_000;

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

export function mergeLiveRuntimeEventLists(
  first: RuntimeEvent[],
  second: RuntimeEvent[],
  limit = MAX_LIVE_RUNTIME_EVENTS,
): RuntimeEvent[] {
  return limitRuntimeEventList(mergeRuntimeEventLists(first, second), limit);
}

export function limitRuntimeEventList(
  events: RuntimeEvent[],
  limit = MAX_LIVE_RUNTIME_EVENTS,
): RuntimeEvent[] {
  if (events.length <= limit) return events;
  return events.slice(events.length - limit);
}

export function mergeRuntimeEventsIntoSessionPageCache(
  current: Record<string, RuntimeEvent[]>,
  sessionId: string,
  pageEvents: RuntimeEvent[],
): Record<string, RuntimeEvent[]> {
  if (pageEvents.length === 0) return current;
  return {
    ...current,
    [sessionId]: mergeRuntimeEventLists(current[sessionId] ?? [], pageEvents),
  };
}

export function mergeBootstrapRuntimeEvents(
  bootstrapEvents: RuntimeEvent[],
  currentEvents: RuntimeEvent[],
): RuntimeEvent[] {
  if (currentEvents.length === 0) return limitRuntimeEventList(bootstrapEvents);
  if (bootstrapEvents.length === 0) return limitRuntimeEventList(currentEvents);

  // Bootstrap only provides a bounded event window. It must augment—not
  // replace—the live stream, otherwise an interrupt followed by bootstrap can
  // collapse a visible transcript to the tail event(s) in that response.
  const eventsById = new Map<string, { event: RuntimeEvent; index: number }>();
  let index = 0;
  for (const event of [...bootstrapEvents, ...currentEvents]) {
    if (!eventsById.has(event.id)) eventsById.set(event.id, { event, index });
    index += 1;
  }
  return limitRuntimeEventList(
    [...eventsById.values()]
      .sort((left, right) => compareRuntimeEventOrder(left, right))
      .map(({ event }) => event),
  );
}

export function latestRuntimeEventSequence(events: RuntimeEvent[]): number | null {
  let latest: number | null = null;
  for (const event of events) {
    if (typeof event.sequence !== "number") continue;
    latest = latest === null ? event.sequence : Math.max(latest, event.sequence);
  }
  return latest;
}

export function oldestRuntimeEventSequence(events: RuntimeEvent[]): number | null {
  let oldest: number | null = null;
  for (const event of events) {
    if (event.sequence === undefined) continue;
    if (oldest === null || event.sequence < oldest) oldest = event.sequence;
  }
  return oldest;
}

function compareRuntimeEventOrder(
  left: { event: RuntimeEvent; index: number },
  right: { event: RuntimeEvent; index: number },
): number {
  const leftSequence = left.event.sequence;
  const rightSequence = right.event.sequence;
  if (typeof leftSequence === "number" && typeof rightSequence === "number") {
    const difference = leftSequence - rightSequence;
    if (difference !== 0) return difference;
  }
  const leftTimestamp = Date.parse(left.event.timestamp);
  const rightTimestamp = Date.parse(right.event.timestamp);
  if (Number.isFinite(leftTimestamp) && Number.isFinite(rightTimestamp)) {
    const difference = leftTimestamp - rightTimestamp;
    if (difference !== 0) return difference;
  }
  return left.index - right.index;
}
