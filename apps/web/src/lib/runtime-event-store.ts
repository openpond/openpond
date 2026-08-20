import type { RuntimeEvent } from "@openpond/contracts";
import {
  MAX_LIVE_RUNTIME_EVENTS,
  latestRuntimeEventSequence,
  mergeBootstrapRuntimeEvents,
} from "./runtime-event-lists";

export const DEFAULT_RUNTIME_EVENT_TOTAL_LIMIT = 50_000;
const UNSCOPED_RUNTIME_EVENT_KEY = "\u0000openpond-unscoped-runtime-events";
const EMPTY_RUNTIME_EVENTS: RuntimeEvent[] = [];

export type SessionRuntimeEventSnapshot = {
  events: RuntimeEvent[];
  latestSequence: number | null;
  revision: number;
};

export type RuntimeEventStoreAppendResult = {
  acceptedEventCount: number;
  duplicateEventCount: number;
  evictedEventCount: number;
  changedSessionIds: ReadonlySet<string>;
  unscopedEventsChanged: boolean;
};

export type RuntimeEventStoreStats = {
  eventCount: number;
  retainedSessionCount: number;
  sessionCount: number;
  perSessionLimit: number;
  totalLimit: number;
};

type SessionEntry = {
  eventIds: Set<string>;
  lastTouched: number;
  retained: boolean;
  snapshot: SessionRuntimeEventSnapshot;
};

type Listener = () => void;

export class RuntimeEventStore {
  readonly perSessionLimit: number;
  readonly totalLimit: number;

  private readonly entries = new Map<string, SessionEntry>();
  private readonly eventKeyById = new Map<string, string>();
  private readonly listenersByKey = new Map<string, Set<Listener>>();
  private readonly allListeners = new Set<Listener>();
  private readonly summaryListeners = new Set<Listener>();
  private readonly retainedKeys = new Set<string>();
  private allEventsSnapshot: RuntimeEvent[] | null = EMPTY_RUNTIME_EVENTS;
  private summaryEventsSnapshot: RuntimeEvent[] | null = EMPTY_RUNTIME_EVENTS;
  private clock = 0;
  private eventCount = 0;

  constructor(options: {
    perSessionLimit?: number;
    totalLimit?: number;
  } = {}) {
    this.perSessionLimit = positiveInteger(
      options.perSessionLimit ?? MAX_LIVE_RUNTIME_EVENTS,
      "perSessionLimit",
    );
    this.totalLimit = positiveInteger(
      options.totalLimit ?? DEFAULT_RUNTIME_EVENT_TOTAL_LIMIT,
      "totalLimit",
    );
    if (this.totalLimit < this.perSessionLimit) {
      throw new Error("totalLimit must be greater than or equal to perSessionLimit");
    }
  }

  append(events: readonly RuntimeEvent[]): RuntimeEventStoreAppendResult {
    if (events.length === 0) return emptyAppendResult();

    const pendingByKey = new Map<string, RuntimeEvent[]>();
    let duplicateEventCount = 0;
    for (const event of events) {
      if (this.eventKeyById.has(event.id)) {
        duplicateEventCount += 1;
        continue;
      }
      const key = event.sessionId || UNSCOPED_RUNTIME_EVENT_KEY;
      const pending = pendingByKey.get(key);
      if (pending) pending.push(event);
      else pendingByKey.set(key, [event]);
      this.eventKeyById.set(event.id, key);
    }
    if (pendingByKey.size === 0) {
      return {
        ...emptyAppendResult(),
        duplicateEventCount,
      };
    }

    const changedKeys = new Set<string>();
    let acceptedEventCount = 0;
    let evictedEventCount = 0;
    let summaryChanged = false;
    for (const [key, pending] of pendingByKey) {
      if (pending.some(isRuntimeSummaryEvent)) summaryChanged = true;
      const current = this.entries.get(key);
      const currentEvents = current?.snapshot.events ?? EMPTY_RUNTIME_EVENTS;
      const keepCurrentCount = Math.max(
        0,
        Math.min(currentEvents.length, this.perSessionLimit - pending.length),
      );
      const acceptedPending =
        pending.length > this.perSessionLimit
          ? pending.slice(pending.length - this.perSessionLimit)
          : pending;
      const retainedCurrent =
        keepCurrentCount === currentEvents.length
          ? currentEvents
          : currentEvents.slice(currentEvents.length - keepCurrentCount);
      const nextEvents =
        retainedCurrent.length === 0
          ? acceptedPending
          : [...retainedCurrent, ...acceptedPending];
      const removedEvents = currentEvents.slice(
        0,
        currentEvents.length - retainedCurrent.length,
      );
      if (removedEvents.some(isRuntimeSummaryEvent)) summaryChanged = true;
      for (const event of removedEvents) this.eventKeyById.delete(event.id);
      for (const event of pending.slice(0, pending.length - acceptedPending.length)) {
        this.eventKeyById.delete(event.id);
      }
      const nextEventIds = new Set(nextEvents.map((event) => event.id));
      const nextEntry: SessionEntry = {
        eventIds: nextEventIds,
        lastTouched: ++this.clock,
        retained: current?.retained ?? this.retainedKeys.has(key),
        snapshot: {
          events: nextEvents,
          latestSequence: latestRuntimeEventSequence(nextEvents),
          revision: (current?.snapshot.revision ?? 0) + 1,
        },
      };
      this.entries.set(key, nextEntry);
      this.eventCount += nextEvents.length - currentEvents.length;
      acceptedEventCount += acceptedPending.length;
      evictedEventCount += removedEvents.length + pending.length - acceptedPending.length;
      changedKeys.add(key);
    }

    const totalLimitEvictions = this.enforceTotalLimit(changedKeys);
    evictedEventCount += totalLimitEvictions;
    this.publish(changedKeys, summaryChanged || totalLimitEvictions > 0);
    return appendResult({
      acceptedEventCount,
      duplicateEventCount,
      evictedEventCount,
      changedKeys,
    });
  }

