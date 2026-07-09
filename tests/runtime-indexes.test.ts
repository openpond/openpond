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
    expect(latestGoalRuntimeForSession(indexes, "s1")).toMatchObject({
      objective: "Stale active goal",
      tone: "active",
    });
    expect(latestGoalRuntimeForSession(indexes, "s2")?.tone).toBe("active");
    expect([...indexes.activeGoalSessionIds]).toEqual(["s1", "s2"]);
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
          id: "subagent_submitted",
          sessionId: "s1",
          turnId: "turn_5",
          name: "subagent.submitted",
          status: "pending",
          data: { run: subagentRun({ id: "run_4", roleId: "research", status: "submitted_for_review" }) },
        }),
        runtimeEvent({
          id: "subagent_needs_revision",
          sessionId: "s1",
          turnId: "turn_6",
          name: "subagent.needs_revision",
          status: "failed",
          data: { run: subagentRun({ id: "run_5", roleId: "review", status: "needs_revision" }) },
        }),
        runtimeEvent({
          id: "subagent_superseded",
          sessionId: "s1",
          turnId: "turn_6",
          name: "subagent.superseded",
          status: "completed",
          data: {
            run: subagentRun({
              id: "run_6",
              roleId: "docs",
              status: "superseded",
              completedAt: "2026-07-01T10:00:01.000Z",
            }),
          },
        }),
        runtimeEvent({
          id: "subagent_watcher_tick",
          sessionId: "s1",
          turnId: "turn_7",
          name: "diagnostic",
          status: "completed",
          timestamp: "2026-07-01T10:00:04.000Z",
          data: {
            kind: "subagent_lifecycle_watcher_tick",
            checkedAt: "2026-07-01T10:00:04.000Z",
            activeCount: 4,
            staleCount: 0,
            wakeQueued: false,
            wakePolicy: "not_waking_parent_for_routine_tick",
          },
        }),
        runtimeEvent({
          id: "subagent_accepted",
          sessionId: "s2",
          turnId: "turn_2",
          name: "subagent.accepted",
          status: "completed",
          data: {
            run: subagentRun({
              id: "run_2",
              parentSessionId: "s2",
              roleId: "review",
              status: "accepted",
              completedAt: "2026-07-01T10:01:00.000Z",
              review: {
                status: "accepted",
                decidedAt: "2026-07-01T10:01:00.000Z",
                independentReviewRecommended: true,
                reviewerRoutingReasons: ["packet_quality_weak", "validation_missing"],
                reviewerRoutingEvidence: {
                  packetQualityStatus: "weak",
                  confidence: "low",
                  changedFileCount: 1,
                  highRiskFileCount: 0,
                  validationAttemptCount: 0,
                  failedValidationCount: 0,
                  missingRequestedValidation: true,
                  providerFailureAfterChanges: false,
                  userRequestedIndependentReview: false,
                },
                packetQuality: {
                  status: "weak",
                  issues: [],
                  warnings: ["Validation evidence needs reviewer attention."],
                  evidence: {
                    finalSummaryPresent: true,
                    finalSummaryLength: 19,
                    requestedValidationCommandCount: 1,
                    validationAttemptCount: 0,
                    failedValidationCount: 0,
                    testsRunCount: 1,
                    changedFileCount: 0,
                    patchRefPresent: false,
                    diffRefPresent: true,
                    artifactCount: 1,
                    findingCount: 0,
                    blockerCount: 0,
                    unvalidatedWorkspaceChanges: false,
                  },
                },
              },
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
                childSessionArchive: {
                  status: "archived",
                  archivedAt: "2026-07-01T10:02:00.000Z",
                },
                lifecycleCleanup: {
                  workspaceCleanup: {
                    status: "retained",
                    reason: "Changed child workspace has not been applied; retain for inspection.",
                    retainedAt: "2026-07-01T10:02:30.000Z",
                    retentionPolicy: {
                      kind: "retain_for_inspection",
                      retentionDays: 7,
                      expiresAt: "2026-07-08T10:02:30.000Z",
                      cleanupAfterExpiry: true,
                      trigger: "auto_after_acceptance",
                    },
                  },
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
      submittedCount: 1,
      needsRevisionCount: 1,
      needsUserInputCount: 0,
      acceptedCount: 0,
      failedWithArtifactsCount: 0,
      blockedCount: 1,
      unresolvedCount: 4,
      terminalCount: 1,
      archivedCount: 0,
      requiredActiveCount: 1,
      requiredSubmittedForReviewCount: 1,
      requiredNeedsRevisionCount: 1,
      requiredNeedsUserInputCount: 0,
      requiredBlockingCount: 1,
      requiredAcceptedCount: 0,
      requiredTerminalCount: 1,
      requiredArchivedCount: 0,
      requiredUnresolvedCount: 4,
      requiredOpenCount: 4,
      watcher: {
        activeCount: 4,
        staleCount: 0,
        wakeQueued: false,
        wakePolicy: "not_waking_parent_for_routine_tick",
      },
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
      acceptedCount: 1,
      terminalCount: 1,
      archivedCount: 1,
      requiredAcceptedCount: 1,
      requiredTerminalCount: 1,
      requiredArchivedCount: 1,
      requiredUnresolvedCount: 0,
      requiredOpenCount: 0,
      label: "1 subagent accepted",
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
    expect(latestSubagentRuntimeForSession(indexes, "s2")?.finalResults).toEqual([
      expect.objectContaining({
        runId: "run_2",
        roleId: "review",
        status: "accepted",
        summary: "Reviewed the patch.",
        refs: [
          expect.objectContaining({ kind: "file", id: "/repo/src/app.ts" }),
          expect.objectContaining({ kind: "diff", id: "diff_review" }),
        ],
        testsRun: ["bun test tests/runtime-indexes.test.ts"],
        blockers: ["Validation evidence needs reviewer attention."],
        packetQualityStatus: "weak",
        packetQualityEvidence: expect.objectContaining({
          finalSummaryPresent: true,
          requestedValidationCommandCount: 1,
          testsRunCount: 1,
          diffRefPresent: true,
        }),
        independentReviewRecommended: true,
        reviewerRoutingReasons: ["packet_quality_weak", "validation_missing"],
        reviewerRoutingEvidence: expect.objectContaining({
          packetQualityStatus: "weak",
          confidence: "low",
          missingRequestedValidation: true,
        }),
        workspaceRetention: {
          status: "retained",
          reason: "Changed child workspace has not been applied; retain for inspection.",
          retainedAt: "2026-07-01T10:02:30.000Z",
          expiresAt: "2026-07-08T10:02:30.000Z",
          retentionDays: 7,
          trigger: "auto_after_acceptance",
          cleanupAfterExpiry: true,
        },
      }),
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
              subagents: {
                source: "subagent_runs",
                updatedAt: "2026-07-01T10:00:03.000Z",
                totalCount: 1,
                requiredCount: 1,
                optionalCount: 0,
                activeCount: 1,
                submittedForReviewCount: 0,
                needsRevisionCount: 0,
                needsUserInputCount: 0,
                acceptedCount: 0,
                blockingCount: 0,
                terminalCount: 0,
                cleanupNeededCount: 0,
                unresolvedCount: 1,
                requiredActiveCount: 1,
                requiredSubmittedForReviewCount: 0,
                requiredNeedsRevisionCount: 0,
                requiredNeedsUserInputCount: 0,
                requiredAcceptedCount: 0,
                requiredBlockingCount: 0,
                requiredUnresolvedCount: 1,
                runs: [
                  {
                    id: "run_1",
                    childSessionId: "session_child",
                    roleId: "coding",
                    status: "running",
                    required: true,
                    objective: "Inspect the code",
                    reviewStatus: "not_requested",
                    updatedAt: "2026-07-01T10:00:02.000Z",
                    cleanupStatus: null,
                    blockerCount: 0,
                    validationAttemptCount: 0,
                    changedFileCount: 0,
                    followUpNeeded: false,
                  },
                ],
              },
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
      subagents: {
        totalCount: 1,
        requiredActiveCount: 1,
        requiredUnresolvedCount: 1,
        runs: [
          expect.objectContaining({
            id: "run_1",
            roleId: "coding",
            status: "running",
            required: true,
          }),
        ],
      },
    });
    expect([...indexes.activeGoalSessionIds]).toEqual(["s1"]);
    expect(latestSubagentRuntimeForSession(indexes, "s1")?.activeCount).toBe(1);
  });

  test("treats dismissed failed or blocked required subagents as resolved but not accepted", () => {
    const indexes = buildRuntimeIndexes(
      [
        runtimeEvent({
          id: "subagent_failed_dismissed",
          sessionId: "s1",
          turnId: "turn_1",
          name: "subagent.dismissed",
          status: "completed",
          data: {
            run: subagentRun({
              id: "run_failed_required",
              roleId: "research",
              status: "failed",
              error: "Research provider failed.",
              review: {
                status: "dismissed",
                summary: "Acknowledged failed required research.",
              },
              report: {
                summary: "Research failed.",
                blockers: ["Research provider failed."],
                followUpNeeded: false,
              },
              completedAt: "2026-07-01T10:01:00.000Z",
            }),
          },
        }),
        runtimeEvent({
          id: "subagent_blocked_dismissed",
          sessionId: "s1",
          turnId: "turn_2",
          name: "subagent.dismissed",
          status: "completed",
          data: {
            run: subagentRun({
              id: "run_blocked_required",
              roleId: "research",
              status: "blocked",
              review: {
                status: "dismissed",
                summary: "Acknowledged blocked required research.",
              },
              report: {
                summary: "Research is blocked.",
                blockers: ["External approval is unavailable."],
                followUpNeeded: false,
              },
            }),
          },
        }),
      ],
      [],
    );

    expect(latestSubagentRuntimeForSession(indexes, "s1")).toMatchObject({
      acceptedCount: 0,
      blockedCount: 0,
      unresolvedCount: 0,
      terminalCount: 2,
      requiredAcceptedCount: 0,
      requiredBlockingCount: 0,
      requiredUnresolvedCount: 0,
      requiredTerminalCount: 2,
    });
    expect(latestSubagentRuntimeForSession(indexes, "s1")?.finalResults).toEqual([
      expect.objectContaining({
        runId: "run_failed_required",
        status: "failed",
        blockers: ["Research provider failed."],
      }),
      expect.objectContaining({
        runId: "run_blocked_required",
        status: "blocked",
        blockers: ["External approval is unavailable."],
      }),
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
  review?: Partial<SubagentRun["review"]>;
  progress?: Partial<SubagentRun["progress"]>;
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
    review: input.review,
    progress: input.progress,
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
