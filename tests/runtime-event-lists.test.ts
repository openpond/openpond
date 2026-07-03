import { describe, expect, test } from "bun:test";
import type { RuntimeEvent } from "@openpond/contracts";
import {
  mergeBootstrapRuntimeEvents,
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
