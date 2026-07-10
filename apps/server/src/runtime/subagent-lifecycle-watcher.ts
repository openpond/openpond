import { SubagentRunSchema, type AppPreferences, type RuntimeEvent, type Session, type SubagentRun, type Turn } from "@openpond/contracts";
import { event, textFromUnknown } from "../utils.js";
import type { BackgroundWorkerQueue, BackgroundWorkReceipt } from "./background-worker-queue.js";

type SubagentWatcherLogger = {
  warn(message: string, metadata?: Record<string, unknown>): void;
};

export type SubagentLifecycleWatcherTickReason = "manual" | "interval" | "startup" | "state_change";

export type SubagentLifecycleWakeReason =
  | "required_blocked"
  | "required_failed"
  | "required_failed_with_artifacts"
  | "required_submitted_for_review"
  | "required_needs_revision"
  | "required_needs_user_input"
  | "required_stale"
  | "required_all_accepted";

export type SubagentLifecycleWatcherTickResult = {
  checkedAt: string;
  reason: SubagentLifecycleWatcherTickReason;
  activeCount: number;
  requiredActiveCount: number;
  submittedForReviewCount: number;
  needsRevisionCount: number;
  needsUserInputCount: number;
  failedWithArtifactsCount: number;
  staleCount: number;
  optionalStaleCount: number;
  staleAttentionCount: number;
  optionalAutoCancelledCount: number;
  orphanedAutoCancelledCount: number;
  retainedWorkspaceExpiryWarningCount: number;
  expiredRetainedWorkspaceCount: number;
  expiredRetainedWorkspaceCleanedCount: number;
  expiredRetainedWorkspaceFailedCount: number;
  wakeQueued: boolean;
  wakeQueuedCount: number;
  wakeSkippedCount: number;
  wakeReasons: SubagentLifecycleWakeReason[];
  skippedReason: string | null;
};

export type SubagentLifecycleWatcherStatus = {
  nextTickAt: string | null;
  enabled: boolean;
  tickRunning: boolean;
  tickStartedAt: string | null;
};

export type SubagentLifecycleWatcher = {
  start: () => void;
  stop: () => void;
  notifySubagentRunStateChanged: (run?: SubagentRun | null) => void;
  tickNow: (reason?: SubagentLifecycleWatcherTickReason) => Promise<SubagentLifecycleWatcherTickResult>;
  nextTickAt: () => string | null;
  status: () => SubagentLifecycleWatcherStatus;
};

type SubagentLifecycleWatcherStore = {
  listSubagentRunScopes?(query?: {
    status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
    updatedAtFrom?: string | null;
    limit?: number;
  }): Promise<SubagentLifecycleWatcherScope[]>;
  listSubagentRuns?(query?: {
    parentSessionId?: string | null;
    parentGoalId?: string | null;
    childSessionId?: string | null;
    status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
    limit?: number;
  }): Promise<SubagentRun[]>;
  recordRetainedWorkspaceExpiryWarning?(runId: string, warning: RetainedWorkspaceExpiryWarning): Promise<SubagentRun | null>;
  upsertSubagentRun?(run: SubagentRun): Promise<SubagentRun>;
  listActiveSubagentRuns(query?: {
    parentSessionId?: string | null;
    parentGoalId?: string | null;
    childSessionId?: string | null;
    status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
    limit?: number;
  }): Promise<SubagentRun[]>;
  listStaleSubagentRuns?(query: {
    olderThanMs: number;
    nowIso?: string | null;
    parentSessionId?: string | null;
    parentGoalId?: string | null;
    childSessionId?: string | null;
    status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
    limit?: number;
  }): Promise<SubagentRun[]>;
  turnsForSession?(sessionId: string, limit?: number): Promise<Turn[]>;
};

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
const DEFAULT_OPTIONAL_STALE_AUTO_CANCEL_MULTIPLIER = 4;
const WATCHER_JOB_LABEL = "subagent-lifecycle-watch";
const WATCHER_ACTIVE_STATUSES: readonly SubagentRun["status"][] = [
  "queued",
  "running",
  "blocked",
  "submitted_for_review",
  "needs_revision",
  "needs_user_input",
  "failed_with_artifacts",
  "needs_resume",
];
const OPTIONAL_STALE_AUTO_CANCEL_STATUSES = new Set<SubagentRun["status"]>([
  "queued",
  "running",
  "blocked",
  "needs_resume",
]);
const RETAINED_WORKSPACE_SCAN_STATUSES: readonly SubagentRun["status"][] = [
  "submitted_for_review",
  "needs_revision",
  "needs_user_input",
  "accepted",
  "completed",
  "failed",
  "failed_with_artifacts",
  "cancelled",
  "superseded",
];
const RETAINED_WORKSPACE_SCAN_LIMIT = 500;
const RETAINED_WORKSPACE_EXPIRY_WARNING_BEFORE_MS = 24 * 60 * 60 * 1000;

type SubagentLifecycleWatcherScope = {
  parentSessionId: string;
  parentGoalId: string | null;
};

type ScopedSubagentRuns = {
  scope: SubagentLifecycleWatcherScope;
  activeRuns: SubagentRun[];
  staleRuns: SubagentRun[];
  failedRuns: SubagentRun[];
  acceptedRuns: SubagentRun[];
};

type LifecycleWakeCandidate = {
  run: SubagentRun;
  reason: SubagentLifecycleWakeReason;
  stale: boolean;
};

type LifecycleWakeGroup = {
  parentSessionId: string;
  parentGoalId: string | null;
  candidates: LifecycleWakeCandidate[];
  reasons: SubagentLifecycleWakeReason[];
  key: string;
};

type LifecycleWakeDecision = {
  key: string;
  parentSessionId: string;
  parentGoalId: string | null;
  reasons: SubagentLifecycleWakeReason[];
  runIds: string[];
  queued: boolean;
  skippedReason: string | null;
};

type SubagentLifecycleParentWakeInput = {
  prompt: string;
  metadata: Record<string, unknown>;
};

export type RetainedWorkspaceRetention = {
  source: "lifecycleCleanup" | "patchApplyResult";
  reason: string | null;
  retainedAt: string | null;
  expiresAt: string;
  retentionDays: number | null;
  cleanupAfterExpiry: boolean;
  trigger: string | null;
};

type ExpiredRetainedWorkspaceCleanup = {
  run: SubagentRun;
  retention: RetainedWorkspaceRetention;
  cleanedRun: SubagentRun | null;
  status: "cleaned" | "failed";
  error: string | null;
};

type RetainedWorkspaceExpiryWarning = {
  status: "warned";
  policy: "pre_cleanup_notice";
  checkedAt: string;
  warnedAt: string;
  expiresAt: string;
  warningBeforeMs: number;
  source: RetainedWorkspaceRetention["source"];
  reason: string | null;
  cleanupAfterExpiry: boolean;
  trigger: string | null;
};

type ExpiringRetainedWorkspaceWarning = {
  run: SubagentRun;
  retention: RetainedWorkspaceRetention;
  warnedRun: SubagentRun;
  warning: RetainedWorkspaceExpiryWarning;
};

