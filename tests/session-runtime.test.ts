import type { RuntimeEvent, Session, Turn } from "@openpond/contracts";
import { describe, expect, test } from "vitest";

import { sessionRuntimeSummaries } from "../apps/server/src/store/session-runtime-summary";
import {
  formatSidebarRuntime,
  sessionRuntimeFromStoredTurns,
  sessionRuntimeSeconds,
} from "../apps/web/src/lib/session-runtime";

describe("session sidebar runtime", () => {
  test("accumulates completed turns and the elapsed portion of a running turn", () => {
    expect(
      sessionRuntimeSeconds(
        [
          event("turn.started", "2026-07-29T10:00:00.000Z", "turn-1"),
          event("turn.completed", "2026-07-29T10:02:00.000Z", "turn-1"),
          event("turn.started", "2026-07-29T10:10:00.000Z", "turn-2"),
        ],
        "2026-07-29T10:15:30.000Z"
      )
    ).toBe(450);
  });

  test("ignores duplicate starts and safely pairs terminal events without ids", () => {
    expect(
      sessionRuntimeSeconds([
        event("turn.started", "2026-07-29T10:00:00.000Z", "turn-1"),
        event("turn.started", "2026-07-29T10:00:10.000Z", "turn-1"),
        event("turn.completed", "2026-07-29T10:01:00.000Z"),
      ])
    ).toBe(60);
  });

  test("derives durable completed runtime and the active turn start from stored turns", () => {
    const summaries = sessionRuntimeSummaries([
      turn({
        id: "turn-1",
        startedAt: "2026-07-29T10:00:00.000Z",
        completedAt: "2026-07-29T10:01:30.500Z",
        status: "completed",
      }),
      turn({
        id: "turn-2",
        startedAt: "2026-07-29T10:10:00.000Z",
        completedAt: "2026-07-29T10:10:30.500Z",
        status: "failed",
      }),
      turn({
        id: "turn-3",
        startedAt: "2026-07-29T10:20:00.000Z",
        status: "in_progress",
      }),
    ]);

    expect(summaries.get("session-1")).toEqual({
      runtimeSeconds: 121,
      runtimeRunningSince: "2026-07-29T10:20:00.000Z",
    });
  });

  test("adds a live turn to the durable completed-turn baseline", () => {
    const session = {
      runtimeSeconds: 120,
      runtimeRunningSince: "2026-07-29T10:10:00.000Z",
    } as Session;

    expect(
      sessionRuntimeFromStoredTurns(
        session,
        [event("turn.started", "2026-07-29T10:10:05.000Z", "turn-live")],
        "2026-07-29T10:12:00.000Z"
      )
    ).toBe(240);
  });

  test("falls back to event-derived runtime when a session has no stored summary", () => {
    expect(
      sessionRuntimeFromStoredTurns(
        {} as Session,
        [event("turn.started", "2026-07-29T10:00:00.000Z", "turn-1")],
        "2026-07-29T10:01:00.000Z"
      )
    ).toBeNull();
  });

  test("stops abandoned turns at their last activity when the session is idle", () => {
    expect(
      sessionRuntimeSeconds(
        [
          event("turn.started", "2026-07-10T10:00:00.000Z", "abandoned"),
          event(
            "assistant.delta",
            "2026-07-10T10:01:00.000Z",
            "abandoned"
          ),
          event("turn.started", "2026-07-20T10:00:00.000Z", "completed"),
          event("turn.completed", "2026-07-20T10:02:00.000Z", "completed"),
        ],
        "2026-07-29T10:00:00.000Z",
        { includeRunning: false }
      )
    ).toBe(180);
  });

  test("only extends the newest open turn when the session is running", () => {
    expect(
      sessionRuntimeSeconds(
        [
          event("turn.started", "2026-07-10T10:00:00.000Z", "abandoned"),
          event(
            "assistant.delta",
            "2026-07-10T10:01:00.000Z",
            "abandoned"
          ),
          event("turn.started", "2026-07-29T10:00:00.000Z", "active"),
        ],
        "2026-07-29T10:05:00.000Z",
        { includeRunning: true }
      )
    ).toBe(360);
  });

  test("formats compact minute, hour, and day labels", () => {
    expect(formatSidebarRuntime(0)).toBe("<1m");
    expect(formatSidebarRuntime(1_080)).toBe("18m");
    expect(formatSidebarRuntime(7_620)).toBe("2h 7m");
    expect(formatSidebarRuntime(86_400)).toBe("1d");
    expect(formatSidebarRuntime(1_619_760)).toBe("18d 17h");
  });
});

function event(
  name: RuntimeEvent["name"],
  timestamp: string,
  turnId?: string
): RuntimeEvent {
  return {
    id: `${name}:${timestamp}`,
    name,
    timestamp,
    turnId,
    payload: {},
  } as RuntimeEvent;
}

function turn(input: {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: Turn["status"];
}): Turn {
  return {
    id: input.id,
    sessionId: "session-1",
    providerTurnId: null,
    prompt: "Test",
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? null,
    status: input.status,
    error: null,
    metadata: {},
    createImproveRun: null,
  };
}
