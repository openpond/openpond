import { describe, expect, test, vi } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
import { RuntimeEventStore } from "../apps/web/src/lib/runtime-event-store";

describe("RuntimeEventStore", () => {
  test("routes one batch to exact sessions and preserves unaffected snapshots", () => {
    const store = new RuntimeEventStore({ perSessionLimit: 10, totalLimit: 30 });
    store.append([event("a-1", "a", 1), event("b-1", "b", 2)]);
    const firstA = store.getSessionSnapshot("a");
    const firstB = store.getSessionSnapshot("b");

    const result = store.append([event("a-2", "a", 3), event("a-3", "a", 4)]);

    expect([...result.changedSessionIds]).toEqual(["a"]);
    expect(store.getSessionSnapshot("a")).not.toBe(firstA);
    expect(store.getSessionSnapshot("a").events.map((item) => item.id)).toEqual([
      "a-1",
      "a-2",
      "a-3",
    ]);
    expect(store.getSessionSnapshot("b")).toBe(firstB);
  });

  test("deduplicates reconnect events without notifying subscribers", () => {
    const store = new RuntimeEventStore({ perSessionLimit: 10, totalLimit: 30 });
    const listener = vi.fn();
    store.subscribeSession("a", listener);
    const item = event("a-1", "a", 1);

    expect(store.append([item]).acceptedEventCount).toBe(1);
    expect(store.append([item])).toMatchObject({
      acceptedEventCount: 0,
      duplicateEventCount: 1,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("evicts per session without rebuilding another session", () => {
    const store = new RuntimeEventStore({ perSessionLimit: 3, totalLimit: 9 });
    store.append([event("b-1", "b", 1)]);
    const firstB = store.getSessionSnapshot("b");

    const result = store.append([
      event("a-1", "a", 2),
      event("a-2", "a", 3),
      event("a-3", "a", 4),
      event("a-4", "a", 5),
    ]);

    expect(result.evictedEventCount).toBe(1);
    expect(store.getSessionEvents("a").map((item) => item.id)).toEqual([
      "a-2",
      "a-3",
      "a-4",
    ]);
    expect(store.getSessionSnapshot("b")).toBe(firstB);
  });

  test("enforces a total bound by evicting the least recently touched unretained session", () => {
    const store = new RuntimeEventStore({ perSessionLimit: 3, totalLimit: 4 });
    store.append([event("a-1", "a", 1), event("a-2", "a", 2)]);
    store.append([event("b-1", "b", 3), event("b-2", "b", 4)]);
    store.retainSession("b");

    const result = store.append([event("c-1", "c", 5)]);

    expect(result.changedSessionIds).toEqual(new Set(["c", "a"]));
    expect(store.getSessionEvents("a")).toEqual([]);
    expect(store.getSessionEvents("b")).toHaveLength(2);
    expect(store.getStats().eventCount).toBeLessThanOrEqual(4);
  });

  test("retains a visible session even when it is pinned before its first event", () => {
    const store = new RuntimeEventStore({ perSessionLimit: 2, totalLimit: 3 });
    store.retainSession("visible");
    store.append([event("visible-1", "visible", 1), event("visible-2", "visible", 2)]);
    store.append([event("background-1", "background", 3), event("background-2", "background", 4)]);

    expect(store.getSessionEvents("visible")).toHaveLength(2);
    expect(store.getStats().retainedSessionCount).toBe(1);

    store.clear();
    store.append([event("visible-3", "visible", 5)]);
    expect(store.getStats().retainedSessionCount).toBe(1);
  });

  test("merges bootstrap history with newer live catch-up events", () => {
    const store = new RuntimeEventStore({ perSessionLimit: 10, totalLimit: 30 });
    store.append([event("live-3", "a", 3), event("live-4", "a", 4)]);

    store.mergeBootstrap([
      event("bootstrap-1", "a", 1),
      event("bootstrap-2", "a", 2),
      event("live-3", "a", 3),
    ]);

    expect(store.getSessionEvents("a").map((item) => item.id)).toEqual([
      "bootstrap-1",
      "bootstrap-2",
      "live-3",
      "live-4",
    ]);
  });

  test("keeps a stable all-events snapshot until the store changes", () => {
    const store = new RuntimeEventStore({ perSessionLimit: 10, totalLimit: 30 });
    store.append([event("b-2", "b", 2), event("a-1", "a", 1)]);

    const first = store.getAllEvents();
    expect(store.getAllEvents()).toBe(first);
    expect(first.map((item) => item.id)).toEqual(["a-1", "b-2"]);

    store.append([event("a-3", "a", 3)]);
    expect(store.getAllEvents()).not.toBe(first);
  });

  test("does not invalidate global summary consumers for transcript-only deltas", () => {
    const store = new RuntimeEventStore({ perSessionLimit: 10, totalLimit: 30 });
    const listener = vi.fn();
    store.subscribeSummary(listener);

    store.append([event("delta-1", "a", 1)]);
    expect(listener).not.toHaveBeenCalled();
    const firstSummary = store.getSummaryEvents();

    store.append([{ ...event("completed-2", "a", 2), name: "turn.completed" }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSummaryEvents()).not.toBe(firstSummary);
  });

  test("invalidates summary consumers when a semantic event leaves a session ring", () => {
    const store = new RuntimeEventStore({ perSessionLimit: 2, totalLimit: 4 });
    const listener = vi.fn();
    store.append([
      { ...event("started-1", "a", 1), name: "turn.started" },
      event("delta-2", "a", 2),
    ]);
    store.getSummaryEvents();
    store.subscribeSummary(listener);

    store.append([event("delta-3", "a", 3)]);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSummaryEvents().map((item) => item.id)).toEqual([
      "delta-2",
      "delta-3",
    ]);
  });
});

function event(id: string, sessionId: string, sequence: number): RuntimeEvent {
  return {
    id,
    sessionId,
    sequence,
    timestamp: new Date(1_750_000_000_000 + sequence).toISOString(),
    name: "assistant.delta",
    source: "provider",
    output: id,
  } as RuntimeEvent;
}