  mergeBootstrap(events: readonly RuntimeEvent[]): RuntimeEventStoreAppendResult {
    const bootstrapByKey = partitionEvents(events);
    const keys = new Set([...this.entries.keys(), ...bootstrapByKey.keys()]);
    const nextEvents: RuntimeEvent[] = [];
    for (const key of keys) {
      const bootstrapEvents = bootstrapByKey.get(key) ?? EMPTY_RUNTIME_EVENTS;
      const currentEvents = this.entries.get(key)?.snapshot.events ?? EMPTY_RUNTIME_EVENTS;
      nextEvents.push(...mergeBootstrapRuntimeEvents(bootstrapEvents, currentEvents));
    }
    return this.replace(nextEvents);
  }

  replace(events: readonly RuntimeEvent[]): RuntimeEventStoreAppendResult {
    const previousIds = new Set(this.eventKeyById.keys());
    const previousKeys = new Set(this.entries.keys());
    this.entries.clear();
    this.eventKeyById.clear();
    this.eventCount = 0;
    this.allEventsSnapshot = EMPTY_RUNTIME_EVENTS;
    this.summaryEventsSnapshot = EMPTY_RUNTIME_EVENTS;

    const result = this.append(events);
    for (const key of this.retainedKeys) {
      const entry = this.entries.get(key);
      if (entry) entry.retained = true;
    }
    const nextIds = this.eventKeyById;
    let removedCount = 0;
    for (const id of previousIds) {
      if (!nextIds.has(id)) removedCount += 1;
    }
    const removedKeys = new Set(
      [...previousKeys].filter((key) => !this.entries.has(key)),
    );
    if (removedKeys.size > 0) this.publish(removedKeys, true);
    return {
      ...result,
      evictedEventCount: result.evictedEventCount + removedCount,
      changedSessionIds: new Set([
        ...result.changedSessionIds,
        ...[...removedKeys].filter((key) => key !== UNSCOPED_RUNTIME_EVENT_KEY),
      ]),
      unscopedEventsChanged:
        result.unscopedEventsChanged || removedKeys.has(UNSCOPED_RUNTIME_EVENT_KEY),
    };
  }

  clear(): void {
    if (this.entries.size === 0) return;
    const changedKeys = new Set(this.entries.keys());
    this.entries.clear();
    this.eventKeyById.clear();
    this.eventCount = 0;
    this.allEventsSnapshot = EMPTY_RUNTIME_EVENTS;
    this.summaryEventsSnapshot = EMPTY_RUNTIME_EVENTS;
    this.publish(changedKeys, true);
  }

  retainSession(sessionId: string, retained = true): void {
    if (retained) this.retainedKeys.add(sessionId);
    else this.retainedKeys.delete(sessionId);
    const entry = this.entries.get(sessionId);
    if (entry) entry.retained = retained;
  }

  getSessionSnapshot = (sessionId: string | null): SessionRuntimeEventSnapshot => {
    if (!sessionId) return emptySessionSnapshot;
    return this.entries.get(sessionId)?.snapshot ?? emptySessionSnapshot;
  };

  getSessionEvents(sessionId: string | null): RuntimeEvent[] {
    return this.getSessionSnapshot(sessionId).events;
  }

  getAllEvents = (): RuntimeEvent[] => {
    if (this.allEventsSnapshot) return this.allEventsSnapshot;
    const events = [...this.entries.values()].flatMap((entry) => entry.snapshot.events);
    events.sort(compareRuntimeEvents);
    this.allEventsSnapshot = events;
    return events;
  };

  getSummaryEvents = (): RuntimeEvent[] => {
    if (this.summaryEventsSnapshot) return this.summaryEventsSnapshot;
    this.summaryEventsSnapshot = this.getAllEvents();
    return this.summaryEventsSnapshot;
  };

  getStats(): RuntimeEventStoreStats {
    let retainedSessionCount = 0;
    for (const [key, entry] of this.entries) {
      if (key !== UNSCOPED_RUNTIME_EVENT_KEY && entry.retained) retainedSessionCount += 1;
    }
    return {
      eventCount: this.eventCount,
      retainedSessionCount,
      sessionCount:
        this.entries.size - (this.entries.has(UNSCOPED_RUNTIME_EVENT_KEY) ? 1 : 0),
      perSessionLimit: this.perSessionLimit,
      totalLimit: this.totalLimit,
    };
  }