export function createSubagentLifecycleWatcher(options: {
  store: SubagentLifecycleWatcherStore;
  queue: BackgroundWorkerQueue;
  parentWakeQueue?: BackgroundWorkerQueue | null;
  loadAppPreferences: () => Promise<AppPreferences>;
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  getSession?: (sessionId: string) => Promise<Session | null>;
  sendTurn?: (sessionId: string, payload: SubagentLifecycleParentWakeInput) => Promise<unknown>;
  interruptSessionTurn?: (sessionId: string, reason?: string) => Promise<Turn>;
  cleanupExpiredRetainedWorkspace?: (input: {
    run: SubagentRun;
    checkedAt: string;
    retention: RetainedWorkspaceRetention;
  }) => Promise<SubagentRun | null>;
  isSessionActive?: (sessionId: string) => boolean;
  isClosing: () => boolean;
  logger?: SubagentWatcherLogger;
  staleAfterMs?: number;
  optionalStaleAutoCancelAfterMs?: number | null;
  now?: () => Date;
}): SubagentLifecycleWatcher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextTickAtMs: number | null = null;
  let enabled = false;
  let tickInFlight: Promise<SubagentLifecycleWatcherTickResult> | null = null;
  let scheduleRefreshInFlight: Promise<void> | null = null;
  const staleAttentionKeys = new Set<string>();
  const retainedWorkspaceExpiryWarningKeys = new Set<string>();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const optionalStaleAutoCancelAfterMs = options.optionalStaleAutoCancelAfterMs === null
    ? null
    : Math.max(
      staleAfterMs,
      options.optionalStaleAutoCancelAfterMs ?? staleAfterMs * DEFAULT_OPTIONAL_STALE_AUTO_CANCEL_MULTIPLIER,
    );
  const nowDate = options.now ?? (() => new Date());

  function scheduledTickAt(): string | null {
    return nextTickAtMs === null ? null : new Date(nextTickAtMs).toISOString();
  }

  function currentTickReceipt(): BackgroundWorkReceipt | null {
    return options.queue
      .pendingReceipts()
      .find((receipt) => receipt.label === WATCHER_JOB_LABEL && receipt.status === "running") ?? null;
  }

  function clearScheduledTick(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    nextTickAtMs = null;
  }

  async function runTick(reason: SubagentLifecycleWatcherTickReason): Promise<SubagentLifecycleWatcherTickResult> {
    const checkedAt = nowDate().toISOString();
    const preferences = await options.loadAppPreferences();
    if (!preferences.subagents.enabled) {
      return {
        checkedAt,
        reason,
        activeCount: 0,
        requiredActiveCount: 0,
        submittedForReviewCount: 0,
        needsRevisionCount: 0,
        needsUserInputCount: 0,
        failedWithArtifactsCount: 0,
        staleCount: 0,
        optionalStaleCount: 0,
        staleAttentionCount: 0,
        optionalAutoCancelledCount: 0,
        orphanedAutoCancelledCount: 0,
        retainedWorkspaceExpiryWarningCount: 0,
        expiredRetainedWorkspaceCount: 0,
        expiredRetainedWorkspaceCleanedCount: 0,
        expiredRetainedWorkspaceFailedCount: 0,
        wakeQueued: false,
        wakeQueuedCount: 0,
        wakeSkippedCount: 0,
        wakeReasons: [],
        skippedReason: "subagents_disabled",
      };
    }

    const scopedRuns = await loadScopedRunSets(checkedAt);
    const activeRuns = uniqueRuns(scopedRuns.flatMap((scope) => scope.activeRuns));
    const failedRuns = uniqueRuns(scopedRuns.flatMap((scope) => scope.failedRuns));
    const acceptedRuns = uniqueRuns(scopedRuns.flatMap((scope) => scope.acceptedRuns));
    const expiredRetainedWorkspaceRuns = await loadExpiredRetainedWorkspaceRuns(checkedAt);
    const expiredRetainedWorkspaceCleanups = await cleanupExpiredRetainedWorkspaces({
      checkedAt,
      runs: expiredRetainedWorkspaceRuns,
    });
    const expiringRetainedWorkspaceRuns = await loadExpiringRetainedWorkspaceRuns(checkedAt);
    const retainedWorkspaceExpiryWarnings = await appendExpiringRetainedWorkspaceWarnings({
      checkedAt,
      runs: expiringRetainedWorkspaceRuns,
    });
    if (
      activeRuns.length === 0 &&
      failedRuns.length === 0 &&
      acceptedRuns.length === 0 &&
      expiredRetainedWorkspaceRuns.length === 0 &&
      retainedWorkspaceExpiryWarnings.length === 0
    ) {
      return {
        checkedAt,
        reason,
        activeCount: 0,
        requiredActiveCount: 0,
        submittedForReviewCount: 0,
        needsRevisionCount: 0,
        needsUserInputCount: 0,
        failedWithArtifactsCount: 0,
        staleCount: 0,
        optionalStaleCount: 0,
        staleAttentionCount: 0,
        optionalAutoCancelledCount: 0,
        orphanedAutoCancelledCount: 0,
        retainedWorkspaceExpiryWarningCount: 0,
        expiredRetainedWorkspaceCount: 0,
        expiredRetainedWorkspaceCleanedCount: 0,
        expiredRetainedWorkspaceFailedCount: 0,
        wakeQueued: false,
        wakeQueuedCount: 0,
        wakeSkippedCount: 0,
        wakeReasons: [],
        skippedReason: "no_active_subagents",
      };
    }

    const staleRuns = uniqueRuns(scopedRuns.flatMap((scope) => scope.staleRuns));
    const orphanedAutoCancelledRuns = await autoCancelOrphanedRuns({
      checkedAt,
      activeRuns,
    });
    const orphanedAutoCancelledRunIds = new Set(orphanedAutoCancelledRuns.map((run) => run.id));
    const remainingActiveRuns = activeRuns.filter((run) => !orphanedAutoCancelledRunIds.has(run.id));
    const remainingStaleRuns = staleRuns.filter((run) => !orphanedAutoCancelledRunIds.has(run.id));
    const staleAttentionRuns = remainingStaleRuns;
    const autoCancelledRuns = await autoCancelOptionalStaleRuns({
      checkedAt,
      staleRuns: remainingStaleRuns,
    });
    const optionalAutoCancelledRunIds = new Set(autoCancelledRuns.map((run) => run.id));
    const wakeActiveRuns = remainingActiveRuns.filter((run) => !optionalAutoCancelledRunIds.has(run.id));
    const wakeStaleRuns = remainingStaleRuns.filter((run) => !optionalAutoCancelledRunIds.has(run.id));
    const wakeDecisions = await maybeQueueParentLifecycleWakes({
      checkedAt,
      activeRuns: wakeActiveRuns,
      staleRuns: wakeStaleRuns,
      failedRuns,
      acceptedRuns,
    });
    const queuedWakeDecisions = wakeDecisions.filter((decision) => decision.queued);
    const skippedWakeDecisions = wakeDecisions.filter((decision) => !decision.queued);
    const wakeReasons = uniqueWakeReasons(wakeDecisions.flatMap((decision) => decision.reasons));
    const result: SubagentLifecycleWatcherTickResult = {
      checkedAt,
      reason,
      activeCount: remainingActiveRuns.length,
      requiredActiveCount: remainingActiveRuns.filter((run) => run.required).length,
      submittedForReviewCount: remainingActiveRuns.filter((run) => run.status === "submitted_for_review").length,
      needsRevisionCount: remainingActiveRuns.filter((run) => run.status === "needs_revision").length,
      needsUserInputCount: remainingActiveRuns.filter((run) => run.status === "needs_user_input").length,
      failedWithArtifactsCount: remainingActiveRuns.filter((run) => run.status === "failed_with_artifacts").length,
      staleCount: remainingStaleRuns.length,
      optionalStaleCount: remainingStaleRuns.filter((run) => !run.required).length,
      staleAttentionCount: staleAttentionRuns.length,
      optionalAutoCancelledCount: autoCancelledRuns.length,
      orphanedAutoCancelledCount: orphanedAutoCancelledRuns.length,
      retainedWorkspaceExpiryWarningCount: retainedWorkspaceExpiryWarnings.length,
      expiredRetainedWorkspaceCount: expiredRetainedWorkspaceRuns.length,
      expiredRetainedWorkspaceCleanedCount: expiredRetainedWorkspaceCleanups.filter((item) => item.status === "cleaned").length,
      expiredRetainedWorkspaceFailedCount: expiredRetainedWorkspaceCleanups.filter((item) => item.status === "failed").length,
      wakeQueued: queuedWakeDecisions.length > 0,
      wakeQueuedCount: queuedWakeDecisions.length,
      wakeSkippedCount: skippedWakeDecisions.length,
      wakeReasons,
      skippedReason: null,
    };
    const tickSessionId = singleParentSessionId(scopedRuns)
      ?? singleParentSessionIdFromRuns(expiredRetainedWorkspaceRuns)
      ?? singleParentSessionIdFromRuns(expiringRetainedWorkspaceRuns);
    await options.appendRuntimeEvent(
      event({
        ...(tickSessionId ? { sessionId: tickSessionId } : {}),
        name: "diagnostic",
        source: "server",
        status: "completed",
        output: `Subagent watcher checked ${remainingActiveRuns.length} active run${remainingActiveRuns.length === 1 ? "" : "s"}.`,
        data: {
          kind: "subagent_lifecycle_watcher_tick",
          ...result,
          activeRunIds: remainingActiveRuns.map((run) => run.id),
          staleRunIds: remainingStaleRuns.map((run) => run.id),
          requiredStaleRunIds: remainingStaleRuns.filter((run) => run.required).map((run) => run.id),
          optionalStaleRunIds: remainingStaleRuns.filter((run) => !run.required).map((run) => run.id),
          staleAttentionRunIds: staleAttentionRuns.map((run) => run.id),
          optionalStaleAutoCancelRunIds: autoCancelledRuns.map((run) => run.id),
          orphanedAutoCancelRunIds: orphanedAutoCancelledRuns.map((run) => run.id),
          retainedWorkspaceExpiryWarningRunIds: retainedWorkspaceExpiryWarnings.map((item) => item.run.id),
          expiredRetainedWorkspaceRunIds: expiredRetainedWorkspaceRuns.map((run) => run.id),
          expiredRetainedWorkspaceCleanedRunIds: expiredRetainedWorkspaceCleanups
            .filter((item) => item.status === "cleaned")
            .map((item) => item.run.id),
          expiredRetainedWorkspaceFailedRunIds: expiredRetainedWorkspaceCleanups
            .filter((item) => item.status === "failed")
            .map((item) => item.run.id),
          scopeKeys: scopedRuns.map((item) => subagentWatcherScopeKey(item.scope)),
          parentSessionIds: uniqueStrings([
            ...scopedRuns.map((item) => item.scope.parentSessionId),
            ...expiringRetainedWorkspaceRuns.map((run) => run.parentSessionId),
            ...expiredRetainedWorkspaceRuns.map((run) => run.parentSessionId),
          ]),
          parentGoalIds: uniqueStrings([
            ...scopedRuns.map((item) => item.scope.parentGoalId ?? ""),
            ...expiringRetainedWorkspaceRuns.map((run) => run.parentGoalId ?? ""),
            ...expiredRetainedWorkspaceRuns.map((run) => run.parentGoalId ?? ""),
          ]),
          failedRunIds: failedRuns.map((run) => run.id),
          acceptedRunIds: acceptedRuns.map((run) => run.id),
          wakeDecisionKeys: wakeDecisions.map((decision) => decision.key),
          wakeQueuedParentSessionIds: queuedWakeDecisions.map((decision) => decision.parentSessionId),
          wakeSkippedParentSessionIds: skippedWakeDecisions.map((decision) => decision.parentSessionId),
          wakePolicy: wakeReasons.length
            ? "waking_parent_for_required_lifecycle_attention"
            : orphanedAutoCancelledRuns.length > 0
              ? "auto_cancelled_orphaned_subagents"
              : autoCancelledRuns.length > 0
                ? "auto_cancelled_optional_stale_subagents"
                : expiredRetainedWorkspaceCleanups.length > 0
                  ? "cleaned_expired_retained_workspaces"
                  : retainedWorkspaceExpiryWarnings.length > 0
                    ? "not_waking_parent_for_retained_workspace_expiry_warning"
                  : "not_waking_parent_for_routine_tick",
        },
      }),
    );
    await appendStaleAttentionReceipts({
      checkedAt,
      staleRuns: staleAttentionRuns,
      autoCancelledRunsById: new Map(autoCancelledRuns.map((run) => [run.id, run])),
    });
    return result;
  }

  async function autoCancelOrphanedRuns(input: {
    checkedAt: string;
    activeRuns: SubagentRun[];
  }): Promise<SubagentRun[]> {
    if (!options.getSession || !options.store.upsertSubagentRun) return [];
    const parentSessions = new Map<string, Session | null>();
    const cancelledRuns: SubagentRun[] = [];
    for (const run of input.activeRuns) {
      let parentSession: Session | null;
      if (parentSessions.has(run.parentSessionId)) {
        parentSession = parentSessions.get(run.parentSessionId) ?? null;
      } else {
        parentSession = await options.getSession(run.parentSessionId).catch(() => null);
        parentSessions.set(run.parentSessionId, parentSession);
      }
      if (parentSession && !parentSession.archived) continue;
      const cancelled = await autoCancelOrphanedRun({
        checkedAt: input.checkedAt,
        run,
        parentSession,
      });
      if (cancelled) cancelledRuns.push(cancelled);
    }
    return cancelledRuns;
  }

  async function autoCancelOrphanedRun(input: {
    checkedAt: string;
    run: SubagentRun;
    parentSession: Session | null;
  }): Promise<SubagentRun | null> {
    const parentMissing = !input.parentSession;
    const policy = parentMissing ? "parent_session_missing" : "parent_session_archived";
    const reason = parentMissing
      ? "Parent session for subagent is missing; lifecycle watcher cancelled orphaned child work."
      : "Parent session for subagent is archived; lifecycle watcher cancelled orphaned child work.";
    const interruptResult = await interruptChildRun(input.run, reason);
    const orphanAutoCancel = {
      status: "cancelled",
      policy,
      reason,
      checkedAt: input.checkedAt,
      cancelledAt: input.checkedAt,
      parentSessionId: input.run.parentSessionId,
      parentSessionArchived: input.parentSession?.archived ?? null,
      previousStatus: input.run.status,
      previousUpdatedAt: input.run.updatedAt ?? input.run.completedAt ?? input.run.startedAt ?? input.run.createdAt,
      interruptResult,
    };
    const updated = SubagentRunSchema.parse({
      ...input.run,
      status: "cancelled",
      completedAt: input.checkedAt,
      updatedAt: input.checkedAt,
      error: reason,
      report: {
        ...(input.run.report ?? {}),
        summary: input.run.report?.summary || "Orphaned subagent auto-cancelled.",
        blockers: uniqueNonEmptyStrings([
          ...(input.run.report?.blockers ?? []),
          reason,
        ]),
        followUpNeeded: false,
      },
      metadata: {
        ...(input.run.metadata ?? {}),
        orphanAutoCancel,
      },
    });
    try {
      const saved = await options.store.upsertSubagentRun!(updated);
      await options.appendRuntimeEvent(
        event({
          sessionId: saved.parentSessionId,
          turnId: saved.parentTurnId ?? undefined,
          name: "subagent.cancelled",
          source: "server",
          status: "completed",
          output: `${saved.roleId} orphaned subagent auto-cancelled.`,
          data: {
            run: saved,
            orphanAutoCancel,
          },
        }),
      );
      return saved;
    } catch (error) {
      await options.appendRuntimeEvent(
        event({
          sessionId: input.run.parentSessionId,
          turnId: input.run.parentTurnId ?? undefined,
          name: "diagnostic",
          source: "server",
          status: "failed",
          output: textFromUnknown(error) || "Failed to auto-cancel orphaned subagent.",
          data: {
            kind: "subagent_lifecycle_watcher_orphan_auto_cancel_failed",
            runId: input.run.id,
            checkedAt: input.checkedAt,
            policy,
            error: textFromUnknown(error) || "Unknown orphan auto-cancel failure.",
          },
        }),
      );
      return null;
    }
  }

  async function autoCancelOptionalStaleRuns(input: {
    checkedAt: string;
    staleRuns: SubagentRun[];
  }): Promise<SubagentRun[]> {
    if (!options.store.upsertSubagentRun || optionalStaleAutoCancelAfterMs === null) return [];
    const candidates = input.staleRuns.filter((run) =>
      !run.required &&
      OPTIONAL_STALE_AUTO_CANCEL_STATUSES.has(run.status) &&
      subagentRunAgeMs(run, input.checkedAt) >= optionalStaleAutoCancelAfterMs
    );
    const cancelledRuns: SubagentRun[] = [];
    for (const run of candidates) {
      const cancelled = await autoCancelOptionalStaleRun({
        checkedAt: input.checkedAt,
        run,
      });
      if (cancelled) cancelledRuns.push(cancelled);
    }
    return cancelledRuns;
  }

  async function autoCancelOptionalStaleRun(input: {
    checkedAt: string;
    run: SubagentRun;
  }): Promise<SubagentRun | null> {
    const reason = "Optional stale subagent auto-cancelled by lifecycle watcher.";
    const interruptResult = await interruptChildRun(input.run, reason);
    const staleAutoCancel = {
      status: "cancelled",
      policy: "optional_stale_auto_cancel",
      reason,
      checkedAt: input.checkedAt,
      cancelledAt: input.checkedAt,
      staleAfterMs,
      autoCancelAfterMs: optionalStaleAutoCancelAfterMs,
      previousStatus: input.run.status,
      previousUpdatedAt: input.run.updatedAt ?? input.run.completedAt ?? input.run.startedAt ?? input.run.createdAt,
      interruptResult,
    };
    const updated = SubagentRunSchema.parse({
      ...input.run,
      status: "cancelled",
      completedAt: input.checkedAt,
      updatedAt: input.checkedAt,
      error: reason,
      report: {
        ...(input.run.report ?? {}),
        summary: input.run.report?.summary || "Optional stale subagent auto-cancelled.",
        blockers: uniqueNonEmptyStrings([
          ...(input.run.report?.blockers ?? []),
          reason,
        ]),
        followUpNeeded: false,
      },
      metadata: {
        ...(input.run.metadata ?? {}),
        staleAutoCancel,
      },
    });
    try {
      const saved = await options.store.upsertSubagentRun!(updated);
      await options.appendRuntimeEvent(
        event({
          sessionId: saved.parentSessionId,
          turnId: saved.parentTurnId ?? undefined,
          name: "subagent.cancelled",
          source: "server",
          status: "completed",
          output: `${saved.roleId} optional stale subagent auto-cancelled.`,
          data: {
            run: saved,
            staleAutoCancel,
          },
        }),
      );
      return saved;
    } catch (error) {
      await options.appendRuntimeEvent(
        event({
          sessionId: input.run.parentSessionId,
          turnId: input.run.parentTurnId ?? undefined,
          name: "diagnostic",
          source: "server",
          status: "failed",
          output: textFromUnknown(error) || "Failed to auto-cancel optional stale subagent.",
          data: {
            kind: "subagent_lifecycle_watcher_auto_cancel_failed",
            runId: input.run.id,
            checkedAt: input.checkedAt,
            policy: "optional_stale_auto_cancel",
            error: textFromUnknown(error) || "Unknown auto-cancel failure.",
          },
        }),
      );
      return null;
    }
  }

  async function loadExpiredRetainedWorkspaceRuns(checkedAt: string): Promise<SubagentRun[]> {
    if (!options.cleanupExpiredRetainedWorkspace || !options.store.listSubagentRuns) return [];
    const runs = await options.store.listSubagentRuns({
      status: RETAINED_WORKSPACE_SCAN_STATUSES,
      limit: RETAINED_WORKSPACE_SCAN_LIMIT,
    }).catch(() => []);
    return uniqueRuns(runs.filter((run) => {
      const retention = retainedWorkspaceRetentionForRun(run);
      return retention ? retentionExpired(retention, checkedAt) : false;
    }));
  }

  async function loadExpiringRetainedWorkspaceRuns(checkedAt: string): Promise<SubagentRun[]> {
    if (!options.cleanupExpiredRetainedWorkspace || !options.store.listSubagentRuns) return [];
    const runs = await options.store.listSubagentRuns({
      status: RETAINED_WORKSPACE_SCAN_STATUSES,
      limit: RETAINED_WORKSPACE_SCAN_LIMIT,
    }).catch(() => []);
    return uniqueRuns(runs.filter((run) => {
      const retention = retainedWorkspaceRetentionForRun(run);
      if (!retention || !retentionWarningDue(retention, checkedAt)) return false;
      const key = retainedWorkspaceExpiryWarningKey(run, retention);
      return !retainedWorkspaceExpiryWarningKeys.has(key) &&
        !retainedWorkspaceExpiryWarningRecorded(run, retention);
    }));
  }

  async function cleanupExpiredRetainedWorkspaces(input: {
    checkedAt: string;
    runs: SubagentRun[];
  }): Promise<ExpiredRetainedWorkspaceCleanup[]> {
    if (!options.cleanupExpiredRetainedWorkspace || input.runs.length === 0) return [];
    const results: ExpiredRetainedWorkspaceCleanup[] = [];
    for (const run of input.runs) {
      const retention = retainedWorkspaceRetentionForRun(run);
      if (!retention || !retentionExpired(retention, input.checkedAt)) continue;
      try {
        const cleanedRun = await options.cleanupExpiredRetainedWorkspace({
          run,
          checkedAt: input.checkedAt,
          retention,
        });
        results.push({
          run,
          retention,
          cleanedRun,
          status: "cleaned",
          error: null,
        });
      } catch (error) {
        const message = textFromUnknown(error) || "Failed to clean expired retained subagent workspace.";
        results.push({
          run,
          retention,
          cleanedRun: null,
          status: "failed",
          error: message,
        });
        await options.appendRuntimeEvent(
          event({
            sessionId: run.parentSessionId,
            turnId: run.parentTurnId ?? undefined,
            name: "diagnostic",
            source: "server",
            status: "failed",
            output: message,
            data: {
              kind: "subagent_lifecycle_watcher_retained_workspace_cleanup_failed",
              runId: run.id,
              checkedAt: input.checkedAt,
              retention,
              error: message,
            },
          }),
        ).catch(() => undefined);
      }
    }
    return results;
  }

  async function appendExpiringRetainedWorkspaceWarnings(input: {
    checkedAt: string;
    runs: SubagentRun[];
  }): Promise<ExpiringRetainedWorkspaceWarning[]> {
    if (input.runs.length === 0) return [];
    const warnings: ExpiringRetainedWorkspaceWarning[] = [];
    for (const run of input.runs) {
      const retention = retainedWorkspaceRetentionForRun(run);
      if (!retention || !retentionWarningDue(retention, input.checkedAt)) continue;
      const key = retainedWorkspaceExpiryWarningKey(run, retention);
      if (retainedWorkspaceExpiryWarningKeys.has(key) || retainedWorkspaceExpiryWarningRecorded(run, retention)) continue;
      const warning: RetainedWorkspaceExpiryWarning = {
        status: "warned",
        policy: "pre_cleanup_notice",
        checkedAt: input.checkedAt,
        warnedAt: input.checkedAt,
        expiresAt: retention.expiresAt,
        warningBeforeMs: RETAINED_WORKSPACE_EXPIRY_WARNING_BEFORE_MS,
        source: retention.source,
        reason: retention.reason,
        cleanupAfterExpiry: retention.cleanupAfterExpiry,
        trigger: retention.trigger,
      };
      const warnedRun = await recordRetainedWorkspaceExpiryWarning(run, warning);
      await options.appendRuntimeEvent(
        event({
          sessionId: warnedRun.parentSessionId,
          turnId: warnedRun.parentTurnId ?? undefined,
          name: "subagent.workspace_retention_expiring",
          source: "server",
          status: "pending",
          output: `${warnedRun.roleId} retained workspace expires at ${retention.expiresAt}.`,
          data: {
            run: warnedRun,
            retention,
            warning,
          },
        }),
      );
      retainedWorkspaceExpiryWarningKeys.add(key);
      warnings.push({
        run,
        retention,
        warnedRun,
        warning,
      });
    }
    return warnings;
  }

  async function recordRetainedWorkspaceExpiryWarning(
    run: SubagentRun,
    warning: RetainedWorkspaceExpiryWarning,
  ): Promise<SubagentRun> {
    const localRun = SubagentRunSchema.parse({
      ...run,
      metadata: {
        ...(run.metadata ?? {}),
        retainedWorkspaceExpiryWarning: warning,
      },
    });
    if (!options.store.recordRetainedWorkspaceExpiryWarning) return localRun;
    try {
      return await options.store.recordRetainedWorkspaceExpiryWarning(run.id, warning) ?? localRun;
    } catch (error) {
      await options.appendRuntimeEvent(
        event({
          sessionId: run.parentSessionId,
          turnId: run.parentTurnId ?? undefined,
          name: "diagnostic",
          source: "server",
          status: "failed",
          output: textFromUnknown(error) || "Failed to persist retained workspace expiry warning.",
          data: {
            kind: "subagent_lifecycle_watcher_retained_workspace_warning_persist_failed",
            runId: run.id,
            warning,
            error: textFromUnknown(error) || "Unknown retained workspace expiry warning persistence failure.",
          },
        }),
      ).catch(() => undefined);
      return localRun;
    }
  }

  async function interruptChildRun(run: SubagentRun, reason: string): Promise<Record<string, unknown> | null> {
    if (!run.childSessionId || !options.interruptSessionTurn) return null;
    try {
      const interrupted = await options.interruptSessionTurn(run.childSessionId, reason);
      return {
        status: interrupted.status,
        turnId: interrupted.id,
      };
    } catch (error) {
      return {
        status: "failed",
        error: textFromUnknown(error) || "Failed to interrupt child turn.",
      };
    }
  }

  async function appendStaleAttentionReceipts(input: {
    checkedAt: string;
    staleRuns: SubagentRun[];
    autoCancelledRunsById: Map<string, SubagentRun>;
  }): Promise<void> {
    for (const run of input.staleRuns) {
      const key = staleAttentionKey(run);
      if (staleAttentionKeys.has(key)) continue;
      staleAttentionKeys.add(key);
      const receiptRun = input.autoCancelledRunsById.get(run.id) ?? run;
      const autoCancelled = input.autoCancelledRunsById.has(run.id);
      await options.appendRuntimeEvent(
        event({
          sessionId: receiptRun.parentSessionId,
          turnId: receiptRun.parentTurnId ?? undefined,
          name: "subagent.stale",
          source: "server",
          status: "pending",
          output: autoCancelled
            ? `${run.roleId} optional subagent was stale and auto-cancelled.`
            : run.required
            ? `${run.roleId} required subagent is stale and blocking attention.`
            : `${run.roleId} optional subagent is stale and can be cancelled or resumed.`,
          data: {
            run: receiptRun,
            stale: {
              checkedAt: input.checkedAt,
              staleAfterMs,
              autoCancelAfterMs: optionalStaleAutoCancelAfterMs,
              autoCancelled,
              required: run.required,
              attentionNeeded: true,
              cancellable: !run.required,
              policy: run.required
                ? "required_blocker"
                : autoCancelled
                  ? "optional_stale_auto_cancel"
                  : "optional_attention",
            },
          },
        }),
      );
    }
  }

  async function loadScopedRunSets(checkedAt: string): Promise<ScopedSubagentRuns[]> {
    return loadGlobalScopedRunSets(checkedAt);
  }

  async function loadGlobalScopedRunSets(checkedAt: string): Promise<ScopedSubagentRuns[]> {
    const [activeRuns, rawFailedRuns, rawAcceptedRuns, staleRuns] = await Promise.all([
      options.store.listActiveSubagentRuns({ limit: 500 }),
      options.store.listSubagentRuns
        ? options.store.listSubagentRuns({ status: "failed", limit: 500 })
        : Promise.resolve([]),
      options.store.listSubagentRuns
        ? options.store.listSubagentRuns({ status: ["accepted", "completed"], limit: 500 })
        : Promise.resolve([]),
      options.store.listStaleSubagentRuns
        ? options.store.listStaleSubagentRuns({
            olderThanMs: staleAfterMs,
            nowIso: checkedAt,
            limit: 500,
          })
        : Promise.resolve([]),
    ]);
    const failedRuns = rawFailedRuns
      .filter((run) => run.required && terminalRunUpdatedWithin(run, checkedAt, staleAfterMs));
    const acceptedRuns = rawAcceptedRuns
      .filter((run) => run.required && terminalRunUpdatedWithin(run, checkedAt, staleAfterMs));
    const scopes = uniqueSubagentWatcherScopes([
      ...activeRuns,
      ...failedRuns,
      ...acceptedRuns,
      ...staleRuns,
    ].map(subagentWatcherScopeFromRun));
    return scopes.map((scope) => ({
      scope,
      activeRuns: runsInScope(activeRuns, scope),
      staleRuns: runsInScope(staleRuns, scope),
      failedRuns: runsInScope(failedRuns, scope),
      acceptedRuns: runsInScope(acceptedRuns, scope),
    })).filter((item) =>
      item.activeRuns.length > 0 ||
      item.staleRuns.length > 0 ||
      item.failedRuns.length > 0 ||
      item.acceptedRuns.length > 0
    );
  }

  async function maybeQueueParentLifecycleWakes(input: {
    checkedAt: string;
    activeRuns: SubagentRun[];
    staleRuns: SubagentRun[];
    failedRuns: SubagentRun[];
    acceptedRuns: SubagentRun[];
  }): Promise<LifecycleWakeDecision[]> {
    if (!options.parentWakeQueue || !options.getSession || !options.sendTurn) return [];
    const groups = [
      ...lifecycleWakeGroups(input),
      ...await allRequiredAcceptedWakeGroups(input.acceptedRuns),
    ];
    const decisions: LifecycleWakeDecision[] = [];
    for (const group of groups) {
      decisions.push(await queueParentLifecycleWake(group, input.checkedAt));
    }
    return decisions;
  }

  function lifecycleWakeGroups(input: {
    activeRuns: SubagentRun[];
    staleRuns: SubagentRun[];
    failedRuns: SubagentRun[];
  }): LifecycleWakeGroup[] {
    const candidates: LifecycleWakeCandidate[] = [];
    const staleRunIds = new Set(input.staleRuns.map((run) => run.id));
    for (const run of uniqueRuns([...input.activeRuns, ...input.failedRuns])) {
      const reason = requiredLifecycleWakeReason(run);
      if (reason) candidates.push({ run, reason, stale: false });
      if (run.required && staleRunIds.has(run.id)) candidates.push({ run, reason: "required_stale", stale: true });
    }
    for (const run of input.staleRuns) {
      if (run.required && !candidates.some((candidate) => candidate.run.id === run.id && candidate.reason === "required_stale")) {
        candidates.push({ run, reason: "required_stale", stale: true });
      }
    }

    const grouped = new Map<string, LifecycleWakeCandidate[]>();
    for (const candidate of candidates) {
      if (!candidate.run.parentSessionId) continue;
      const scopeKey = `${candidate.run.parentSessionId}:${candidate.run.parentGoalId ?? "thread"}`;
      const scoped = grouped.get(scopeKey) ?? [];
      scoped.push(candidate);
      grouped.set(scopeKey, scoped);
    }

    return [...grouped.values()].map((groupCandidates) => {
      const first = groupCandidates[0]!.run;
      const reasons = uniqueWakeReasons(groupCandidates.map((candidate) => candidate.reason));
      return {
        parentSessionId: first.parentSessionId,
        parentGoalId: first.parentGoalId ?? null,
        candidates: groupCandidates,
        reasons,
        key: lifecycleWakeKey(first.parentSessionId, first.parentGoalId ?? null, groupCandidates),
      };
    });
  }

  async function allRequiredAcceptedWakeGroups(recentAcceptedRuns: SubagentRun[]): Promise<LifecycleWakeGroup[]> {
    if (!options.store.listSubagentRuns || recentAcceptedRuns.length === 0) return [];
    const scopes = new Map<string, { parentSessionId: string; parentGoalId: string | null }>();
    for (const run of recentAcceptedRuns) {
      scopes.set(`${run.parentSessionId}:${run.parentGoalId ?? "thread"}`, {
        parentSessionId: run.parentSessionId,
        parentGoalId: run.parentGoalId ?? null,
      });
    }

    const allRuns = await options.store.listSubagentRuns({ limit: 10_000 });
    const runsByScope = new Map<string, SubagentRun[]>();
    for (const run of allRuns) {
      const key = subagentWatcherScopeKey(subagentWatcherScopeFromRun(run));
      const scoped = runsByScope.get(key) ?? [];
      scoped.push(run);
      runsByScope.set(key, scoped);
    }
    const groups: LifecycleWakeGroup[] = [];
    for (const scope of scopes.values()) {
      const scopedRuns = runsByScope.get(subagentWatcherScopeKey(scope)) ?? [];
      const requiredRuns = scopedRuns.filter((run) => run.required);
      if (requiredRuns.length === 0 || !requiredRuns.every(subagentRunAcceptedForWatcher)) continue;
      const candidates = requiredRuns.map((run): LifecycleWakeCandidate => ({
        run,
        reason: "required_all_accepted",
        stale: false,
      }));
      groups.push({
        parentSessionId: scope.parentSessionId,
        parentGoalId: scope.parentGoalId,
        candidates,
        reasons: ["required_all_accepted"],
        key: lifecycleWakeKey(scope.parentSessionId, scope.parentGoalId, candidates),
      });
    }
    return groups;
  }

  async function queueParentLifecycleWake(
    group: LifecycleWakeGroup,
    checkedAt: string,
  ): Promise<LifecycleWakeDecision> {
    const runIds = uniqueStrings(group.candidates.map((candidate) => candidate.run.id));
    const baseDecision: Omit<LifecycleWakeDecision, "queued" | "skippedReason"> = {
      key: group.key,
      parentSessionId: group.parentSessionId,
      parentGoalId: group.parentGoalId,
      reasons: group.reasons,
      runIds,
    };
    if (!options.parentWakeQueue || !options.getSession || !options.sendTurn) {
      return { ...baseDecision, queued: false, skippedReason: "wake_dependencies_missing" };
    }
    if (options.isSessionActive?.(group.parentSessionId)) {
      await appendLifecycleWakeDiagnostic(group, {
        checkedAt,
        queued: false,
        skippedReason: "parent_turn_active",
        parentSession: null,
      });
      return { ...baseDecision, queued: false, skippedReason: "parent_turn_active" };
    }
    if (await lifecycleWakeAlreadyRequested(group)) {
      return { ...baseDecision, queued: false, skippedReason: "wake_already_requested" };
    }

    const parentSession = await options.getSession(group.parentSessionId).catch(() => null);
    if (!parentSession) {
      await appendLifecycleWakeDiagnostic(group, {
        checkedAt,
        queued: false,
        skippedReason: "parent_session_missing",
        parentSession: null,
      });
      return { ...baseDecision, queued: false, skippedReason: "parent_session_missing" };
    }

    const requestedAt = checkedAt;
    const prompt = subagentLifecycleWakePrompt(group);
    options.parentWakeQueue.enqueue(
      {
        label: "Subagent lifecycle parent wake",
        metadata: {
          kind: "subagent_lifecycle_wake",
          wakeKey: group.key,
          parentSessionId: group.parentSessionId,
          parentGoalId: group.parentGoalId,
          runIds,
          reasons: group.reasons,
        },
      },
      async () => {
        try {
          await options.sendTurn!(group.parentSessionId, {
            prompt,
            metadata: {
              subagentLifecycleWake: {
                key: group.key,
                parentSessionId: group.parentSessionId,
                parentGoalId: group.parentGoalId,
                runIds,
                reasons: group.reasons,
                requestedAt,
              },
            },
          });
        } catch (error) {
          await options.appendRuntimeEvent(
            event({
              sessionId: group.parentSessionId,
              name: "diagnostic",
              source: "server",
              appId: parentSession.appId,
              status: "failed",
              output: textFromUnknown(error) || "Failed to wake parent for subagent lifecycle attention.",
              data: {
                kind: "subagent_lifecycle_watcher_wake_failed",
                wakeKey: group.key,
                parentSessionId: group.parentSessionId,
                parentGoalId: group.parentGoalId,
                runIds,
                reasons: group.reasons,
              },
            }),
          ).catch(() => undefined);
          throw error;
        }
      },
    );
    await appendLifecycleWakeDiagnostic(group, {
      checkedAt,
      queued: true,
      skippedReason: null,
      parentSession,
    });
    return { ...baseDecision, queued: true, skippedReason: null };
  }

  async function lifecycleWakeAlreadyRequested(group: LifecycleWakeGroup): Promise<boolean> {
    const queue = options.parentWakeQueue;
    if (queue?.receipts().some((receipt) => receipt.status !== "failed" && receipt.metadata.wakeKey === group.key)) return true;
    if (!options.store.turnsForSession) return false;
    const turns = await options.store.turnsForSession(group.parentSessionId, 100).catch(() => []);
    return turns.some((turn) => {
      const wake = recordFromUnknown(turn.metadata?.subagentLifecycleWake);
      return wake?.key === group.key;
    });
  }

  async function appendLifecycleWakeDiagnostic(
    group: LifecycleWakeGroup,
    input: {
      checkedAt: string;
      queued: boolean;
      skippedReason: string | null;
      parentSession: Session | null;
    },
  ): Promise<void> {
    await options.appendRuntimeEvent(
      event({
        sessionId: group.parentSessionId,
        name: "diagnostic",
        source: "server",
        appId: input.parentSession?.appId ?? undefined,
        status: input.queued ? "pending" : "completed",
        output: input.queued
          ? "Subagent watcher queued a parent wake for required child lifecycle attention."
          : `Subagent watcher skipped parent wake: ${input.skippedReason ?? "unknown"}.`,
        data: {
          kind: "subagent_lifecycle_watcher_wake",
          checkedAt: input.checkedAt,
          wakeKey: group.key,
          parentSessionId: group.parentSessionId,
          parentGoalId: group.parentGoalId,
          runIds: uniqueStrings(group.candidates.map((candidate) => candidate.run.id)),
          reasons: group.reasons,
          statuses: uniqueStrings(group.candidates.map((candidate) => candidate.run.status)),
          staleRunIds: group.candidates.filter((candidate) => candidate.stale).map((candidate) => candidate.run.id),
          wakeQueued: input.queued,
          wakeQueuedParentSessionId: input.queued ? group.parentSessionId : null,
          wakeSkippedReason: input.skippedReason,
        },
      }),
    );
  }

  function enqueueTick(reason: SubagentLifecycleWatcherTickReason): Promise<SubagentLifecycleWatcherTickResult> {
    if (tickInFlight) return tickInFlight;
    let result: SubagentLifecycleWatcherTickResult | null = null;
    const receipt = options.queue.enqueue(
      {
        label: WATCHER_JOB_LABEL,
        metadata: { reason },
      },
      async () => {
        result = await runTick(reason);
      },
    );
    tickInFlight = receipt.done.then(() => {
      if (receipt.status === "failed") throw new Error(receipt.error ?? "Subagent lifecycle watcher failed");
      if (!result) throw new Error("Subagent lifecycle watcher did not return a result");
      return result;
    }).finally(() => {
      tickInFlight = null;
      if (enabled && !options.isClosing()) {
        queueScheduleRefresh("after_tick");
      }
    });
    return tickInFlight;
  }

  async function watcherHasAttentionableState(): Promise<{
    shouldTick: boolean;
    shouldSchedule: boolean;
    nextTickDelayMs?: number | null;
  }> {
    const preferences = await options.loadAppPreferences().catch((error) => {
      options.logger?.warn("subagent watcher failed to load preferences", {
        error: textFromUnknown(error),
      });
      return null;
    });
    if (!preferences?.subagents.enabled) return { shouldTick: false, shouldSchedule: false };
    const checkedAt = nowDate().toISOString();
    if (options.store.listSubagentRunScopes) {
      const recentUpdatedAtFrom = new Date(Date.parse(checkedAt) - staleAfterMs).toISOString();
      const activeScopes = await options.store.listSubagentRunScopes({
        status: WATCHER_ACTIVE_STATUSES,
        limit: 1,
      });
      if (activeScopes.length > 0) return { shouldTick: true, shouldSchedule: true };
      const [failedScopes, acceptedScopes] = await Promise.all([
        options.store.listSubagentRunScopes({
          status: "failed",
          updatedAtFrom: recentUpdatedAtFrom,
          limit: 1,
        }),
        options.store.listSubagentRunScopes({
          status: ["accepted", "completed"],
          updatedAtFrom: recentUpdatedAtFrom,
          limit: 1,
        }),
      ]);
      if (failedScopes.length > 0 || acceptedScopes.length > 0) return { shouldTick: true, shouldSchedule: false };
      return retainedWorkspaceAttentionState(checkedAt);
    }
    const activeRuns = await options.store.listActiveSubagentRuns({ limit: 1 });
    if (activeRuns.length > 0) return { shouldTick: true, shouldSchedule: true };
    if (!options.store.listSubagentRuns) return { shouldTick: false, shouldSchedule: false };
    const [failedRuns, acceptedRuns] = await Promise.all([
      options.store.listSubagentRuns({ status: "failed", limit: 50 }),
      options.store.listSubagentRuns({ status: ["accepted", "completed"], limit: 50 }),
    ]);
    const hasRecentTerminalAttention = [...failedRuns, ...acceptedRuns]
      .some((run) => run.required && terminalRunUpdatedWithin(run, checkedAt, staleAfterMs));
    if (hasRecentTerminalAttention) return { shouldTick: true, shouldSchedule: false };
    return retainedWorkspaceAttentionState(checkedAt);
  }

  async function retainedWorkspaceAttentionState(checkedAt: string): Promise<{
    shouldTick: boolean;
    shouldSchedule: boolean;
    nextTickDelayMs?: number | null;
  }> {
    if (!options.cleanupExpiredRetainedWorkspace || !options.store.listSubagentRuns) {
      return { shouldTick: false, shouldSchedule: false };
    }
    const runs = await options.store.listSubagentRuns({
      status: RETAINED_WORKSPACE_SCAN_STATUSES,
      limit: RETAINED_WORKSPACE_SCAN_LIMIT,
    }).catch(() => []);
    let nextExpiryMs: number | null = null;
    const checkedAtMs = Date.parse(checkedAt);
    for (const run of runs) {
      const retention = retainedWorkspaceRetentionForRun(run);
      if (!retention || !retention.cleanupAfterExpiry) continue;
      const expiresAtMs = Date.parse(retention.expiresAt);
      if (!Number.isFinite(expiresAtMs)) continue;
      if (Number.isFinite(checkedAtMs) && expiresAtMs <= checkedAtMs) return { shouldTick: true, shouldSchedule: false };
      const warningAtMs = retainedWorkspaceWarningAtMs(retention);
      if (
        warningAtMs !== null &&
        !retainedWorkspaceExpiryWarningRecorded(run, retention)
      ) {
        if (Number.isFinite(checkedAtMs) && warningAtMs <= checkedAtMs) return { shouldTick: true, shouldSchedule: false };
        nextExpiryMs = nextExpiryMs === null ? warningAtMs : Math.min(nextExpiryMs, warningAtMs);
      }
      nextExpiryMs = nextExpiryMs === null ? expiresAtMs : Math.min(nextExpiryMs, expiresAtMs);
    }
    if (nextExpiryMs === null || !Number.isFinite(checkedAtMs)) return { shouldTick: false, shouldSchedule: false };
    return {
      shouldTick: false,
      shouldSchedule: true,
      nextTickDelayMs: Math.max(1000, nextExpiryMs - checkedAtMs),
    };
  }

  async function scheduleNextTick(nextTickDelayMs?: number | null): Promise<void> {
    if (!enabled || options.isClosing()) return;
    const preferences = await options.loadAppPreferences().catch((error) => {
      options.logger?.warn("subagent watcher failed to load preferences", {
        error: textFromUnknown(error),
      });
      return null;
    });
    if (!preferences?.subagents.enabled) {
      clearScheduledTick();
      return;
    }
    const intervalSeconds = preferences?.subagents.heartbeatIntervalSeconds ?? 60;
    const intervalMs = nextTickDelayMs ?? Math.max(10, intervalSeconds) * 1000;
    const requestedTickAtMs = nowDate().getTime() + intervalMs;
    if (timer && nextTickAtMs !== null && nextTickAtMs <= requestedTickAtMs) return;
    clearScheduledTick();
    nextTickAtMs = requestedTickAtMs;
    timer = setTimeout(() => {
      timer = null;
      nextTickAtMs = null;
      void enqueueTick("interval").catch((error) => {
        if (options.isClosing()) return;
        options.logger?.warn("subagent lifecycle watcher tick failed", {
          error: textFromUnknown(error),
        });
      });
    }, intervalMs);
    timer.unref?.();
  }

  async function refreshSchedule(reason: SubagentLifecycleWatcherTickReason | "after_tick"): Promise<void> {
    if (!enabled || options.isClosing()) {
      clearScheduledTick();
      return;
    }
    const state = await watcherHasAttentionableState();
    if (!state.shouldSchedule) clearScheduledTick();
    if (state.shouldTick && reason !== "after_tick" && !tickInFlight) {
      void enqueueTick(reason === "startup" ? "startup" : "state_change").catch((error) => {
        if (options.isClosing()) return;
        options.logger?.warn("subagent lifecycle watcher tick failed", {
          error: textFromUnknown(error),
        });
      });
    }
    if (state.shouldSchedule) await scheduleNextTick(state.nextTickDelayMs);
  }

  function queueScheduleRefresh(reason: SubagentLifecycleWatcherTickReason | "after_tick"): void {
    const previous = scheduleRefreshInFlight ?? Promise.resolve();
    const next = previous
      .catch((error) => {
        if (options.isClosing()) return;
        options.logger?.warn("subagent lifecycle watcher schedule refresh failed", {
          error: textFromUnknown(error),
        });
      })
      .then(() => refreshSchedule(reason));
    scheduleRefreshInFlight = next;
    void next
      .catch((error) => {
        if (options.isClosing()) return;
        options.logger?.warn("subagent lifecycle watcher schedule refresh failed", {
          error: textFromUnknown(error),
        });
      })
      .finally(() => {
        if (scheduleRefreshInFlight === next) scheduleRefreshInFlight = null;
      });
  }

  return {
    start() {
      if (enabled || options.isClosing()) return;
      enabled = true;
      queueScheduleRefresh("startup");
    },
    stop() {
      enabled = false;
      clearScheduledTick();
    },
    notifySubagentRunStateChanged(run) {
      if (!enabled || options.isClosing()) return;
      queueScheduleRefresh(subagentRunNeedsImmediateWatcherTick(run) ? "state_change" : "after_tick");
    },
    tickNow(reason = "manual") {
      return enqueueTick(reason);
    },
    nextTickAt() {
      return scheduledTickAt();
    },
    status() {
      const runningTick = currentTickReceipt();
      return {
        nextTickAt: scheduledTickAt(),
        enabled,
        tickRunning: Boolean(runningTick),
        tickStartedAt: runningTick?.startedAt ?? null,
      };
    },
  };
}

