import { describe, expect, test } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
import {
  latestRuntimeEventSequence,
  MAX_LIVE_RUNTIME_EVENTS,
  mergeBootstrapRuntimeEvents,
  mergeLiveRuntimeEventLists,
  mergeRuntimeEventsIntoSessionPageCache,
  mergeRuntimeEventLists,
} from "../apps/web/src/lib/runtime-event-lists";

describe("runtime event list merging", () => {
  test("dedupes events while preserving first-list precedence", () => {
    const first = [runtimeEvent("one", 1), runtimeEvent("two", 2, { output: "from bootstrap" })];
    const second = [runtimeEvent("two", undefined, { output: "from stream" }), runtimeEvent("three")];

    expect(mergeRuntimeEventLists(first, second)).toEqual([
      first[0],
      first[1],
      second[1],
    ]);
  });

  test("preserves stream events that are newer than a stale bootstrap window", () => {
    const bootstrapEvents = [
      runtimeEvent("session-started", 10, { timestamp: "2026-07-01T10:00:00.000Z" }),
      runtimeEvent("turn-started", 11, { timestamp: "2026-07-01T10:00:01.000Z" }),
    ];
    const streamOnlyEvent = runtimeEvent("assistant-delta", undefined, {
      timestamp: "2026-07-01T10:00:01.000Z",
      name: "assistant.delta",
      output: "Hello",
    });
    const currentEvents = [
      runtimeEvent("older-stream-event", undefined, {
        timestamp: "2026-07-01T09:59:59.000Z",
      }),
      bootstrapEvents[1]!,
      streamOnlyEvent,
    ];

    expect(mergeBootstrapRuntimeEvents(bootstrapEvents, currentEvents)).toEqual([
      bootstrapEvents[0],
      bootstrapEvents[1],
      streamOnlyEvent,
    ]);
  });

  test("returns the newest available sequence from a sparse event list", () => {
    expect(latestRuntimeEventSequence([
      runtimeEvent("one", 10),
      runtimeEvent("stream-only"),
      runtimeEvent("two", 12),
      runtimeEvent("older", 11),
    ])).toBe(12);
  });

  test("keeps forward-fetched selected session events in the session page cache", () => {
    const selectedSessionId = "session_1";
    const otherSessionId = "session_2";
    const selectedBootstrapEvent = runtimeEvent("selected-bootstrap", 10, {
      sessionId: selectedSessionId,
      name: "workspace_action",
      action: "sandbox_preserve_source",
      status: "started",
    });
    const globalTailEvent = runtimeEvent("other-session-tail", 50, {
      sessionId: otherSessionId,
    });
    const forwardSelectedEvent = runtimeEvent("selected-apply-result", 20, {
      sessionId: selectedSessionId,
      name: "workspace_action_result",
      action: "sandbox_git_apply_patch_local",
      status: "completed",
      output: "Applied sandbox patch locally.",
    });

    const cache = mergeRuntimeEventsIntoSessionPageCache(
      {},
      selectedSessionId,
      [forwardSelectedEvent],
    );
    const refreshedRuntimeEvents = mergeBootstrapRuntimeEvents(
      [selectedBootstrapEvent, globalTailEvent],
      [selectedBootstrapEvent, globalTailEvent, forwardSelectedEvent],
    );
    const refreshedSelectedEvents = refreshedRuntimeEvents.filter(
      (event) => event.sessionId === selectedSessionId,
    );

    expect(refreshedSelectedEvents.map((event) => event.id)).toEqual(["selected-bootstrap"]);
    expect(mergeRuntimeEventLists(cache[selectedSessionId] ?? [], refreshedSelectedEvents).map((event) => event.id)).toEqual([
      "selected-apply-result",
      "selected-bootstrap",
    ]);
  });

  test("bounds the live projection while retaining the newest sequence window", () => {
    const events = Array.from(
      { length: 100_000 },
      (_, index) => runtimeEvent(`event-${index + 1}`, index + 1),
    );
    let merged: RuntimeEvent[] = [];
    for (let index = 0; index < events.length; index += 1_000) {
      merged = mergeLiveRuntimeEventLists(merged, events.slice(index, index + 1_000));
    }
    expect(merged).toHaveLength(MAX_LIVE_RUNTIME_EVENTS);
    expect(merged[0]?.sequence).toBe(95_001);
    expect(merged.at(-1)?.sequence).toBe(100_000);
  });

  test("projects a one-million-event recovery without retaining a second full copy", () => {
    const events = Array.from(
      { length: 1_000_000 },
      (_, index) => runtimeEvent(`recovery-${index + 1}`, index + 1),
    );
    globalThis.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const merged = mergeLiveRuntimeEventLists([], events);
    const elapsedMs = performance.now() - started;
    globalThis.gc?.();
    const retainedHeapBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);

    expect(merged).toHaveLength(MAX_LIVE_RUNTIME_EVENTS);
    expect(merged[0]?.sequence).toBe(995_001);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(retainedHeapBytes).toBeLessThan(64 * 1024 * 1024);
  });

  test("keeps single-event append p95 within the live projection budget", () => {
    let merged = Array.from(
      { length: MAX_LIVE_RUNTIME_EVENTS },
      (_, index) => runtimeEvent(`initial-${index + 1}`, index + 1),
    );
    const durations: number[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      const started = performance.now();
      merged = mergeLiveRuntimeEventLists(merged, [
        runtimeEvent(`append-${index + 1}`, MAX_LIVE_RUNTIME_EVENTS + index + 1),
      ]);
      durations.push(performance.now() - started);
    }
    durations.sort((left, right) => left - right);

    expect(merged).toHaveLength(MAX_LIVE_RUNTIME_EVENTS);
    expect(durations[949]).toBeLessThan(50);
  });
});

function runtimeEvent(
  id: string,
  sequence?: number,
  overrides: Partial<RuntimeEvent> = {},
): RuntimeEvent {
  return {
    id,
    sequence,
    sessionId: "session_1",
    name: "turn.started",
    timestamp: "2026-07-01T10:00:00.000Z",
    source: "server",
    ...overrides,
  };
}
