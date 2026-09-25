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

describe("runtime event projection performance", () => {
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