function requiredLifecycleWakeReason(run: SubagentRun): SubagentLifecycleWakeReason | null {
  if (!run.required) return null;
  if (run.status === "blocked") return "required_blocked";
  if (run.status === "failed") return "required_failed";
  if (run.status === "failed_with_artifacts") return "required_failed_with_artifacts";
  if (run.status === "submitted_for_review") return "required_submitted_for_review";
  if (run.status === "needs_revision") return "required_needs_revision";
  if (run.status === "needs_user_input") return "required_needs_user_input";
  return null;
}

function subagentRunNeedsImmediateWatcherTick(run: SubagentRun | null | undefined): boolean {
  if (!run) return false;
  return Boolean(requiredLifecycleWakeReason(run) || (run.required && subagentRunAcceptedForWatcher(run)));
}

function staleAttentionKey(run: SubagentRun): string {
  return [
    run.id,
    run.status,
    run.updatedAt ?? run.completedAt ?? run.startedAt ?? run.createdAt,
  ].join(":");
}

function lifecycleWakeKey(
  parentSessionId: string,
  parentGoalId: string | null,
  candidates: LifecycleWakeCandidate[],
): string {
  const parts = candidates
    .map((candidate) =>
      [
        candidate.reason,
        candidate.run.id,
        candidate.run.status,
        candidate.run.updatedAt ?? candidate.run.completedAt ?? candidate.run.createdAt,
      ].join(":")
    )
    .sort();
  return `subagent-lifecycle:${parentSessionId}:${parentGoalId ?? "thread"}:${parts.join("|")}`;
}

