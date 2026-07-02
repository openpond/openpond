import { describe, expect, test } from "bun:test";
import type { Approval, RuntimeEvent } from "@openpond/contracts";
import {
  approvalsWithStatus,
  buildRuntimeIndexes,
  latestContextUsageForSession,
  latestGoalRuntimeForSession,
  latestPendingApprovalForSession,
  runtimeEventsForSession,
} from "../apps/web/src/lib/runtime-indexes";

describe("runtime indexes", () => {
  test("groups events by session and indexes latest context and goal state", () => {
    const indexes = buildRuntimeIndexes(
      [
        runtimeEvent({ id: "s1_delta", sessionId: "s1", name: "assistant.delta", output: "one" }),
        runtimeEvent({ id: "server_diag", name: "diagnostic", data: { kind: "server" } }),
        runtimeEvent({
          id: "s1_context_old",
          sessionId: "s1",
          name: "session.context.updated",
          data: contextUsage("s1_context_old", 12),
        }),
        runtimeEvent({
          id: "s2_goal",
          sessionId: "s2",
          name: "diagnostic",
          data: {
            kind: "thread_goal",
            goal: {
              objective: "Keep working",
              status: "active",
              timeUsedSeconds: 61,
              tokensUsed: 500,
              tokenBudget: 1000,
            },
          },
        }),
        runtimeEvent({
          id: "s1_context_new",
          sessionId: "s1",
          name: "session.context.updated",
          data: contextUsage("s1_context_new", 42),
        }),
        runtimeEvent({
          id: "s1_goal",
          sessionId: "s1",
          name: "diagnostic",
          data: {
            kind: "thread_goal",
            goal: {
              objective: "Stale active goal",
              status: "active",
              timeUsedSeconds: 5,
            },
          },
        }),
        runtimeEvent({ id: "s1_turn_done", sessionId: "s1", name: "turn.completed" }),
      ],
      [],
    );

    expect(runtimeEventsForSession(indexes, "s1").map((event) => event.id)).toEqual([
      "s1_delta",
      "s1_context_old",
      "s1_context_new",
      "s1_goal",
      "s1_turn_done",
    ]);
    expect(runtimeEventsForSession(indexes, "missing")).toEqual([]);
    expect(indexes.eventsBySessionId.has("server_diag")).toBe(false);
    expect(latestContextUsageForSession(indexes, "s1")?.usedTokens).toBe(42);
    expect(latestGoalRuntimeForSession(indexes, "s1")).toBeNull();
    expect(latestGoalRuntimeForSession(indexes, "s2")?.tone).toBe("active");
    expect([...indexes.activeGoalSessionIds]).toEqual(["s2"]);
  });

  test("indexes approvals by id, status, session, and latest pending approval", () => {
    const olderPending = approval({
      id: "approval_older",
      sessionId: "s1",
      status: "pending",
      createdAt: "2026-07-01T10:00:00.000Z",
    });
    const accepted = approval({
      id: "approval_accepted",
      sessionId: "s1",
      status: "accepted",
      createdAt: "2026-07-01T10:01:00.000Z",
    });
    const newerPending = approval({
      id: "approval_newer",
      sessionId: "s1",
      status: "pending",
      createdAt: "2026-07-01T10:02:00.000Z",
    });
    const otherSessionPending = approval({
      id: "approval_other",
      sessionId: "s2",
      status: "pending",
      createdAt: "2026-07-01T10:03:00.000Z",
    });

    const indexes = buildRuntimeIndexes([], [
      olderPending,
      accepted,
      newerPending,
      otherSessionPending,
    ]);

    expect(indexes.approvalsById.get("approval_accepted")).toBe(accepted);
    expect(approvalsWithStatus(indexes, "pending").map((item) => item.id)).toEqual([
      "approval_older",
      "approval_newer",
      "approval_other",
    ]);
    expect(approvalsWithStatus(indexes, "accepted")).toEqual([accepted]);
    expect(indexes.pendingApprovalsBySessionId.get("s1")?.map((item) => item.id)).toEqual([
      "approval_older",
      "approval_newer",
    ]);
    expect(latestPendingApprovalForSession(indexes, "s1")).toBe(newerPending);
    expect(latestPendingApprovalForSession(indexes, "s2")).toBe(otherSessionPending);
    expect(latestPendingApprovalForSession(indexes, "missing")).toBeNull();
  });
});

function runtimeEvent(input: Omit<RuntimeEvent, "timestamp">): RuntimeEvent {
  return {
    timestamp: "2026-07-01T10:00:00.000Z",
    ...input,
  };
}

function contextUsage(eventId: string, usedTokens: number) {
  return {
    provider: "openpond",
    model: "openpond-chat",
    usedTokens,
    maxContextTokens: 128000,
    usableContextTokens: 117760,
    percentFull: Math.round((usedTokens / 128000) * 100),
    source: "provider_usage",
    updatedAtEventId: eventId,
  };
}

function approval(input: {
  id: string;
  sessionId: string;
  status: Approval["status"];
  createdAt: string;
}): Approval {
  return {
    id: input.id,
    sessionId: input.sessionId,
    turnId: "turn-1",
    providerRequestId: input.id,
    kind: "command",
    title: "Run command",
    detail: "bun test",
    status: input.status,
    createdAt: input.createdAt,
  };
}
