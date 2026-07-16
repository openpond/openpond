import { describe, expect, test } from "vitest";
import {
  AppPreferencesSchema,
  SubagentRunSchema,
  type Session,
  type RuntimeEvent,
  type SubagentRun,
  type Turn,
} from "@openpond/contracts";
import { createBackgroundWorkerQueue } from "../apps/server/src/runtime/background-worker-queue";
import { createSubagentLifecycleWatcher } from "../apps/server/src/runtime/subagent-lifecycle-watcher";

describe("subagent lifecycle watcher", () => {
  test("does not emit routine heartbeat events when no subagents are active", async () => {
    const events: RuntimeEvent[] = [];
    const queue = createBackgroundWorkerQueue({ queueId: "subagent" });
    const watcher = createSubagentLifecycleWatcher({
      store: {
        listActiveSubagentRuns: async () => [],
        listStaleSubagentRuns: async () => [],
      },
      queue,
      loadAppPreferences: async () => AppPreferencesSchema.parse({}),
      appendRuntimeEvent: async (runtimeEvent) => {
        events.push(runtimeEvent);
      },
      isClosing: () => false,
    });

    const result = await watcher.tickNow();

    expect(result).toMatchObject({
      activeCount: 0,
      staleCount: 0,
      wakeQueued: false,
      skippedReason: "no_active_subagents",
    });
    expect(events).toEqual([]);
  });

  test("records active subagent heartbeat diagnostics without waking the parent", async () => {
    const events: RuntimeEvent[] = [];
    const activeRuns = [
      subagentRun({ id: "run_submitted", status: "submitted_for_review", required: true }),
      subagentRun({ id: "run_revision", status: "needs_revision", required: false }),
      subagentRun({ id: "run_failed_artifacts", status: "failed_with_artifacts", required: true }),
    ];
    const queue = createBackgroundWorkerQueue({ queueId: "subagent" });
    const watcher = createSubagentLifecycleWatcher({
      store: {
        listActiveSubagentRuns: async () => activeRuns,
        listStaleSubagentRuns: async () => [activeRuns[1]!],
      },
      queue,
      loadAppPreferences: async () => AppPreferencesSchema.parse({}),
      appendRuntimeEvent: async (runtimeEvent) => {
        events.push(runtimeEvent);
      },
      isClosing: () => false,
      now: () => new Date("2026-07-09T12:00:00.000Z"),
    });

    const result = await watcher.tickNow("manual");

    expect(result).toMatchObject({
      activeCount: 3,
      requiredActiveCount: 2,
      submittedForReviewCount: 1,
      needsRevisionCount: 1,
      failedWithArtifactsCount: 1,
      staleCount: 1,
      optionalStaleCount: 1,
      staleAttentionCount: 1,
      wakeQueued: false,
      skippedReason: null,
    });
    expect(events).toHaveLength(2);
    expect(events.find((entry) => entry.data?.kind === "subagent_lifecycle_watcher_tick")).toMatchObject({
      sessionId: "session_parent",
      name: "diagnostic",
      source: "server",
      status: "completed",
      data: {
        kind: "subagent_lifecycle_watcher_tick",
        activeRunIds: ["run_submitted", "run_revision", "run_failed_artifacts"],
        staleRunIds: ["run_revision"],
        optionalStaleRunIds: ["run_revision"],
        staleAttentionRunIds: ["run_revision"],
        wakePolicy: "not_waking_parent_for_routine_tick",
        wakeQueued: false,
      },
    });
    expect(events.find((entry) => entry.name === "subagent.stale")).toMatchObject({
      sessionId: "session_parent",
      status: "pending",
      data: {
        run: {
          id: "run_revision",
          required: false,
        },
        stale: {
          attentionNeeded: true,
          cancellable: true,
          policy: "optional_attention",
        },
      },
    });
  });

  test("cleans expired retained workspaces even when no subagents are active", async () => {
    const events: RuntimeEvent[] = [];
    const cleanedRuns: Array<{ runId: string; checkedAt: string; expiresAt: string }> = [];
    const retainedRun = subagentRun({
      id: "run_expired_retained",
      status: "accepted",
      completedAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-01T10:00:00.000Z",
      metadata: {
        lifecycleCleanup: {
          reason: "accepted_review",
          policy: "auto_after_acceptance",
          workspaceCleanup: {
            status: "retained",
            reason: "Changed child workspace has not been applied; retain for inspection.",
            retainedAt: "2026-07-01T10:00:00.000Z",
            retentionPolicy: {
              kind: "retain_for_inspection",
              retentionDays: 7,
              expiresAt: "2026-07-08T10:00:00.000Z",
              cleanupAfterExpiry: true,
              trigger: "auto_after_acceptance",
            },
          },
        },
      },
    });
    const runs = [retainedRun];
    const queue = createBackgroundWorkerQueue({ queueId: "subagent" });
    const watcher = createSubagentLifecycleWatcher({
      store: {
        listActiveSubagentRuns: async () => [],
        listStaleSubagentRuns: async () => [],
        listSubagentRuns: async (query = {}) => {
          if (query.status && Array.isArray(query.status)) {
            return runs.filter((run) => query.status!.includes(run.status));
          }
          return runs;
        },
      },
      queue,
      loadAppPreferences: async () => AppPreferencesSchema.parse({}),
      appendRuntimeEvent: async (runtimeEvent) => {
        events.push(runtimeEvent);
      },
      cleanupExpiredRetainedWorkspace: async ({ run, checkedAt, retention }) => {
        cleanedRuns.push({ runId: run.id, checkedAt, expiresAt: retention.expiresAt });
        return SubagentRunSchema.parse({
          ...run,
          metadata: {
            ...(run.metadata ?? {}),
            lifecycleCleanup: {
              reason: "retention_expired",
              policy: "retention_expired",
              workspaceCleanup: {
                status: "removed",
              },
            },
          },
        });
      },
      isClosing: () => false,
      now: () => new Date("2026-07-09T12:00:00.000Z"),
    });

    const result = await watcher.tickNow("manual");

    expect(result).toMatchObject({
      activeCount: 0,
      expiredRetainedWorkspaceCount: 1,
      expiredRetainedWorkspaceCleanedCount: 1,
      expiredRetainedWorkspaceFailedCount: 0,
      wakeQueued: false,
      skippedReason: null,
    });
    expect(cleanedRuns).toEqual([
      {
        runId: "run_expired_retained",
        checkedAt: "2026-07-09T12:00:00.000Z",
        expiresAt: "2026-07-08T10:00:00.000Z",
      },
    ]);
    expect(events.find((entry) => entry.data?.kind === "subagent_lifecycle_watcher_tick")).toMatchObject({
      sessionId: "session_parent",
      data: {
        activeRunIds: [],
        expiredRetainedWorkspaceRunIds: ["run_expired_retained"],
        expiredRetainedWorkspaceCleanedRunIds: ["run_expired_retained"],
        wakePolicy: "cleaned_expired_retained_workspaces",
      },
    });
  });

  test("warns before retained workspace cleanup without waking the parent", async () => {
    const events: RuntimeEvent[] = [];
    const cleanupAttempts: string[] = [];
    const retainedRun = subagentRun({
      id: "run_expiring_retained",
      status: "accepted",
      completedAt: "2026-07-03T10:00:00.000Z",
      updatedAt: "2026-07-03T10:00:00.000Z",
      metadata: {
        lifecycleCleanup: {
          reason: "accepted_review",
          policy: "auto_after_acceptance",
          workspaceCleanup: {
            status: "retained",
            reason: "Changed child workspace has not been applied; retain for inspection.",
            retainedAt: "2026-07-03T10:00:00.000Z",
            retentionPolicy: {
              kind: "retain_for_inspection",
              retentionDays: 7,
              expiresAt: "2026-07-10T10:00:00.000Z",
              cleanupAfterExpiry: true,
              trigger: "auto_after_acceptance",
            },
          },
        },
      },
    });
    const runs = [retainedRun];
    const queue = createBackgroundWorkerQueue({ queueId: "subagent" });
    const watcher = createSubagentLifecycleWatcher({
      store: {
        listActiveSubagentRuns: async () => [],
        listStaleSubagentRuns: async () => [],
        listSubagentRuns: async (query = {}) => {
          if (query.status && Array.isArray(query.status)) {
            return runs.filter((run) => query.status!.includes(run.status));
          }
          return runs;
        },
        recordRetainedWorkspaceExpiryWarning: async (runId, warning) => {
          const index = runs.findIndex((run) => run.id === runId);
          if (index === -1) return null;
          runs[index] = SubagentRunSchema.parse({
            ...runs[index],
            metadata: {
              ...(runs[index]!.metadata ?? {}),
              retainedWorkspaceExpiryWarning: warning,
            },
          });
          return runs[index]!;
        },
      },
      queue,
      loadAppPreferences: async () => AppPreferencesSchema.parse({}),
      appendRuntimeEvent: async (runtimeEvent) => {
        events.push(runtimeEvent);
      },
      cleanupExpiredRetainedWorkspace: async ({ run }) => {
        cleanupAttempts.push(run.id);
        return run;
      },
      isClosing: () => false,
      now: () => new Date("2026-07-09T12:00:00.000Z"),
    });

    const first = await watcher.tickNow("manual");
    const second = await watcher.tickNow("manual");

    expect(first).toMatchObject({
      activeCount: 0,
      retainedWorkspaceExpiryWarningCount: 1,
      expiredRetainedWorkspaceCount: 0,
      wakeQueued: false,
      skippedReason: null,
    });
    expect(second).toMatchObject({
      retainedWorkspaceExpiryWarningCount: 0,
      wakeQueued: false,
      skippedReason: "no_active_subagents",
    });
    expect(cleanupAttempts).toEqual([]);
    expect(runs[0]).toMatchObject({
      metadata: {
        retainedWorkspaceExpiryWarning: {
          status: "warned",
          policy: "pre_cleanup_notice",
          checkedAt: "2026-07-09T12:00:00.000Z",
          expiresAt: "2026-07-10T10:00:00.000Z",
          warningBeforeMs: 86400000,
          source: "lifecycleCleanup",
          cleanupAfterExpiry: true,
          trigger: "auto_after_acceptance",
        },
      },
    });
    expect(events.filter((entry) => entry.name === "subagent.workspace_retention_expiring")).toHaveLength(1);
    expect(events.find((entry) => entry.name === "subagent.workspace_retention_expiring")).toMatchObject({
      sessionId: "session_parent",
      status: "pending",
      data: {
        run: {
          id: "run_expiring_retained",
          metadata: {
            retainedWorkspaceExpiryWarning: {
              expiresAt: "2026-07-10T10:00:00.000Z",
            },
          },
        },
        retention: {
          expiresAt: "2026-07-10T10:00:00.000Z",
          cleanupAfterExpiry: true,
        },
        warning: {
          policy: "pre_cleanup_notice",
          warningBeforeMs: 86400000,
        },
      },
    });
    expect(events.find((entry) => entry.data?.kind === "subagent_lifecycle_watcher_tick")).toMatchObject({
      sessionId: "session_parent",
      data: {
        activeRunIds: [],
        retainedWorkspaceExpiryWarningRunIds: ["run_expiring_retained"],
        retainedWorkspaceExpiryWarningCount: 1,
        wakePolicy: "not_waking_parent_for_retained_workspace_expiry_warning",
        wakeQueued: false,
      },
    });
  });

  test("marks optional stale child work as attention-needed without waking the parent", async () => {
    const events: RuntimeEvent[] = [];
    const sentTurns: Array<{ sessionId: string; payload: { prompt: string; metadata: Record<string, unknown> } }> = [];
    const optionalRun = subagentRun({
      id: "run_optional_stale",
      status: "running",
      required: false,
      updatedAt: "2026-07-09T11:00:00.000Z",
    });
    const queue = createBackgroundWorkerQueue({ queueId: "subagent" });
    const parentWakeQueue = createBackgroundWorkerQueue({ queueId: "turn-follow-up" });
    const watcher = createSubagentLifecycleWatcher({
      store: {
        listActiveSubagentRuns: async () => [optionalRun],
        listStaleSubagentRuns: async () => [optionalRun],
        listSubagentRuns: async () => [],
        turnsForSession: async () => [],
      },
      queue,
      parentWakeQueue,
      loadAppPreferences: async () => AppPreferencesSchema.parse({}),
      appendRuntimeEvent: async (runtimeEvent) => {
        events.push(runtimeEvent);
      },
      getSession: async () => parentSession(),
      sendTurn: async (sessionId, payload) => {
        sentTurns.push({ sessionId, payload });
      },
      isClosing: () => false,
      now: () => new Date("2026-07-09T12:00:00.000Z"),
    });

    const first = await watcher.tickNow("manual");
    const second = await watcher.tickNow("manual");
    await parentWakeQueue.drain();

    expect(first).toMatchObject({
      activeCount: 1,
      staleCount: 1,
      optionalStaleCount: 1,
      staleAttentionCount: 1,
      wakeQueued: false,
      wakeReasons: [],
    });
    expect(second).toMatchObject({
      wakeQueued: false,
      wakeReasons: [],
    });
    expect(sentTurns).toEqual([]);
    expect(events.filter((entry) => entry.name === "subagent.stale")).toHaveLength(1);
    expect(events.find((entry) => entry.name === "subagent.stale")).toMatchObject({
      data: {
        run: {
          id: "run_optional_stale",
          required: false,
        },
        stale: {
          checkedAt: "2026-07-09T12:00:00.000Z",
          required: false,
          attentionNeeded: true,
          cancellable: true,
          policy: "optional_attention",
        },
      },
    });
    expect(events.filter((entry) => entry.data?.kind === "subagent_lifecycle_watcher_wake")).toEqual([]);
  });

  test("auto-cancels optional stale child work after the grace threshold", async () => {
    const events: RuntimeEvent[] = [];
    const interruptedSessions: Array<{ sessionId: string; reason?: string }> = [];
    const optionalRun = subagentRun({
      id: "run_optional_auto_cancel",
      status: "running",
      required: false,
      childSessionId: "session_child_optional",
      updatedAt: "2026-07-09T10:00:00.000Z",
    });
    const requiredRun = subagentRun({
      id: "run_required_stale",
      status: "running",
      required: true,
      childSessionId: "session_child_required",
      updatedAt: "2026-07-09T10:00:00.000Z",
    });
    const submittedOptionalRun = subagentRun({
      id: "run_optional_submitted",
      status: "submitted_for_review",
      required: false,
      childSessionId: "session_child_submitted",
      updatedAt: "2026-07-09T10:00:00.000Z",
    });
    const runs = [optionalRun, requiredRun, submittedOptionalRun];
    const queue = createBackgroundWorkerQueue({ queueId: "subagent" });
    const watcher = createSubagentLifecycleWatcher({
      store: {
        listActiveSubagentRuns: async () => runs,
        listStaleSubagentRuns: async () => runs,
        listSubagentRuns: async () => [],
        upsertSubagentRun: async (run) => {
          const index = runs.findIndex((candidate) => candidate.id === run.id);
          if (index === -1) runs.push(run);
          else runs[index] = run;
          return run;
        },
        turnsForSession: async () => [],
      },
      queue,
      loadAppPreferences: async () => AppPreferencesSchema.parse({}),
      appendRuntimeEvent: async (runtimeEvent) => {
        events.push(runtimeEvent);
      },
      interruptSessionTurn: async (sessionId, reason) => {
        interruptedSessions.push({ sessionId, reason });
        return turnFixture({ id: "turn_optional", sessionId, status: "interrupted" });
      },
      isClosing: () => false,
      staleAfterMs: 30 * 60 * 1000,
      optionalStaleAutoCancelAfterMs: 60 * 60 * 1000,
      now: () => new Date("2026-07-09T12:00:00.000Z"),
    });

    const result = await watcher.tickNow("manual");

    expect(result).toMatchObject({
      activeCount: 3,
      staleCount: 3,
      optionalStaleCount: 2,
      optionalAutoCancelledCount: 1,
      wakeQueued: false,
    });
    expect(interruptedSessions).toEqual([
      {
        sessionId: "session_child_optional",
        reason: "Optional stale subagent auto-cancelled by lifecycle watcher.",
      },
    ]);
    expect(runs.find((run) => run.id === "run_optional_auto_cancel")).toMatchObject({
      status: "cancelled",
      completedAt: "2026-07-09T12:00:00.000Z",
      error: "Optional stale subagent auto-cancelled by lifecycle watcher.",
      report: {
        summary: "Optional stale subagent auto-cancelled.",
        followUpNeeded: false,
        blockers: ["Optional stale subagent auto-cancelled by lifecycle watcher."],
      },
      metadata: {
        staleAutoCancel: {
          policy: "optional_stale_auto_cancel",
          previousStatus: "running",
          autoCancelAfterMs: 3600000,
          interruptResult: {
            status: "interrupted",
            turnId: "turn_optional",
          },
        },
      },
    });
    expect(runs.find((run) => run.id === "run_required_stale")).toMatchObject({
      status: "running",
      required: true,
    });
    expect(runs.find((run) => run.id === "run_optional_submitted")).toMatchObject({
      status: "submitted_for_review",
      required: false,
    });
    expect(events.find((entry) => entry.name === "subagent.cancelled")).toMatchObject({
      sessionId: "session_parent",
      status: "completed",
      data: {
        run: {
          id: "run_optional_auto_cancel",
          status: "cancelled",
        },
        staleAutoCancel: {
          policy: "optional_stale_auto_cancel",
        },
      },
    });
    expect(events.find((entry) => entry.data?.kind === "subagent_lifecycle_watcher_tick")).toMatchObject({
      data: {
        optionalAutoCancelledCount: 1,
        optionalStaleAutoCancelRunIds: ["run_optional_auto_cancel"],
        wakePolicy: "auto_cancelled_optional_stale_subagents",
      },
    });
    expect(events.find(
      (entry) => entry.name === "subagent.stale" && (entry.data as any)?.run?.id === "run_optional_auto_cancel",
    )).toMatchObject({
      data: {
        run: {
          status: "cancelled",
        },
        stale: {
          autoCancelled: true,
          policy: "optional_stale_auto_cancel",
        },
      },
    });
  });

  test("auto-cancels orphaned child work when the parent session is missing or archived", async () => {
    const events: RuntimeEvent[] = [];
    const interruptedSessions: Array<{ sessionId: string; reason?: string }> = [];
    const activeStatuses = new Set<SubagentRun["status"]>([
      "queued",
      "running",
      "blocked",
      "submitted_for_review",
      "needs_revision",
      "needs_user_input",
      "failed_with_artifacts",
      "needs_resume",
    ]);
    const missingParentRun = subagentRun({
      id: "run_missing_parent",
      parentSessionId: "session_missing_parent",
      childSessionId: "session_child_missing_parent",
      status: "running",
      required: true,
    });
    const archivedParentRun = subagentRun({
      id: "run_archived_parent",
      parentSessionId: "session_archived_parent",
      childSessionId: "session_child_archived_parent",
      status: "needs_resume",
      required: false,
    });
    const healthyRun = subagentRun({
      id: "run_healthy_parent",
      parentSessionId: "session_parent",
      childSessionId: "session_child_healthy_parent",
      status: "running",
      required: true,
    });
    const runs = [missingParentRun, archivedParentRun, healthyRun];
    const queue = createBackgroundWorkerQueue({ queueId: "subagent" });
    const watcher = createSubagentLifecycleWatcher({
      store: {
        listActiveSubagentRuns: async () => runs.filter((run) => activeStatuses.has(run.status)),
        listStaleSubagentRuns: async () => [],
        listSubagentRuns: async () => [],
        upsertSubagentRun: async (run) => {
          const index = runs.findIndex((candidate) => candidate.id === run.id);
          if (index === -1) runs.push(run);
          else runs[index] = run;
          return run;
        },
        turnsForSession: async () => [],
      },
      queue,
      loadAppPreferences: async () => AppPreferencesSchema.parse({}),
      appendRuntimeEvent: async (runtimeEvent) => {
        events.push(runtimeEvent);
      },
      getSession: async (sessionId) => {
        if (sessionId === "session_missing_parent") return null;
        if (sessionId === "session_archived_parent") return parentSession({ id: sessionId, archived: true });
        return parentSession({ id: sessionId });
      },
      interruptSessionTurn: async (sessionId, reason) => {
        interruptedSessions.push({ sessionId, reason });
        return turnFixture({ id: `turn_${sessionId}`, sessionId, status: "interrupted" });
      },
      isClosing: () => false,
      now: () => new Date("2026-07-09T12:00:00.000Z"),
    });

    const result = await watcher.tickNow("manual");

    expect(result).toMatchObject({
      activeCount: 1,
      orphanedAutoCancelledCount: 2,
      wakeQueued: false,
    });
    expect(interruptedSessions).toEqual([
      {
        sessionId: "session_child_missing_parent",
        reason: "Parent session for subagent is missing; lifecycle watcher cancelled orphaned child work.",
      },
      {
        sessionId: "session_child_archived_parent",
        reason: "Parent session for subagent is archived; lifecycle watcher cancelled orphaned child work.",
      },
    ]);
    expect(runs.find((run) => run.id === "run_missing_parent")).toMatchObject({
      status: "cancelled",
      error: "Parent session for subagent is missing; lifecycle watcher cancelled orphaned child work.",
      report: {
        summary: "Orphaned subagent auto-cancelled.",
        followUpNeeded: false,
        blockers: ["Parent session for subagent is missing; lifecycle watcher cancelled orphaned child work."],
      },
      metadata: {
        orphanAutoCancel: {
          policy: "parent_session_missing",
          previousStatus: "running",
          parentSessionArchived: null,
          interruptResult: {
            status: "interrupted",
            turnId: "turn_session_child_missing_parent",
          },
        },
      },
    });
    expect(runs.find((run) => run.id === "run_archived_parent")).toMatchObject({
      status: "cancelled",
      error: "Parent session for subagent is archived; lifecycle watcher cancelled orphaned child work.",
      metadata: {
        orphanAutoCancel: {
          policy: "parent_session_archived",
          previousStatus: "needs_resume",
          parentSessionArchived: true,
          interruptResult: {
            status: "interrupted",
            turnId: "turn_session_child_archived_parent",
          },
        },
      },
    });
    expect(runs.find((run) => run.id === "run_healthy_parent")).toMatchObject({
      status: "running",
    });
    expect(events.filter((entry) => entry.name === "subagent.cancelled")).toHaveLength(2);
    expect(events.find((entry) => entry.data?.kind === "subagent_lifecycle_watcher_tick")).toMatchObject({
      data: {
        activeRunIds: ["run_healthy_parent"],
        orphanedAutoCancelledCount: 2,
        orphanedAutoCancelRunIds: ["run_missing_parent", "run_archived_parent"],
        wakePolicy: "auto_cancelled_orphaned_subagents",
      },
    });
  });

  test("bulk-loads active watcher runs and groups them by exact goal scope", async () => {
    const events: RuntimeEvent[] = [];
    const activeQueries: Array<Record<string, unknown>> = [];
    const scopeQueries: Array<Record<string, unknown>> = [];
    const goalRun = subagentRun({
      id: "run_goal",
      status: "running",
      required: true,
      parentGoalId: "goal_1",
    });
    const threadRun = subagentRun({
      id: "run_thread",
      status: "running",
      required: false,
      parentGoalId: null,
    });
    const otherGoalRun = subagentRun({
      id: "run_other_goal",
      status: "running",
      required: true,
      parentGoalId: "goal_2",
    });
    const runs = [goalRun, threadRun, otherGoalRun];
    const queue = createBackgroundWorkerQueue({ queueId: "subagent" });
    const watcher = createSubagentLifecycleWatcher({
      store: {
        listSubagentRunScopes: async (query = {}) => {
          scopeQueries.push(query as Record<string, unknown>);
          if (query.status === "failed" || Array.isArray(query.status) && query.status.includes("accepted")) return [];
          return [
            { parentSessionId: "session_parent", parentGoalId: "goal_1" },
            { parentSessionId: "session_parent", parentGoalId: null },
          ];
        },
        listActiveSubagentRuns: async (query = {}) => {
          activeQueries.push(query as Record<string, unknown>);
          return runs.filter((run) => {
            if (query.parentSessionId && run.parentSessionId !== query.parentSessionId) return false;
            if (query.parentGoalId && run.parentGoalId !== query.parentGoalId) return false;
            return true;
          });
        },
        listStaleSubagentRuns: async () => [],
        listSubagentRuns: async () => [],
      },
      queue,
      loadAppPreferences: async () => AppPreferencesSchema.parse({}),
      appendRuntimeEvent: async (runtimeEvent) => {
        events.push(runtimeEvent);
      },
      isClosing: () => false,
      now: () => new Date("2026-07-09T12:00:00.000Z"),
    });

    const result = await watcher.tickNow("manual");

    expect(result).toMatchObject({
      activeCount: 3,
      wakeQueued: false,
    });
    expect(scopeQueries).toHaveLength(0);
    expect(activeQueries).toEqual([{ limit: 500 }]);
    expect(events.find((entry) => entry.data?.kind === "subagent_lifecycle_watcher_tick")).toMatchObject({
      data: {
        activeRunIds: ["run_goal", "run_thread", "run_other_goal"],
        scopeKeys: ["session_parent:goal_1", "session_parent:thread", "session_parent:goal_2"],
        parentSessionIds: ["session_parent"],
        parentGoalIds: ["goal_1", "goal_2"],
      },
    });
  });

  test("queues a parent wake for required submitted and stale child work", async () => {
    const events: RuntimeEvent[] = [];
    const sentTurns: Array<{ sessionId: string; payload: { prompt: string; metadata: Record<string, unknown> } }> = [];
    const activeRun = subagentRun({
      id: "run_submitted",
      status: "submitted_for_review",
      required: true,
      objective: "Fix insights notification behavior without notifying when nothing changed.",
      updatedAt: "2026-07-09T11:00:00.000Z",
      workerBrief: {
        plan: ["Inspect notification code", "Add regression coverage"],
        targetFiles: ["apps/server/src/insights.ts"],
        acceptanceCriteria: ["No notification when insights are unchanged"],
        validationCommands: ["pnpm test tests/turn-runner-subagents.test.ts"],
        stopConditions: ["Stop if validation cannot run"],
      },
      report: {
        summary: "Suppressed unchanged insight notifications.",
        findings: ["Notification fanout now checks for meaningful changes."],
        artifacts: [{ kind: "file", id: "/tmp/openpond-test-attachments/subagents/run_submitted/handoff.patch", label: "Isolated child patch" }],
        patchRef: { kind: "file", id: "/tmp/openpond-test-attachments/subagents/run_submitted/handoff.patch", label: "Isolated child patch" },
        diffRef: { kind: "diff", id: "subagent-run:run_submitted:diff", label: "Isolated child diff" },
        testsRun: ["pnpm test tests/turn-runner-subagents.test.ts"],
        blockers: [],
        confidence: "medium",
        followUpNeeded: true,
      },
      progress: {
        phase: "submitted",
        inspectedFiles: ["apps/server/src/insights.ts"],
        inspectedResources: ["workspace:file:apps/server/src/insights.ts"],
        repeatedSearches: [],
        repeatedReads: [],
        repeatedCommands: [],
        changedFiles: ["apps/server/src/runtime/turn-runner.ts"],
        patchRefs: [{ kind: "diff", id: "subagent-run:run_submitted:diff", label: "Isolated child diff" }],
        validationAttempts: [{
          command: "pnpm test tests/turn-runner-subagents.test.ts",
          status: "passed",
          exitCode: 0,
          outputSummary: "36 pass",
        }],
        latestMeaningfulActivity: "Child submitted a review packet.",
        currentBlocker: null,
        updatedAt: "2026-07-09T11:00:00.000Z",
      },
      review: {
        status: "submitted_for_review",
        packetQuality: {
          status: "reviewable",
          issues: [],
          warnings: [],
          evidence: {
            finalSummaryPresent: true,
            finalSummaryLength: 42,
            requestedValidationCommandCount: 1,
            validationAttemptCount: 1,
            failedValidationCount: 0,
            testsRunCount: 1,
            changedFileCount: 1,
            patchRefPresent: true,
            diffRefPresent: true,
            artifactCount: 1,
            findingCount: 1,
            blockerCount: 0,
            unvalidatedWorkspaceChanges: false,
          },
        },
        independentReviewRecommended: true,
        reviewerRoutingReasons: ["broad_edit_surface", "high_risk_files"],
        reviewerRoutingEvidence: {
          packetQualityStatus: "reviewable",
          confidence: "medium",
          changedFileCount: 8,
          highRiskFileCount: 1,
          validationAttemptCount: 1,
          failedValidationCount: 0,
          missingRequestedValidation: false,
          providerFailureAfterChanges: false,
          userRequestedIndependentReview: false,
        },
      },
    });
    const failedRun = subagentRun({
      id: "run_failed",
      status: "failed",
      required: true,
      updatedAt: "2026-07-09T11:45:00.000Z",
      report: {
        summary: "Child failed after collecting useful artifacts.",
        findings: [],
        artifacts: [],
        testsRun: [],
        blockers: ["Provider failed after edits."],
        confidence: "low",
        followUpNeeded: true,
      },
    });
    const queue = createBackgroundWorkerQueue({ queueId: "subagent" });
    const parentWakeQueue = createBackgroundWorkerQueue({ queueId: "turn-follow-up" });
    const watcher = createSubagentLifecycleWatcher({
      store: {
        listActiveSubagentRuns: async () => [activeRun],
        listStaleSubagentRuns: async () => [activeRun],
        listSubagentRuns: async () => [failedRun],
        turnsForSession: async () => [],
      },
      queue,
      parentWakeQueue,
      loadAppPreferences: async () => AppPreferencesSchema.parse({}),
      appendRuntimeEvent: async (runtimeEvent) => {
        events.push(runtimeEvent);
      },
      getSession: async () => parentSession(),
      sendTurn: async (sessionId, payload) => {
        sentTurns.push({ sessionId, payload });
      },
      isClosing: () => false,
      now: () => new Date("2026-07-09T12:00:00.000Z"),
    });

    const result = await watcher.tickNow("manual");
    await parentWakeQueue.drain();

    expect(result).toMatchObject({
      activeCount: 1,
      staleCount: 1,
      wakeQueued: true,
      wakeQueuedCount: 1,
      wakeReasons: ["required_submitted_for_review", "required_stale", "required_failed"],
    });
    expect(sentTurns).toHaveLength(1);
    expect(sentTurns[0]).toMatchObject({
      sessionId: "session_parent",
      payload: {
        metadata: {
          subagentLifecycleWake: {
            parentSessionId: "session_parent",
            parentGoalId: "goal_1",
            runIds: ["run_submitted", "run_failed"],
            reasons: ["required_submitted_for_review", "required_stale", "required_failed"],
          },
        },
      },
    });
    const prompt = sentTurns[0]!.payload.prompt;
    expect(prompt).toContain("required child work that needs main-agent attention");
    expect(prompt).toContain("Review packets:");
    expect(prompt).toContain("Objective: Fix insights notification behavior without notifying when nothing changed.");
    expect(prompt).toContain("Worker brief:");
    expect(prompt).toContain("Acceptance criteria: No notification when insights are unchanged");
    expect(prompt).toContain("Final report:");
    expect(prompt).toContain("Summary: Suppressed unchanged insight notifications.");
    expect(prompt).toContain("Patch ref: file:Isolated child patch");
    expect(prompt).toContain("Diff ref: diff:Isolated child diff");
    expect(prompt).toContain("Packet quality:");
    expect(prompt).toContain("Status: reviewable");
    expect(prompt).toContain("Evidence: summary=present; summaryLength=42; requestedValidation=1; validationAttempts=1; failedValidation=0; testsRun=1; changedFiles=1; patchRef=yes; diffRef=yes; artifacts=1; findings=1; blockers=0");
    expect(prompt).toContain("Reviewer routing:");
    expect(prompt).toContain("Independent review recommended: yes");
    expect(prompt).toContain("Reasons: broad_edit_surface; high_risk_files");
    expect(prompt).toContain("Evidence: packetQuality=reviewable; confidence=medium; changedFiles=8; highRiskFiles=1; validationAttempts=1; failedValidation=0");
    expect(prompt).toContain("Runtime evidence:");
    expect(prompt).toContain("Validation attempts: pnpm test tests/turn-runner-subagents.test.ts; status=passed; exit=0; output=36 pass");
    expect(prompt).toContain("Available decisions:");
    expect(prompt).toContain("openpond_subagent_review with decision=\"accept\"");
    expect(prompt).toContain("openpond_subagent_review with decision=\"needs_revision\"");
    expect(prompt).toContain("openpond_subagent_review with decision=\"needs_user_input\"");
    expect(prompt).toContain("independent_review");
    expect(prompt).toContain("high-risk diff, broad edit surface, failed or ambiguous validation, low confidence");
    expect(events.find((entry) => entry.data?.kind === "subagent_lifecycle_watcher_wake")).toMatchObject({
      status: "pending",
      data: {
        wakeQueued: true,
        wakeQueuedParentSessionId: "session_parent",
        reasons: ["required_submitted_for_review", "required_stale", "required_failed"],
        staleRunIds: ["run_submitted"],
      },
    });
    expect(events.find((entry) => entry.data?.kind === "subagent_lifecycle_watcher_tick")).toMatchObject({
      data: {
        wakeQueued: true,
        wakeQueuedParentSessionIds: ["session_parent"],
        wakePolicy: "waking_parent_for_required_lifecycle_attention",
      },
    });
  });

  test("queues a parent wake for a recent required failed child even when no runs are active", async () => {
    const events: RuntimeEvent[] = [];
    const sentTurns: Array<{ sessionId: string; payload: { prompt: string; metadata: Record<string, unknown> } }> = [];
    const failedRun = subagentRun({
      id: "run_failed",
      status: "failed",
      required: true,
      updatedAt: "2026-07-09T11:50:00.000Z",
      report: {
        summary: "Child failed after useful work.",
        findings: [],
        artifacts: [],
        patchRefs: [],
        tests: [],
        blockers: ["Provider failed after editing files."],
        confidence: "low",
        followUpNeeded: true,
      },
    });
    const queue = createBackgroundWorkerQueue({ queueId: "subagent" });
    const parentWakeQueue = createBackgroundWorkerQueue({ queueId: "turn-follow-up" });
    const watcher = createSubagentLifecycleWatcher({
      store: {
        listActiveSubagentRuns: async () => [],
        listStaleSubagentRuns: async () => [],
        listSubagentRuns: async () => [failedRun],
        turnsForSession: async () => [],
      },
      queue,
      parentWakeQueue,
      loadAppPreferences: async () => AppPreferencesSchema.parse({}),
      appendRuntimeEvent: async (runtimeEvent) => {
        events.push(runtimeEvent);
      },
      getSession: async () => parentSession(),
      sendTurn: async (sessionId, payload) => {
        sentTurns.push({ sessionId, payload });
      },
      isClosing: () => false,
      now: () => new Date("2026-07-09T12:00:00.000Z"),
    });

    const result = await watcher.tickNow("manual");
    await parentWakeQueue.drain();

    expect(result).toMatchObject({
      activeCount: 0,
      wakeQueued: true,
      wakeReasons: ["required_failed"],
      skippedReason: null,
    });
    expect(sentTurns).toHaveLength(1);
    expect(sentTurns[0]!.payload.metadata.subagentLifecycleWake).toMatchObject({
      runIds: ["run_failed"],
      reasons: ["required_failed"],
    });
    expect(events.find((entry) => entry.data?.kind === "subagent_lifecycle_watcher_tick")).toMatchObject({
      data: {
        failedRunIds: ["run_failed"],
        wakeQueued: true,
      },
    });
  });

  test("queues a parent wake when all required child runs are accepted", async () => {
    const events: RuntimeEvent[] = [];
    const sentTurns: Array<{ sessionId: string; payload: { prompt: string; metadata: Record<string, unknown> } }> = [];
    const acceptedRuns = [
      subagentRun({
        id: "run_accepted_recent",
        status: "accepted",
        required: true,
        updatedAt: "2026-07-09T11:58:00.000Z",
      }),
      subagentRun({
        id: "run_accepted_older",
        status: "accepted",
        required: true,
        updatedAt: "2026-07-09T11:00:00.000Z",
      }),
    ];
    const queue = createBackgroundWorkerQueue({ queueId: "subagent" });
    const parentWakeQueue = createBackgroundWorkerQueue({ queueId: "turn-follow-up" });
    const watcher = createSubagentLifecycleWatcher({
      store: {
        listActiveSubagentRuns: async () => [],
        listStaleSubagentRuns: async () => [],
        listSubagentRuns: async (query = {}) => {
          const statuses = query.status
            ? Array.isArray(query.status) ? query.status : [query.status]
            : null;
          return acceptedRuns.filter((run) => {
            if (query.parentSessionId && run.parentSessionId !== query.parentSessionId) return false;
            if (query.parentGoalId && run.parentGoalId !== query.parentGoalId) return false;
            if (statuses && !statuses.includes(run.status)) return false;
            return true;
          });
        },
        turnsForSession: async () => [],
      },
      queue,
      parentWakeQueue,
      loadAppPreferences: async () => AppPreferencesSchema.parse({}),
      appendRuntimeEvent: async (runtimeEvent) => {
        events.push(runtimeEvent);
      },
      getSession: async () => parentSession(),
      sendTurn: async (sessionId, payload) => {
        sentTurns.push({ sessionId, payload });
      },
      isClosing: () => false,
      now: () => new Date("2026-07-09T12:00:00.000Z"),
    });

    const result = await watcher.tickNow("manual");
    await parentWakeQueue.drain();

    expect(result).toMatchObject({
      activeCount: 0,
      wakeQueued: true,
      wakeReasons: ["required_all_accepted"],
      skippedReason: null,
    });
    expect(sentTurns).toHaveLength(1);
    expect(sentTurns[0]!.payload.metadata.subagentLifecycleWake).toMatchObject({
      runIds: ["run_accepted_recent", "run_accepted_older"],
      reasons: ["required_all_accepted"],
    });
    expect(events.find((entry) => entry.data?.kind === "subagent_lifecycle_watcher_tick")).toMatchObject({
      data: {
        acceptedRunIds: ["run_accepted_recent"],
        wakeQueued: true,
        wakePolicy: "waking_parent_for_required_lifecycle_attention",
      },
    });
  });

  test("does not queue duplicate lifecycle wakes or wake while the parent turn is active", async () => {
    const events: RuntimeEvent[] = [];
    const sentTurns: Array<{ sessionId: string; payload: { prompt: string; metadata: Record<string, unknown> } }> = [];
    const activeRun = subagentRun({
      id: "run_revision",
      status: "needs_revision",
      required: true,
      updatedAt: "2026-07-09T11:00:00.000Z",
    });
    const queue = createBackgroundWorkerQueue({ queueId: "subagent" });
    const parentWakeQueue = createBackgroundWorkerQueue({ queueId: "turn-follow-up" });
    let parentActive = false;
    const watcher = createSubagentLifecycleWatcher({
      store: {
        listActiveSubagentRuns: async () => [activeRun],
        listStaleSubagentRuns: async () => [],
        listSubagentRuns: async () => [],
        turnsForSession: async () => [],
      },
      queue,
      parentWakeQueue,
      loadAppPreferences: async () => AppPreferencesSchema.parse({}),
      appendRuntimeEvent: async (runtimeEvent) => {
        events.push(runtimeEvent);
      },
      getSession: async () => parentSession(),
      sendTurn: async (sessionId, payload) => {
        sentTurns.push({ sessionId, payload });
      },
      isSessionActive: () => parentActive,
      isClosing: () => false,
      now: () => new Date("2026-07-09T12:00:00.000Z"),
    });

    const first = await watcher.tickNow("manual");
    await parentWakeQueue.drain();
    const second = await watcher.tickNow("manual");
    await parentWakeQueue.drain();
    parentActive = true;
    const updatedRun = subagentRun({
      id: "run_revision",
      status: "needs_revision",
      required: true,
      updatedAt: "2026-07-09T11:30:00.000Z",
    });
    const activeParentWatcher = createSubagentLifecycleWatcher({
      store: {
        listActiveSubagentRuns: async () => [updatedRun],
        listStaleSubagentRuns: async () => [],
        listSubagentRuns: async () => [],
        turnsForSession: async () => [],
      },
      queue,
      parentWakeQueue,
      loadAppPreferences: async () => AppPreferencesSchema.parse({}),
      appendRuntimeEvent: async (runtimeEvent) => {
        events.push(runtimeEvent);
      },
      getSession: async () => parentSession(),
      sendTurn: async (sessionId, payload) => {
        sentTurns.push({ sessionId, payload });
      },
      isSessionActive: () => parentActive,
      isClosing: () => false,
      now: () => new Date("2026-07-09T12:05:00.000Z"),
    });
    const activeParent = await activeParentWatcher.tickNow("manual");
    await parentWakeQueue.drain();

    expect(first).toMatchObject({ wakeQueued: true, wakeQueuedCount: 1 });
    expect(second).toMatchObject({ wakeQueued: false, wakeSkippedCount: 1 });
    expect(activeParent).toMatchObject({ wakeQueued: false, wakeSkippedCount: 1 });
    expect(sentTurns).toHaveLength(1);
    expect(events.find((entry) => entry.data?.wakeSkippedReason === "parent_turn_active")).toMatchObject({
      data: {
        kind: "subagent_lifecycle_watcher_wake",
        wakeQueued: false,
        wakeSkippedReason: "parent_turn_active",
      },
    });
  });

  test("starts idle and dynamically schedules only while active child runs exist", async () => {
    const events: RuntimeEvent[] = [];
    let activeRuns: SubagentRun[] = [];
    let activeListCalls = 0;
    const queue = createBackgroundWorkerQueue({ queueId: "subagent" });
    const watcher = createSubagentLifecycleWatcher({
      store: {
        listActiveSubagentRuns: async () => {
          activeListCalls += 1;
          return activeRuns;
        },
        listStaleSubagentRuns: async () => [],
        listSubagentRuns: async () => [],
      },
      queue,
      loadAppPreferences: async () =>
        AppPreferencesSchema.parse({ subagents: { heartbeatIntervalSeconds: 10 } }),
      appendRuntimeEvent: async (runtimeEvent) => {
        events.push(runtimeEvent);
      },
      isClosing: () => false,
    });

    watcher.start();
    await waitForWatcherCondition(
      () =>
        activeListCalls > 0 &&
        watcher.status().enabled &&
        watcher.nextTickAt() === null &&
        queue.pendingReceipts().length === 0,
      "watcher should start without scheduling when no active subagents exist",
    );
    expect(watcher.nextTickAt()).toBeNull();

    activeRuns = [subagentRun({ id: "run_dynamic", status: "running", required: true })];
    watcher.notifySubagentRunStateChanged(activeRuns[0]!);
    await waitForWatcherCondition(
      () => watcher.nextTickAt() !== null,
      "watcher should arm when an active subagent appears",
    );
    await queue.drain();

    expect(watcher.nextTickAt()).toEqual(expect.any(String));
    expect(watcher.status()).toMatchObject({
      enabled: true,
      nextTickAt: expect.any(String),
      tickRunning: false,
    });
    expect(events.find((entry) => entry.data?.kind === "subagent_lifecycle_watcher_tick")).toBeUndefined();

    activeRuns = [subagentRun({ id: "run_dynamic", status: "submitted_for_review", required: true })];
    watcher.notifySubagentRunStateChanged(activeRuns[0]!);
    await waitForWatcherCondition(
      () =>
        queue.pendingReceipts().length > 0 ||
        events.some((entry) => entry.data?.kind === "subagent_lifecycle_watcher_tick"),
      "watcher should queue an immediate tick for attention-worthy child state",
    );
    await queue.drain();
    expect(events.find((entry) => entry.data?.kind === "subagent_lifecycle_watcher_tick")).toMatchObject({
      data: {
        reason: "state_change",
        activeRunIds: ["run_dynamic"],
      },
    });

    activeRuns = [];
    watcher.notifySubagentRunStateChanged(null);
    await waitForWatcherCondition(
      () => watcher.nextTickAt() === null,
      "watcher should clear its interval once no active subagents remain",
    );

    watcher.stop();
    expect(watcher.nextTickAt()).toBeNull();
  });

  test("schedules retained workspace warning ticks and replaces later cleanup timers", async () => {
    let runs = [
      subagentRun({
        id: "run_late_retained",
        status: "accepted",
        completedAt: "2026-07-04T10:00:00.000Z",
        updatedAt: "2026-07-04T10:00:00.000Z",
        metadata: {
          lifecycleCleanup: {
            workspaceCleanup: {
              status: "retained",
              reason: "Retain for inspection.",
              retainedAt: "2026-07-04T10:00:00.000Z",
              retentionPolicy: {
                retentionDays: 7,
                expiresAt: "2026-07-11T10:00:00.000Z",
                cleanupAfterExpiry: true,
                trigger: "auto_after_acceptance",
              },
            },
          },
        },
      }),
    ];
    const queue = createBackgroundWorkerQueue({ queueId: "subagent" });
    const watcher = createSubagentLifecycleWatcher({
      store: {
        listActiveSubagentRuns: async () => [],
        listStaleSubagentRuns: async () => [],
        listSubagentRuns: async (query = {}) => {
          if (query.status && Array.isArray(query.status)) {
            return runs.filter((run) => query.status!.includes(run.status));
          }
          return runs;
        },
      },
      queue,
      loadAppPreferences: async () =>
        AppPreferencesSchema.parse({ subagents: { heartbeatIntervalSeconds: 3600 } }),
      appendRuntimeEvent: async () => undefined,
      cleanupExpiredRetainedWorkspace: async ({ run }) => run,
      isClosing: () => false,
      now: () => new Date("2026-07-08T10:00:00.000Z"),
    });

    watcher.start();
    await waitForWatcherCondition(
      () => watcher.nextTickAt() === "2026-07-10T10:00:00.000Z",
      "watcher should schedule the retained workspace warning before cleanup expiry",
    );

    const earlierRun = subagentRun({
      id: "run_early_retained",
      status: "accepted",
      completedAt: "2026-07-03T10:00:00.000Z",
      updatedAt: "2026-07-03T10:00:00.000Z",
      metadata: {
        lifecycleCleanup: {
          workspaceCleanup: {
            status: "retained",
            reason: "Retain for inspection.",
            retainedAt: "2026-07-03T10:00:00.000Z",
            retentionPolicy: {
              retentionDays: 7,
              expiresAt: "2026-07-10T10:00:00.000Z",
              cleanupAfterExpiry: true,
              trigger: "auto_after_acceptance",
            },
          },
        },
      },
    });
    runs = [...runs, earlierRun];
    watcher.notifySubagentRunStateChanged(earlierRun);
    await waitForWatcherCondition(
      () => watcher.nextTickAt() === "2026-07-09T10:00:00.000Z",
      "watcher should replace a later timer when an earlier retained workspace warning is due",
    );

    watcher.stop();
    expect(watcher.nextTickAt()).toBeNull();
  });
});