function subagentLifecycleWakePrompt(group: LifecycleWakeGroup): string {
  const runPackets = group.candidates
    .map((candidate) => subagentLifecycleReviewPacket(candidate))
    .join("\n\n");
  return [
    "The subagent lifecycle watcher found required child work that needs main-agent attention.",
    "",
    `Parent session: ${group.parentSessionId}`,
    group.parentGoalId ? `Goal: ${group.parentGoalId}` : null,
    `Wake reasons: ${group.reasons.join(", ")}`,
    "",
    "Review packets:",
    runPackets,
    "",
    "Available decisions:",
    "- accept: call openpond_subagent_review with decision=\"accept\" only after the packet satisfies the original objective and acceptance criteria.",
    "- needs_revision: call openpond_subagent_review with decision=\"needs_revision\" and specific requiredCorrections when the child can fix the work.",
    "- needs_user_input: call openpond_subagent_review with decision=\"needs_user_input\" when user judgment, credentials, approval, or missing context is required.",
    "- independent_review: start a scoped review subagent before accepting when the packet has a high-risk diff, broad edit surface, failed or ambiguous validation, low confidence, or the user asked for an independent review.",
    "- retry_or_cancel: start another scoped child, cancel stale/failed work, or ask the user when the packet is not recoverable.",
    "",
    "Do not poll for routine lifecycle status; this wake was queued only for a required lifecycle attention event.",
  ].filter(Boolean).join("\n");
}

