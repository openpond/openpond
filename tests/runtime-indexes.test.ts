import { describe, expect, test } from "bun:test";
import type { Approval, RuntimeEvent, SubagentRun } from "@openpond/contracts";
import {
  approvalsWithStatus,
  buildRuntimeIndexes,
  buildRuntimeIndexesWithReuse,
  latestContextUsageForSession,
  latestGoalRuntimeForSession,
  latestPendingApprovalForSession,
  latestSubagentRuntimeForSession,
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

  test("indexes subagent runtime receipts by parent session", () => {
    const indexes = buildRuntimeIndexes(
      [
        runtimeEvent({
          id: "subagent_start",
          sessionId: "s1",
          turnId: "turn_1",
          name: "subagent.started",
          status: "pending",
          data: { run: subagentRun({ id: "run_1", status: "queued" }) },
        }),
        runtimeEvent({
          id: "subagent_running",
          sessionId: "s1",
          turnId: "turn_1",
          name: "subagent.started",
          status: "started",
          data: { run: subagentRun({ id: "run_1", status: "running", startedAt: "2026-07-01T10:00:02.000Z" }) },
        }),
        runtimeEvent({
          id: "subagent_blocked",
          sessionId: "s1",
          turnId: "turn_3",
          name: "subagent.blocked",
          status: "failed",
          data: {
            run: subagentRun({
              id: "run_3",
              parentSessionId: "s1",
              roleId: "test",
              status: "blocked",
              report: {
                summary: "Test subagent is blocked.",
                blockers: ["Waiting on approval"],
              },
            }),
          },
        }),
        runtimeEvent({
          id: "subagent_message",
          sessionId: "s1",
          turnId: "turn_4",
          name: "subagent.message",
          status: "completed",
          data: {
            message: {
              id: "message_1",
              parentGoalId: "goal_1",
              fromRunId: "run_1",
              toRunId: "run_3",
              toRole: null,
              kind: "handoff",
              body: "Review my handoff.",
              refs: [],
              createdAt: "2026-07-01T10:00:03.000Z",
            },
            deliveredRunIds: ["run_3"],
          },
        }),
        runtimeEvent({
          id: "subagent_completed",
          sessionId: "s2",
          turnId: "turn_2",
          name: "subagent.completed",
          status: "completed",
          data: {
            run: subagentRun({
              id: "run_2",
              parentSessionId: "s2",
              roleId: "review",
              status: "completed",
              completedAt: "2026-07-01T10:01:00.000Z",
              report: {
                summary: "Reviewed the patch.",
                artifacts: [{ kind: "file", id: "/repo/src/app.ts", label: "src/app.ts" }],
                diffRef: { kind: "diff", id: "diff_review", label: "Review diff" },
                testsRun: ["bun test tests/runtime-indexes.test.ts"],
              },
              metadata: {
                usage: {
                  totalTokens: 42,
                  promptTokens: 30,
                  completionTokens: 12,
                  requestCount: 2,
                },
              },
            }),
          },
        }),
      ],
      [],
    );

    expect(latestSubagentRuntimeForSession(indexes, "s1")).toMatchObject({
      activeCount: 1,
      blockedCount: 1,
      requiredOpenCount: 2,
      label: "1 subagent running",
      tooltip: "Subagents: Coding running",
    });
    expect(latestSubagentRuntimeForSession(indexes, "s1")?.runs[0]).toMatchObject({
      id: "run_1",
      status: "running",
    });
    expect(latestSubagentRuntimeForSession(indexes, "s1")?.taskGraph).toMatchObject({
      rootId: "parent:s1",
      nodes: expect.arrayContaining([
        expect.objectContaining({ runId: "run_1", roleId: "coding", status: "running" }),
        expect.objectContaining({ runId: "run_3", roleId: "test", status: "blocked" }),
      ]),
      edges: expect.arrayContaining([
        expect.objectContaining({ id: "start:run_1", fromRunId: "parent:s1", toRunId: "run_1" }),
        expect.objectContaining({ id: "start:run_3", fromRunId: "parent:s1", toRunId: "run_3" }),
        expect.objectContaining({
          id: "message:message_1:run_1:run_3",
          fromRunId: "run_1",
          toRunId: "run_3",
          kind: "handoff",
        }),
      ]),
    });
    expect(latestSubagentRuntimeForSession(indexes, "s2")).toMatchObject({
      activeCount: 0,
      completedCount: 1,
      requiredOpenCount: 0,
      label: "1 subagent completed",
      usage: {
        totalTokens: 42,
        promptTokens: 30,
        completionTokens: 12,
        requestCount: 2,
      },
    });
    expect(latestSubagentRuntimeForSession(indexes, "s1")?.blockers).toEqual([
      expect.objectContaining({
        runId: "run_3",
        roleId: "test",
        message: "Waiting on approval",
      }),
      expect.objectContaining({
        runId: "run_3",
        roleId: "test",
        message: "Test subagent is blocked.",
      }),
    ]);
    expect(latestSubagentRuntimeForSession(indexes, "s2")?.evidenceRefs).toEqual([
      expect.objectContaining({ runId: "run_2", kind: "file", id: "/repo/src/app.ts" }),
      expect.objectContaining({ runId: "run_2", kind: "diff", id: "diff_review" }),
    ]);
    expect(latestSubagentRuntimeForSession(indexes, "s2")?.testsRunCount).toBe(1);
    expect([...indexes.activeSubagentSessionIds]).toEqual(["s1"]);
  });

  test("keeps latest active goal runtime while a goal-scoped subagent is still running", () => {
    const indexes = buildRuntimeIndexes(
      [
        runtimeEvent({ id: "turn_started", sessionId: "s1", turnId: "turn_1", name: "turn.started" }),
        runtimeEvent({
          id: "goal_active",
          sessionId: "s1",
          turnId: "turn_1",
          name: "diagnostic",
          data: {
            kind: "thread_goal",
            provider: "openpond",
            goal: {
              id: "goal_1",
              objective: "Keep the subagent goal visible",
              status: "running",
              timeUsedSeconds: 73,
            },
          },
        }),
        runtimeEvent({ id: "turn_done", sessionId: "s1", turnId: "turn_1", name: "turn.completed" }),
        runtimeEvent({
          id: "subagent_running",
          sessionId: "s1",
          turnId: "turn_1",
          name: "subagent.started",
          status: "started",
          data: {
            run: subagentRun({
              id: "run_1",
              parentSessionId: "s1",
              status: "running",
              startedAt: "2026-07-01T10:00:02.000Z",
            }),
          },
        }),
      ],
      [],
    );

    expect(latestGoalRuntimeForSession(indexes, "s1")).toMatchObject({
      objective: "Keep the subagent goal visible",
      actionLabel: "Pursuing goal",
      tone: "active",
    });
    expect([...indexes.activeGoalSessionIds]).toEqual(["s1"]);
    expect(latestSubagentRuntimeForSession(indexes, "s1")?.activeCount).toBe(1);
  });

  test("preserves unchanged session event arrays when appending events", () => {
    const firstEvents = [
      runtimeEvent({ id: "s1_delta", sessionId: "s1", name: "assistant.delta", output: "one" }),
      runtimeEvent({ id: "s2_delta", sessionId: "s2", name: "assistant.delta", output: "two" }),
    ];
    const firstIndexes = buildRuntimeIndexes(firstEvents, []);
    const nextEvents = [
      ...firstEvents,
      runtimeEvent({ id: "s2_more", sessionId: "s2", name: "assistant.delta", output: " more" }),
    ];

    const nextIndexes = buildRuntimeIndexesWithReuse(nextEvents, [], {
      events: firstEvents,
      indexes: firstIndexes,
    });

    expect(runtimeEventsForSession(nextIndexes, "s1")).toBe(runtimeEventsForSession(firstIndexes, "s1"));
    expect(runtimeEventsForSession(nextIndexes, "s2")).not.toBe(runtimeEventsForSession(firstIndexes, "s2"));
    expect(runtimeEventsForSession(nextIndexes, "s2").map((event) => event.id)).toEqual([
      "s2_delta",
      "s2_more",
    ]);
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

function subagentRun(input: {
  id: string;
  parentSessionId?: string;
  roleId?: string;
  status: SubagentRun["status"];
  startedAt?: string | null;
  completedAt?: string | null;
  error?: string | null;
  report?: Partial<NonNullable<SubagentRun["report"]>> | null;
  metadata?: Record<string, unknown>;
}) {
  return {
    id: input.id,
    parentSessionId: input.parentSessionId ?? "s1",
    parentTurnId: "turn_1",
    parentGoalId: "goal_1",
    childSessionId: "child_1",
    roleId: input.roleId ?? "coding",
    objective: "Check the patch",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    isolationMode: "copy_on_write",
    toolPolicy: "read_only",
    background: true,
    peerMessages: "goal_scoped",
    status: input.status,
    required: true,
    createdAt: "2026-07-01T10:00:00.000Z",
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
    error: input.error ?? null,
    report: input.report
      ? {
          summary: "",
          findings: [],
          artifacts: [],
          patchRef: null,
          diffRef: null,
          testsRun: [],
          blockers: [],
          confidence: null,
          followUpNeeded: false,
          ...input.report,
        }
      : null,
    metadata: input.metadata ?? {},
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
