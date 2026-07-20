import { describe, expect, test } from "vitest";
import { SubagentRunSchema, type Approval, type RuntimeEvent } from "@openpond/contracts";
import {
  approvalsWithStatus,
  buildRuntimeIndexes,
  buildRuntimeIndexesWithReuse,
  latestContextUsageForSession,
  latestPendingApprovalForSession,
  latestSubagentRuntimeForSession,
  runtimeEventsForSession,
} from "../apps/web/src/lib/runtime-indexes";

describe("runtime indexes", () => {
  test("groups session events and keeps the latest context snapshot", () => {
    const indexes = buildRuntimeIndexes([
      runtimeEvent({ id: "s1_delta", sessionId: "s1", name: "assistant.delta", output: "one" }),
      runtimeEvent({
        id: "context_old",
        sessionId: "s1",
        name: "session.context.updated",
        data: contextUsage("context_old", 12),
      }),
      runtimeEvent({
        id: "context_new",
        sessionId: "s1",
        name: "session.context.updated",
        data: contextUsage("context_new", 24),
      }),
    ], []);

    expect(runtimeEventsForSession(indexes, "s1")).toHaveLength(3);
    expect(latestContextUsageForSession(indexes, "s1")?.usedTokens).toBe(24);
  });

  test("indexes pending approvals by session and status", () => {
    const approvals = [
      approval({ id: "a1", sessionId: "s1", status: "pending", createdAt: "2026-07-01T10:00:00.000Z" }),
      approval({ id: "a2", sessionId: "s1", status: "accepted", createdAt: "2026-07-01T10:01:00.000Z" }),
    ];
    const indexes = buildRuntimeIndexes([], approvals);

    expect(approvalsWithStatus(indexes, "pending").map((item) => item.id)).toEqual(["a1"]);
    expect(latestPendingApprovalForSession(indexes, "s1")?.id).toBe("a1");
  });

  test("projects generic child conversation states without a review lifecycle", () => {
    const running = subagentRun({ id: "run_running", status: "running", roleId: "coding" });
    const completed = subagentRun({
      id: "run_completed",
      status: "completed",
      roleId: "research",
      completedAt: "2026-07-01T10:02:00.000Z",
      report: { summary: "Focused result." },
    });
    const indexes = buildRuntimeIndexes([
      runtimeEvent({
        id: "run_started",
        sessionId: "s1",
        name: "subagent.started",
        status: "started",
        data: { run: running },
      }),
      runtimeEvent({
        id: "run_completed",
        sessionId: "s1",
        name: "subagent.completed",
        status: "completed",
        timestamp: "2026-07-01T10:02:00.000Z",
        data: { run: completed },
      }),
    ], []);

    expect(latestSubagentRuntimeForSession(indexes, "s1")).toMatchObject({
      activeCount: 1,
      completedCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      terminalCount: 1,
      label: "1 child running",
    });
    expect(latestSubagentRuntimeForSession(indexes, "s1")?.finalResults).toEqual([
      expect.objectContaining({ runId: "run_completed", status: "completed", summary: "Focused result." }),
    ]);
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
    const nextIndexes = buildRuntimeIndexesWithReuse(nextEvents, [], { events: firstEvents, indexes: firstIndexes });

    expect(runtimeEventsForSession(nextIndexes, "s1")).toBe(runtimeEventsForSession(firstIndexes, "s1"));
    expect(runtimeEventsForSession(nextIndexes, "s2")).not.toBe(runtimeEventsForSession(firstIndexes, "s2"));
  });
});

function runtimeEvent(input: Omit<RuntimeEvent, "timestamp"> & { timestamp?: string }): RuntimeEvent {
  return { timestamp: "2026-07-01T10:00:00.000Z", ...input };
}

function contextUsage(eventId: string, usedTokens: number) {
  return {
    provider: "openpond",
    model: "openpond-chat",
    usedTokens,
    maxContextTokens: 128000,
    usableContextTokens: 117760,
    percentFull: 0,
    source: "provider_usage",
    updatedAtEventId: eventId,
  };
}

function subagentRun(input: {
  id: string;
  status: "running" | "completed";
  roleId: string;
  completedAt?: string;
  report?: { summary: string };
}) {
  return SubagentRunSchema.parse({
    id: input.id,
    parentSessionId: "s1",
    parentTurnId: "turn_1",
    parentGoalId: "goal_1",
    childSessionId: `child_${input.id}`,
    roleId: input.roleId,
    objective: "Focused child task",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    isolationMode: "none",
    toolPolicy: "read_only",
    background: true,
    peerMessages: "goal_scoped",
    status: input.status,
    report: input.report,
    createdAt: "2026-07-01T10:00:00.000Z",
    completedAt: input.completedAt ?? null,
  });
}

function approval(input: { id: string; sessionId: string; status: Approval["status"]; createdAt: string }): Approval {
  return {
    id: input.id,
    sessionId: input.sessionId,
    turnId: "turn-1",
    providerRequestId: input.id,
    kind: "command",
    title: "Run command",
    detail: "pnpm test",
    status: input.status,
    createdAt: input.createdAt,
  };
}