function subagentLifecycleReviewPacket(candidate: LifecycleWakeCandidate): string {
  const run = candidate.run;
  const metadata = recordFromUnknown(run.metadata);
  const failureHandoff = recordFromUnknown(metadata?.failureHandoff);
  const packetQualityEvidence = normalizedPacketQualityEvidence(run.review.packetQuality.evidence);
  const routingEvidence = normalizedReviewRoutingEvidence(run.review.reviewerRoutingEvidence);
  return [
    `Run ${run.id} (${run.roleId})`,
    `Status: ${run.status}`,
    `Reason: ${candidate.reason}${candidate.stale ? " (stale)" : ""}`,
    `Required: ${run.required ? "yes" : "no"}`,
    run.parentGoalId ? `Goal: ${run.parentGoalId}` : null,
    `Updated: ${run.updatedAt ?? run.progress.updatedAt ?? run.completedAt ?? run.startedAt ?? run.createdAt}`,
    `Objective: ${truncatePromptValue(run.objective, 800)}`,
    "Worker brief:",
    `  Plan: ${formatPromptList(run.workerBrief.plan)}`,
    `  Target files: ${formatPromptList(run.workerBrief.targetFiles)}`,
    `  Acceptance criteria: ${formatPromptList(run.workerBrief.acceptanceCriteria)}`,
    `  Validation commands: ${formatPromptList(run.workerBrief.validationCommands)}`,
    `  Stop conditions: ${formatPromptList(run.workerBrief.stopConditions)}`,
    "Final report:",
    `  Summary: ${truncatePromptValue(run.report?.summary || run.review.summary || "No summary recorded.", 1200)}`,
    `  Findings: ${formatPromptList(run.report?.findings ?? [])}`,
    `  Tests run: ${formatPromptList(run.report?.testsRun ?? [])}`,
    `  Blockers: ${formatPromptList(run.report?.blockers ?? [])}`,
    `  Confidence: ${run.report?.confidence ?? "unknown"}`,
    `  Follow-up needed: ${run.report?.followUpNeeded ? "yes" : "no"}`,
    `  Patch ref: ${formatPromptRef(run.report?.patchRef ?? null)}`,
    `  Diff ref: ${formatPromptRef(run.report?.diffRef ?? null)}`,
    `  Artifacts: ${formatPromptRefs(run.report?.artifacts ?? [])}`,
    "Packet quality:",
    `  Status: ${run.review.packetQuality.status}`,
    `  Issues: ${formatPromptList(run.review.packetQuality.issues)}`,
    `  Warnings: ${formatPromptList(run.review.packetQuality.warnings)}`,
    `  Evidence: ${formatPacketQualityEvidence(packetQualityEvidence)}`,
    "Reviewer routing:",
    `  Independent review recommended: ${run.review.independentReviewRecommended ? "yes" : "no"}`,
    `  Reasons: ${formatPromptList(run.review.reviewerRoutingReasons ?? [])}`,
    `  Evidence: ${formatReviewRoutingEvidence(routingEvidence)}`,
    "Runtime evidence:",
    `  Phase: ${run.progress.phase}`,
    `  Latest activity: ${truncatePromptValue(run.progress.latestMeaningfulActivity || "No runtime activity recorded.", 1200)}`,
    `  Current blocker: ${truncatePromptValue(run.progress.currentBlocker || "none", 1200)}`,
    `  Changed files: ${formatPromptList(run.progress.changedFiles)}`,
    `  Inspected files: ${formatPromptList(run.progress.inspectedFiles)}`,
    `  Inspected resources: ${formatPromptList(run.progress.inspectedResources)}`,
    `  Patch refs: ${formatPromptRefs(run.progress.patchRefs)}`,
    `  Validation attempts: ${formatValidationAttempts(run.progress.validationAttempts)}`,
    failureHandoff
      ? `Failure handoff: ${formatFailureHandoff(failureHandoff)}`
      : null,
  ].filter(Boolean).join("\n");
}