async function waitForWatcherCondition(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await delay(0);
  }
  throw new Error(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function subagentRun(patch: Partial<SubagentRun> = {}): SubagentRun {
  return SubagentRunSchema.parse({
    id: "run_1",
    parentSessionId: "session_parent",
    parentTurnId: "turn_parent",
    parentGoalId: "goal_1",
    childSessionId: "session_child",
    roleId: "coding",
    objective: "Do the delegated work.",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    isolationMode: "copy_on_write",
    toolPolicy: "workspace_write",
    background: true,
    peerMessages: "goal_scoped",
    status: "running",
    required: true,
    createdAt: "2026-07-09T11:00:00.000Z",
    updatedAt: "2026-07-09T11:30:00.000Z",
    ...patch,
  });
}

function turnFixture(patch: Partial<Turn> = {}): Turn {
  return {
    id: "turn_fixture",
    sessionId: "session_child",
    providerTurnId: null,
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    prompt: "Fixture turn",
    startedAt: "2026-07-09T10:00:00.000Z",
    completedAt: "2026-07-09T12:00:00.000Z",
    status: "completed",
    error: null,
    metadata: {},
    createPipelineRequest: null,
    createPipeline: null,
    ...patch,
  };
}

function parentSession(patch: Partial<Session> = {}): Session {
  return {
    id: "session_parent",
    provider: "openpond",
    modelRef: null,
    title: "Parent session",
    appId: null,
    appName: null,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/tmp/openpond",
    codexThreadId: null,
    createdAt: "2026-07-09T10:00:00.000Z",
    updatedAt: "2026-07-09T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...patch,
  };
}
