import {
  SubagentProgressSchema,
  SubagentRunSchema,
  type RuntimeEvent,
  type Session,
  type SubagentLifecycleActionResponse,
  type SubagentRun,
  type Turn,
} from "@openpond/contracts";
import type { ModelToolExecutionContext } from "../../openpond/model-tool-registry.js";
import type {
  OpenPondGoalControlAction,
  OpenPondGoalControlGoal,
} from "../../openpond/goal-control.js";
import {
  subagentRunAccepted,
  subagentRunDismissed,
  subagentRunResolvedForGoal,
} from "../subagents/policies-and-prompts.js";
import { now, textFromUnknown } from "../../utils.js";
import {
  recordFromUnknown,
  stringFromRecord,
  uniqueNonEmptyStrings,
} from "../turns/value-utils.js";

type AppendSubagentReceipt = (input: {
  parentSession: Session;
  parentTurnId?: string | null;
  run: SubagentRun;
  childSession?: Session | null;
  eventName: Extract<RuntimeEvent["name"], `subagent.${string}`>;
  status: RuntimeEvent["status"];
  output: string;
}) => Promise<void>;

export function createGoalSubagentLifecycle(deps: {
  subagentToolsAvailable(): boolean;
  requireSubagentDeps(): {
    getRun(runId: string): Promise<SubagentRun | null>;
    upsertRun(run: SubagentRun): Promise<unknown>;
    listRuns(input: {
      parentSessionId?: string;
      parentGoalId?: string;
      status?: SubagentRun["status"][];
      limit?: number;
    }): Promise<SubagentRun[]>;
  };
  interruptSessionTurn(sessionId: string, reason?: string): Promise<Turn>;
  cleanupSubagentRun(input: {
    run: SubagentRun;
    parentSession: Session;
    parentTurnId?: string | null;
    reason: string;
    policy: "auto_after_acceptance" | "cancel_requested" | "manual_cleanup" | "retention_expired";
  }): Promise<{ run: SubagentRun; workspaceCleanup: Record<string, unknown> }>;
  appendSubagentReceipt: AppendSubagentReceipt;
  getSession(sessionId: string): Promise<Session>;
  updateSession(sessionId: string, patch: Record<string, unknown>): Promise<Session>;
}) {
  const subagentToolsAvailable = deps.subagentToolsAvailable;
  const requireSubagentDeps = deps.requireSubagentDeps;
  const interruptSessionTurn = deps.interruptSessionTurn;
  const cleanupSubagentRun = deps.cleanupSubagentRun;
  const appendSubagentReceipt = deps.appendSubagentReceipt;
  const getSession = deps.getSession;
  const updateSession = deps.updateSession;
  async function assertGoalSubagentsResolvedForCompletion(input: {
    context: ModelToolExecutionContext;
    goalId: string;
    action: string;
  }): Promise<void> {
    if (input.action !== "complete" || !subagentToolsAvailable()) return;
    const deps = requireSubagentDeps();
    const runs = await deps.listRuns({
      parentSessionId: input.context.session.id,
      parentGoalId: input.goalId,
      limit: 1000,
    });
    const unresolved = runs.filter((run) => run.required && !subagentRunResolvedForGoal(run));
    if (unresolved.length === 0) return;
    const details = unresolved.slice(0, 8).map((run) => `${run.roleId} ${run.status} (${run.id})`).join(", ");
    const hidden = unresolved.length > 8 ? `, +${unresolved.length - 8} more` : "";
    throw new Error(
      `Cannot complete goal ${input.goalId} while required subagents are unresolved: ${details}${hidden}. Join, resume, or explicitly resolve those child runs first.`,
    );
  }

  async function markGoalSubagentsNeedsResume(input: {
    context: ModelToolExecutionContext;
    goalId: string;
    action: string;
  }): Promise<number> {
    if (input.action !== "resume" || !subagentToolsAvailable()) return 0;
    const deps = requireSubagentDeps();
    const runs = await deps.listRuns({
      parentSessionId: input.context.session.id,
      parentGoalId: input.goalId,
      status: ["queued", "running"],
      limit: 1000,
    });
    let updatedCount = 0;
    for (const run of runs) {
      const blocker = "Goal resumed; this child conversation needs resume before its required subagent work can finish.";
      const updated = SubagentRunSchema.parse({
        ...run,
        status: "needs_resume",
        report: {
          ...(run.report ?? {}),
          summary: run.report?.summary || "Subagent needs resume after parent goal resumed.",
          blockers: uniqueNonEmptyStrings([...(run.report?.blockers ?? []), blocker]),
          followUpNeeded: true,
        },
        metadata: {
          ...run.metadata,
          needsResumeAt: now(),
          needsResumeReason: "parent_goal_resumed",
        },
      });
      await deps.upsertRun(updated);
      await appendSubagentReceipt({
        parentSession: input.context.session,
        parentTurnId: input.context.turnId,
        run: updated,
        eventName: "subagent.blocked",
        status: "pending",
        output: `${updated.roleId} subagent needs resume after parent goal resumed.`,
      });
      updatedCount += 1;
    }
    return updatedCount;
  }

  async function markGoalSubagentsSuperseded(input: {
    context: ModelToolExecutionContext;
    action: OpenPondGoalControlAction;
    previousGoal: Record<string, unknown> | null;
    supersededByGoal: OpenPondGoalControlGoal;
  }): Promise<number> {
    if (input.action !== "restart" || !subagentToolsAvailable()) return 0;
    const previousGoal = recordFromUnknown(input.previousGoal);
    const previousGoalId = stringFromRecord(previousGoal ?? {}, "id");
    if (!previousGoalId) return 0;
    const deps = requireSubagentDeps();
    const runs = await deps.listRuns({
      parentSessionId: input.context.session.id,
      parentGoalId: previousGoalId,
      limit: 1000,
    });
    const reason = `Parent goal ${previousGoalId} restarted; this child run was superseded.`;
    let supersededCount = 0;
    for (const run of runs) {
      if (run.status === "superseded") continue;
      const supersededAt = now();
      let interruptResult: Record<string, unknown> | null = null;
      if (run.childSessionId && subagentRunMayStillBeWorking(run)) {
        try {
          const interrupted = await interruptSessionTurn(run.childSessionId);
          interruptResult = {
            status: interrupted.status,
            turnId: interrupted.id,
          };
        } catch (error) {
          interruptResult = {
            status: "not_active",
            error: textFromUnknown(error) || "No active child turn to interrupt.",
          };
        }
      }
      const updated = SubagentRunSchema.parse({
        ...run,
        status: "superseded",
        completedAt: supersededAt,
        updatedAt: supersededAt,
        error: null,
        progress: SubagentProgressSchema.parse({
          ...run.progress,
          phase: "report",
          latestMeaningfulActivity: "Parent goal restarted; child run superseded.",
          currentBlocker: null,
          updatedAt: supersededAt,
        }),
        report: {
          ...(run.report ?? {}),
          summary: run.report?.summary || "Subagent superseded by parent goal restart.",
          followUpNeeded: false,
        },
        metadata: {
          ...(run.metadata ?? {}),
          superseded: {
            status: "superseded",
            reason,
            supersededAt,
            previousStatus: run.status,
            previousGoalId,
            supersededByGoalId: input.supersededByGoal.id,
            requestedBySessionId: input.context.session.id,
            requestedByTurnId: input.context.turnId,
            interruptResult,
          },
        },
      });
      await deps.upsertRun(updated);
      await appendSubagentReceipt({
        parentSession: input.context.session,
        parentTurnId: input.context.turnId,
        run: updated,
        eventName: "subagent.superseded",
        status: "completed",
        output: `${updated.roleId} subagent superseded by restarted parent goal.`,
      });
      supersededCount += 1;
    }
    return supersededCount;
  }

  async function applyGoalLifecycleToSubagents(input: {
    context: ModelToolExecutionContext;
    goalId: string;
    action: OpenPondGoalControlAction;
  }): Promise<{ cancelledCount: number; cleanedCount: number; archivedCount: number }> {
    if (!subagentToolsAvailable() || (input.action !== "stop" && input.action !== "complete")) {
      return { cancelledCount: 0, cleanedCount: 0, archivedCount: 0 };
    }
    const deps = requireSubagentDeps();
    const runs = await deps.listRuns({
      parentSessionId: input.context.session.id,
      parentGoalId: input.goalId,
      limit: 1000,
    });
    let cancelledCount = 0;
    let cleanedCount = 0;
    let archivedCount = 0;
    for (const run of runs) {
      if (input.action === "stop") {
        if (subagentRunAccepted(run) || subagentRunDismissed(run)) {
          const cleanup = await cleanupSubagentRun({
            run,
            parentSession: input.context.session,
            parentTurnId: input.context.turnId,
            reason: subagentRunDismissed(run) ? "goal_stopped_dismissed" : "goal_stopped",
            policy: "auto_after_acceptance",
          });
          const archived = await archiveSubagentChildSession({
            parentSession: input.context.session,
            parentTurnId: input.context.turnId,
            run: cleanup.run,
            reason: "goal_stopped",
            policy: "goal_stopped",
          });
          cleanedCount += 1;
          if (archived.archived) archivedCount += 1;
          continue;
        }
        if (subagentRunTerminalForGoalLifecycle(run)) continue;
        const cancelled = await cancelSubagentRunForGoalLifecycle({
          context: input.context,
          run,
          reason: `Parent goal ${input.goalId} stopped.`,
        });
        const archived = await archiveSubagentChildSession({
          parentSession: input.context.session,
          parentTurnId: input.context.turnId,
          run: cancelled,
          reason: "goal_stopped",
          policy: "goal_stopped",
        });
        cancelledCount += 1;
        cleanedCount += 1;
        if (archived.archived) archivedCount += 1;
        continue;
      }
      if (subagentRunAccepted(run) || subagentRunDismissed(run)) {
        const cleanup = await cleanupSubagentRun({
          run,
          parentSession: input.context.session,
          parentTurnId: input.context.turnId,
          reason: subagentRunDismissed(run) ? "goal_completed_dismissed" : "goal_completed",
          policy: "auto_after_acceptance",
        });
        const archived = await archiveSubagentChildSession({
          parentSession: input.context.session,
          parentTurnId: input.context.turnId,
          run: cleanup.run,
          reason: "goal_completed",
          policy: "goal_completed",
        });
        cleanedCount += 1;
        if (archived.archived) archivedCount += 1;
        continue;
      }
      if (!run.required && !subagentRunTerminalForGoalLifecycle(run)) {
        const cancelled = await cancelSubagentRunForGoalLifecycle({
          context: input.context,
          run,
          reason: `Parent goal ${input.goalId} completed before optional subagent finished.`,
        });
        const archived = await archiveSubagentChildSession({
          parentSession: input.context.session,
          parentTurnId: input.context.turnId,
          run: cancelled,
          reason: "goal_completed_optional_cancel",
          policy: "goal_completed",
        });
        cancelledCount += 1;
        cleanedCount += 1;
        if (archived.archived) archivedCount += 1;
      }
    }
    return { cancelledCount, cleanedCount, archivedCount };
  }

  async function cancelSubagentRunForGoalLifecycle(input: {
    context: ModelToolExecutionContext;
    run: SubagentRun;
    reason: string;
  }): Promise<SubagentRun> {
    const deps = requireSubagentDeps();
    const cancelledAt = now();
    let interruptResult: Record<string, unknown> | null = null;
    if (input.run.childSessionId) {
      try {
        const interrupted = await interruptSessionTurn(input.run.childSessionId);
        interruptResult = {
          status: interrupted.status,
          turnId: interrupted.id,
        };
      } catch (error) {
        interruptResult = {
          status: "not_active",
          error: textFromUnknown(error) || "No active child turn to interrupt.",
        };
      }
    }
    let nextRun = SubagentRunSchema.parse({
      ...input.run,
      status: "cancelled",
      completedAt: cancelledAt,
      error: input.reason,
      report: {
        ...(input.run.report ?? {}),
        summary: input.run.report?.summary || "Subagent cancelled by parent goal lifecycle.",
        blockers: uniqueNonEmptyStrings([...(input.run.report?.blockers ?? []), input.reason]),
        followUpNeeded: false,
      },
      metadata: {
        ...(input.run.metadata ?? {}),
        goalLifecycle: {
          action: "cancelled_by_parent_goal",
          reason: input.reason,
          cancelledAt,
          interruptResult,
        },
      },
    });
    await deps.upsertRun(nextRun);
    const cleanup = await cleanupSubagentRun({
      run: nextRun,
      parentSession: input.context.session,
      parentTurnId: input.context.turnId,
      reason: "goal_lifecycle_cancel",
      policy: "cancel_requested",
    });
    nextRun = SubagentRunSchema.parse({
      ...cleanup.run,
      metadata: {
        ...(cleanup.run.metadata ?? {}),
        goalLifecycle: {
          ...(recordFromUnknown(cleanup.run.metadata?.goalLifecycle) ?? {}),
          workspaceCleanup: cleanup.workspaceCleanup,
        },
      },
    });
    await deps.upsertRun(nextRun);
    await appendSubagentReceipt({
      parentSession: input.context.session,
      parentTurnId: input.context.turnId,
      run: nextRun,
      eventName: "subagent.cancelled",
      status: "completed",
      output: `${nextRun.roleId} subagent cancelled by parent goal lifecycle.`,
    });
    return nextRun;
  }

  async function archiveSubagentChildSession(input: {
    parentSession: Session;
    parentTurnId?: string | null;
    run: SubagentRun;
    reason: string;
    policy: "goal_completed" | "goal_stopped" | "manual_archive";
  }): Promise<{ run: SubagentRun; sessionArchive: Record<string, unknown>; archived: boolean }> {
    if (!input.run.childSessionId) {
      return {
        run: input.run,
        sessionArchive: {
          status: "skipped",
          reason: "childSessionId missing",
          evidenceRetention: input.run.evidenceRetention,
        },
        archived: false,
      };
    }

    const deps = requireSubagentDeps();
    const archivedAt = now();
    let sessionArchive: Record<string, unknown>;
    try {
      const childSession = await getSession(input.run.childSessionId);
      if (childSession.archived) {
        sessionArchive = {
          status: "already_archived",
          sessionId: childSession.id,
          archivedAt,
          reason: input.reason,
          policy: input.policy,
          evidenceRetention: input.run.evidenceRetention,
        };
      } else {
        const updatedSession = await updateSession(childSession.id, {
          archived: true,
          hiddenFromDefaultSidebar: true,
          status: childSession.status === "active" ? "idle" : childSession.status,
          metadata: {
            ...(childSession.metadata ?? {}),
            subagentArchive: {
              status: "archived",
              archivedAt,
              reason: input.reason,
              policy: input.policy,
              parentSessionId: input.run.parentSessionId,
              parentGoalId: input.run.parentGoalId ?? null,
              runId: input.run.id,
              roleId: input.run.roleId,
              evidenceRetention: input.run.evidenceRetention,
            },
          },
        });
        sessionArchive = {
          status: "archived",
          sessionId: updatedSession.id,
          archivedAt,
          reason: input.reason,
          policy: input.policy,
          hiddenFromDefaultSidebar: updatedSession.hiddenFromDefaultSidebar === true,
          previousStatus: childSession.status,
          evidenceRetention: input.run.evidenceRetention,
        };
      }
    } catch (error) {
      sessionArchive = {
        status: "failed",
        sessionId: input.run.childSessionId,
        failedAt: archivedAt,
        reason: input.reason,
        policy: input.policy,
        error: textFromUnknown(error) || "Failed to archive child session.",
        evidenceRetention: input.run.evidenceRetention,
      };
    }

    const nextRun = SubagentRunSchema.parse({
      ...input.run,
      metadata: {
        ...(input.run.metadata ?? {}),
        childSessionArchive: {
          ...sessionArchive,
          evidenceRetention: input.run.evidenceRetention,
        },
      },
    });
    await deps.upsertRun(nextRun);
    const status = stringFromRecord(sessionArchive, "status");
    await appendSubagentReceipt({
      parentSession: input.parentSession,
      parentTurnId: input.parentTurnId ?? null,
      run: nextRun,
      eventName: "subagent.archived",
      status: status === "failed" ? "failed" : "completed",
      output: subagentArchiveOutput(nextRun, sessionArchive),
    });
    return {
      run: nextRun,
      sessionArchive,
      archived: status === "archived" || status === "already_archived",
    };
  }

  function subagentLifecycleActionNextStep(
    action: SubagentLifecycleActionResponse["action"],
    workspaceCleanup: Record<string, unknown> | null,
    sessionArchive: Record<string, unknown> | null,
  ): string {
    const cleanupStatus = workspaceCleanup ? stringFromRecord(workspaceCleanup, "status") ?? "unknown" : null;
    const archiveStatus = sessionArchive ? stringFromRecord(sessionArchive, "status") ?? "unknown" : null;
    if (action === "cleanup") {
      if (cleanupStatus === "removed" || cleanupStatus === "deleted") return "Subagent workspace cleanup completed.";
      if (cleanupStatus === "retained") return "Subagent workspace retained for inspection.";
      if (cleanupStatus === "failed") return "Subagent workspace cleanup failed.";
      return "Subagent workspace cleanup recorded.";
    }
    if (action === "archive") {
      if (archiveStatus === "archived" || archiveStatus === "already_archived") return "Subagent child session archived.";
      if (archiveStatus === "failed") return "Subagent child session archive failed.";
      return "Subagent child session archive recorded.";
    }
    return `Subagent lifecycle action completed. Cleanup: ${cleanupStatus ?? "not_requested"}. Archive: ${archiveStatus ?? "not_requested"}.`;
  }

  function subagentArchiveOutput(run: SubagentRun, sessionArchive: Record<string, unknown>): string {
    const status = stringFromRecord(sessionArchive, "status") ?? "unknown";
    if (status === "archived") return `${run.roleId} child session archived.`;
    if (status === "already_archived") return `${run.roleId} child session was already archived.`;
    if (status === "failed") return `${run.roleId} child session archive failed.`;
    return `${run.roleId} child session archive ${status}.`;
  }

  function subagentRunTerminalForGoalLifecycle(run: SubagentRun): boolean {
    return run.status === "cancelled" ||
      run.status === "failed" ||
      run.status === "failed_with_artifacts" ||
      run.status === "superseded";
  }

  function subagentRunMayStillBeWorking(run: SubagentRun): boolean {
    return run.status === "queued" ||
      run.status === "running" ||
      run.status === "blocked" ||
      run.status === "submitted_for_review" ||
      run.status === "needs_revision" ||
      run.status === "needs_user_input" ||
      run.status === "needs_resume";
  }


  return {
    applyGoalLifecycleToSubagents,
    archiveSubagentChildSession,
    assertGoalSubagentsResolvedForCompletion,
    markGoalSubagentsNeedsResume,
    markGoalSubagentsSuperseded,
    subagentLifecycleActionNextStep,
  };
}