function formatPromptList(values: readonly string[] | undefined, limit = 8): string {
  const items = (values ?? []).filter(Boolean);
  if (items.length === 0) return "none";
  const shown = items.slice(0, limit).map((value) => truncatePromptValue(value, 260));
  const suffix = items.length > shown.length ? `; +${items.length - shown.length} more` : "";
  return `${shown.join("; ")}${suffix}`;
}

function formatPromptRefs(
  refs: readonly { kind: string; id: string; label: string }[] | undefined,
  limit = 6,
): string {
  const items = refs ?? [];
  if (items.length === 0) return "none";
  const shown = items.slice(0, limit).map(formatPromptRef).filter(Boolean);
  const suffix = items.length > shown.length ? `; +${items.length - shown.length} more` : "";
  return `${shown.join("; ")}${suffix}`;
}

function formatPromptRef(ref: { kind: string; id: string; label: string } | null | undefined): string {
  if (!ref) return "none";
  return `${ref.kind}:${truncatePromptValue(ref.label, 140)} (${truncatePromptValue(ref.id, 260)})`;
}

function formatValidationAttempts(
  attempts: readonly {
    command: string;
    status: "passed" | "failed" | "unknown";
    exitCode: number | null;
    outputSummary: string | null;
  }[],
  limit = 5,
): string {
  if (attempts.length === 0) return "none";
  const shown = attempts.slice(-limit).map((attempt) => [
    truncatePromptValue(attempt.command, 260),
    `status=${attempt.status}`,
    `exit=${attempt.exitCode ?? "unknown"}`,
    attempt.outputSummary ? `output=${truncatePromptValue(attempt.outputSummary, 500)}` : null,
  ].filter(Boolean).join("; "));
  const prefix = attempts.length > shown.length ? `+${attempts.length - shown.length} earlier; ` : "";
  return `${prefix}${shown.join(" | ")}`;
}