  subscribeAll = (listener: Listener): (() => void) => {
    this.allListeners.add(listener);
    return () => this.allListeners.delete(listener);
  };

  subscribeSummary = (listener: Listener): (() => void) => {
    this.summaryListeners.add(listener);
    return () => this.summaryListeners.delete(listener);
  };

  subscribeSession(sessionId: string, listener: Listener): () => void {
    let listeners = this.listenersByKey.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.listenersByKey.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listenersByKey.delete(sessionId);
    };
  }

  private enforceTotalLimit(changedKeys: Set<string>): number {
    let evictedCount = 0;
    while (this.eventCount > this.totalLimit && this.entries.size > 0) {
      const candidate = this.oldestEvictionCandidate(false) ?? this.oldestEvictionCandidate(true);
      if (!candidate) break;
      const [key, entry] = candidate;
      const overflow = this.eventCount - this.totalLimit;
      if (!entry.retained || entry.snapshot.events.length <= overflow) {
        evictedCount += entry.snapshot.events.length;
        this.removeEntry(key);
        changedKeys.add(key);
        continue;
      }
      const removed = entry.snapshot.events.slice(0, overflow);
      const events = entry.snapshot.events.slice(overflow);
      for (const event of removed) this.eventKeyById.delete(event.id);
      entry.eventIds = new Set(events.map((event) => event.id));
      entry.snapshot = {
        events,
        latestSequence: latestRuntimeEventSequence(events),
        revision: entry.snapshot.revision + 1,
      };
      this.eventCount -= removed.length;
      evictedCount += removed.length;
      changedKeys.add(key);
    }
    return evictedCount;
  }

  private oldestEvictionCandidate(includeRetained: boolean): [string, SessionEntry] | null {
    let candidate: [string, SessionEntry] | null = null;
    for (const entry of this.entries) {
      if (!includeRetained && entry[1].retained) continue;
      if (!candidate || entry[1].lastTouched < candidate[1].lastTouched) candidate = entry;
    }
    return candidate;
  }

  private removeEntry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    for (const event of entry.snapshot.events) this.eventKeyById.delete(event.id);
    this.eventCount -= entry.snapshot.events.length;
    this.entries.delete(key);
  }

  private publish(changedKeys: ReadonlySet<string>, summaryChanged = false): void {
    if (changedKeys.size === 0) return;
    this.allEventsSnapshot = null;
    if (summaryChanged) this.summaryEventsSnapshot = null;
    for (const key of changedKeys) {
      for (const listener of this.listenersByKey.get(key) ?? []) listener();
    }
    for (const listener of this.allListeners) listener();
    if (summaryChanged) {
      for (const listener of this.summaryListeners) listener();
    }
  }
}

const emptySessionSnapshot: SessionRuntimeEventSnapshot = Object.freeze({
  events: EMPTY_RUNTIME_EVENTS,
  latestSequence: null,
  revision: 0,
});

function partitionEvents(events: readonly RuntimeEvent[]): Map<string, RuntimeEvent[]> {
  const eventsByKey = new Map<string, RuntimeEvent[]>();
  for (const event of events) {
    const key = event.sessionId || UNSCOPED_RUNTIME_EVENT_KEY;
    const current = eventsByKey.get(key);
    if (current) current.push(event);
    else eventsByKey.set(key, [event]);
  }
  return eventsByKey;
}

function appendResult(input: {
  acceptedEventCount: number;
  duplicateEventCount: number;
  evictedEventCount: number;
  changedKeys: ReadonlySet<string>;
}): RuntimeEventStoreAppendResult {
  return {
    acceptedEventCount: input.acceptedEventCount,
    duplicateEventCount: input.duplicateEventCount,
    evictedEventCount: input.evictedEventCount,
    changedSessionIds: new Set(
      [...input.changedKeys].filter((key) => key !== UNSCOPED_RUNTIME_EVENT_KEY),
    ),
    unscopedEventsChanged: input.changedKeys.has(UNSCOPED_RUNTIME_EVENT_KEY),
  };
}

function emptyAppendResult(): RuntimeEventStoreAppendResult {
  return {
    acceptedEventCount: 0,
    duplicateEventCount: 0,
    evictedEventCount: 0,
    changedSessionIds: new Set(),
    unscopedEventsChanged: false,
  };
}

function compareRuntimeEvents(left: RuntimeEvent, right: RuntimeEvent): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    return left.sequence - right.sequence;
  }
  const timestampDifference = Date.parse(left.timestamp) - Date.parse(right.timestamp);
  if (Number.isFinite(timestampDifference) && timestampDifference !== 0) return timestampDifference;
  return left.id.localeCompare(right.id);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

export function isRuntimeSummaryEvent(event: RuntimeEvent): boolean {
  return event.name !== "assistant.delta" &&
    event.name !== "assistant.reasoning.delta" &&
    event.name !== "command.output";
}