function formatFailureHandoff(handoff: Record<string, unknown>): string {
  const changedFiles = arrayOfStrings(handoff.changedFiles);
  const blockers = arrayOfStrings(handoff.blockers);
  const lastValidation = recordFromUnknown(handoff.lastValidationAttempt);
  return [
    `status=${stringValue(handoff.status) ?? "unknown"}`,
    `confidence=${stringValue(handoff.confidence) ?? "unknown"}`,
    `changedFiles=${formatPromptList(changedFiles)}`,
    `blockers=${formatPromptList(blockers)}`,
    lastValidation ? `lastValidation=${formatValidationAttempts([{
      command: stringValue(lastValidation.command) ?? "unknown",
      status: validationStatusValue(lastValidation.status),
      exitCode: typeof lastValidation.exitCode === "number" ? lastValidation.exitCode : null,
      outputSummary: stringValue(lastValidation.outputSummary),
    }])}` : null,
  ].filter(Boolean).join("; ");
}

function formatReviewRoutingEvidence(evidence: SubagentRun["review"]["reviewerRoutingEvidence"]): string {
  return [
    `packetQuality=${evidence.packetQualityStatus}`,
    evidence.confidence ? `confidence=${evidence.confidence}` : null,
    `changedFiles=${evidence.changedFileCount}`,
    `highRiskFiles=${evidence.highRiskFileCount}`,
    `validationAttempts=${evidence.validationAttemptCount}`,
    `failedValidation=${evidence.failedValidationCount}`,
    evidence.missingRequestedValidation ? "missingRequestedValidation=yes" : null,
    evidence.providerFailureAfterChanges ? "providerFailureAfterChanges=yes" : null,
    evidence.userRequestedIndependentReview ? "userRequestedIndependentReview=yes" : null,
  ].filter(Boolean).join("; ");
}

function formatPacketQualityEvidence(evidence: SubagentRun["review"]["packetQuality"]["evidence"]): string {
  return [
    `summary=${evidence.finalSummaryPresent ? "present" : "missing"}`,
    `summaryLength=${evidence.finalSummaryLength}`,
    `requestedValidation=${evidence.requestedValidationCommandCount}`,
    `validationAttempts=${evidence.validationAttemptCount}`,
    `failedValidation=${evidence.failedValidationCount}`,
    `testsRun=${evidence.testsRunCount}`,
    `changedFiles=${evidence.changedFileCount}`,
    evidence.patchRefPresent ? "patchRef=yes" : null,
    evidence.diffRefPresent ? "diffRef=yes" : null,
    `artifacts=${evidence.artifactCount}`,
    `findings=${evidence.findingCount}`,
    `blockers=${evidence.blockerCount}`,
    evidence.unvalidatedWorkspaceChanges ? "unvalidatedWorkspaceChanges=yes" : null,
  ].filter(Boolean).join("; ");
}

function normalizedPacketQualityEvidence(
  evidence: SubagentRun["review"]["packetQuality"]["evidence"] | undefined,
): SubagentRun["review"]["packetQuality"]["evidence"] {
  return {
    finalSummaryPresent: evidence?.finalSummaryPresent ?? false,
    finalSummaryLength: evidence?.finalSummaryLength ?? 0,
    requestedValidationCommandCount: evidence?.requestedValidationCommandCount ?? 0,
    validationAttemptCount: evidence?.validationAttemptCount ?? 0,
    failedValidationCount: evidence?.failedValidationCount ?? 0,
    testsRunCount: evidence?.testsRunCount ?? 0,
    changedFileCount: evidence?.changedFileCount ?? 0,
    patchRefPresent: evidence?.patchRefPresent ?? false,
    diffRefPresent: evidence?.diffRefPresent ?? false,
    artifactCount: evidence?.artifactCount ?? 0,
    findingCount: evidence?.findingCount ?? 0,
    blockerCount: evidence?.blockerCount ?? 0,
    unvalidatedWorkspaceChanges: evidence?.unvalidatedWorkspaceChanges ?? false,
  };
}

function normalizedReviewRoutingEvidence(
  evidence: SubagentRun["review"]["reviewerRoutingEvidence"] | undefined,
): SubagentRun["review"]["reviewerRoutingEvidence"] {
  return {
    packetQualityStatus: evidence?.packetQualityStatus ?? "reviewable",
    confidence: evidence?.confidence ?? null,
    changedFileCount: evidence?.changedFileCount ?? 0,
    highRiskFileCount: evidence?.highRiskFileCount ?? 0,
    validationAttemptCount: evidence?.validationAttemptCount ?? 0,
    failedValidationCount: evidence?.failedValidationCount ?? 0,
    missingRequestedValidation: evidence?.missingRequestedValidation ?? false,
    providerFailureAfterChanges: evidence?.providerFailureAfterChanges ?? false,
    userRequestedIndependentReview: evidence?.userRequestedIndependentReview ?? false,
  };
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function validationStatusValue(value: unknown): "passed" | "failed" | "unknown" {
  return value === "passed" || value === "failed" || value === "unknown" ? value : "unknown";
}

function retainedWorkspaceRetentionForRun(run: SubagentRun): RetainedWorkspaceRetention | null {
  const metadata = recordFromUnknown(run.metadata);
  const lifecycleCleanup = recordFromUnknown(metadata?.lifecycleCleanup);
  const workspaceCleanup = recordFromUnknown(lifecycleCleanup?.workspaceCleanup);
  const workspaceCleanupStatus = stringValue(workspaceCleanup?.status);
  if (workspaceCleanupStatus === "removed" || workspaceCleanupStatus === "deleted" || workspaceCleanupStatus === "skipped") {
    return null;
  }
  const cleanupRetention = retainedWorkspaceRetentionFromRecord(workspaceCleanup, "lifecycleCleanup");
  if (cleanupRetention) return cleanupRetention;

  const workspaceHandoff = recordFromUnknown(metadata?.workspaceHandoff);
  const applyResult = recordFromUnknown(workspaceHandoff?.applyResult);
  const patchRetention = recordFromUnknown(applyResult?.workspaceRetention);
  return retainedWorkspaceRetentionFromRecord(patchRetention, "patchApplyResult");
}

function retainedWorkspaceRetentionFromRecord(
  record: Record<string, unknown> | null,
  source: RetainedWorkspaceRetention["source"],
): RetainedWorkspaceRetention | null {
  if (!record || stringValue(record.status) !== "retained") return null;
  const policy = recordFromUnknown(record.retentionPolicy);
  const expiresAt = stringValue(policy?.expiresAt);
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) return null;
  return {
    source,
    reason: stringValue(record.reason),
    retainedAt: stringValue(record.retainedAt),
    expiresAt,
    retentionDays: typeof policy?.retentionDays === "number" && Number.isFinite(policy.retentionDays)
      ? Math.max(0, Math.floor(policy.retentionDays))
      : null,
    cleanupAfterExpiry: policy?.cleanupAfterExpiry === true,
    trigger: stringValue(policy?.trigger),
  };
}

function retentionExpired(retention: RetainedWorkspaceRetention, checkedAt: string): boolean {
  if (!retention.cleanupAfterExpiry) return false;
  const checkedAtMs = Date.parse(checkedAt);
  const expiresAtMs = Date.parse(retention.expiresAt);
  return Number.isFinite(checkedAtMs) && Number.isFinite(expiresAtMs) && expiresAtMs <= checkedAtMs;
}

function retentionWarningDue(retention: RetainedWorkspaceRetention, checkedAt: string): boolean {
  if (!retention.cleanupAfterExpiry) return false;
  const checkedAtMs = Date.parse(checkedAt);
  const expiresAtMs = Date.parse(retention.expiresAt);
  const warningAtMs = retainedWorkspaceWarningAtMs(retention);
  return Number.isFinite(checkedAtMs) &&
    Number.isFinite(expiresAtMs) &&
    warningAtMs !== null &&
    checkedAtMs >= warningAtMs &&
    checkedAtMs < expiresAtMs;
}

function retainedWorkspaceWarningAtMs(retention: RetainedWorkspaceRetention): number | null {
  const expiresAtMs = Date.parse(retention.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return null;
  return expiresAtMs - RETAINED_WORKSPACE_EXPIRY_WARNING_BEFORE_MS;
}

function retainedWorkspaceExpiryWarningKey(run: SubagentRun, retention: RetainedWorkspaceRetention): string {
  return [run.id, retention.source, retention.expiresAt].join(":");
}

function retainedWorkspaceExpiryWarningRecorded(run: SubagentRun, retention: RetainedWorkspaceRetention): boolean {
  const metadata = recordFromUnknown(run.metadata);
  const warning = recordFromUnknown(metadata?.retainedWorkspaceExpiryWarning);
  return stringValue(warning?.status) === "warned" &&
    stringValue(warning?.expiresAt) === retention.expiresAt &&
    stringValue(warning?.source) === retention.source;
}

function truncatePromptValue(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function uniqueRuns(runs: SubagentRun[]): SubagentRun[] {
  const byId = new Map<string, SubagentRun>();
  for (const run of runs) {
    if (!byId.has(run.id)) byId.set(run.id, run);
  }
  return [...byId.values()];
}

function uniqueSubagentWatcherScopes(scopes: SubagentLifecycleWatcherScope[]): SubagentLifecycleWatcherScope[] {
  const byKey = new Map<string, SubagentLifecycleWatcherScope>();
  for (const scope of scopes) {
    if (!scope.parentSessionId) continue;
    const key = subagentWatcherScopeKey(scope);
    if (!byKey.has(key)) byKey.set(key, {
      parentSessionId: scope.parentSessionId,
      parentGoalId: scope.parentGoalId ?? null,
    });
  }
  return [...byKey.values()];
}

function subagentWatcherScopeFromRun(run: SubagentRun): SubagentLifecycleWatcherScope {
  return {
    parentSessionId: run.parentSessionId,
    parentGoalId: run.parentGoalId ?? null,
  };
}

function subagentWatcherScopeKey(scope: SubagentLifecycleWatcherScope): string {
  return `${scope.parentSessionId}:${scope.parentGoalId ?? "thread"}`;
}

function runsInScope(runs: SubagentRun[], scope: SubagentLifecycleWatcherScope): SubagentRun[] {
  return runs.filter((run) =>
    run.parentSessionId === scope.parentSessionId &&
    (run.parentGoalId ?? null) === (scope.parentGoalId ?? null)
  );
}

function uniqueWakeReasons(reasons: SubagentLifecycleWakeReason[]): SubagentLifecycleWakeReason[] {
  return [...new Set(reasons)];
}

function singleParentSessionId(scopedRuns: readonly ScopedSubagentRuns[]): string | null {
  const parentSessionIds = uniqueStrings(scopedRuns.map((item) => item.scope.parentSessionId));
  return parentSessionIds.length === 1 ? parentSessionIds[0]! : null;
}

function singleParentSessionIdFromRuns(runs: readonly SubagentRun[]): string | null {
  const parentSessionIds = uniqueStrings(runs.map((run) => run.parentSessionId));
  return parentSessionIds.length === 1 ? parentSessionIds[0]! : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function terminalRunUpdatedWithin(run: SubagentRun, checkedAt: string, maxAgeMs: number): boolean {
  const updatedAt = Date.parse(run.updatedAt ?? run.completedAt ?? run.createdAt);
  const checkedAtMs = Date.parse(checkedAt);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(checkedAtMs)) return false;
  return checkedAtMs - updatedAt <= Math.max(0, maxAgeMs);
}

function subagentRunAgeMs(run: SubagentRun, checkedAt: string): number {
  const updatedAt = Date.parse(run.updatedAt ?? run.completedAt ?? run.startedAt ?? run.createdAt);
  const checkedAtMs = Date.parse(checkedAt);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(checkedAtMs)) return 0;
  return Math.max(0, checkedAtMs - updatedAt);
}

function subagentRunAcceptedForWatcher(run: SubagentRun): boolean {
  if (run.status === "superseded") return false;
  return run.status === "accepted" || run.status === "completed" || run.review.status === "accepted";
}

function uniqueNonEmptyStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
