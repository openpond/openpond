import {
  SubagentProgressSchema,
  SubagentRunSchema,
  type AppPreferences,
  type RuntimeEvent,
  type Session,
  type SubagentLifecycleActionResponse,
  type SubagentRoleSettings,
  type SubagentRun,
  type Turn,
} from "@openpond/contracts";
import type { ModelToolExecutionContext } from "../../openpond/model-tool-registry.js";
import type { OpenPondGoalControlAction } from "../../openpond/goal-control.js";
import { now, textFromUnknown } from "../../utils.js";
import type { BackgroundWorkerQueue } from "../background-worker-queue.js";
import type { SubagentTurnPermissions } from "../subagents/continuation-runtime.js";

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
  loadAppPreferences(): Promise<AppPreferences>;
  subagentChildTurnPermissions(
    parent: SubagentTurnPermissions,
    role: SubagentRoleSettings,
  ): SubagentTurnPermissions;
  runSubagentChildTurn(input: {
    run: SubagentRun;
    role: SubagentRoleSettings;
    childSession: Session;
    parentSession: Session;
    parentTurnId: string;
    contextPack: string | null;
    childTurnPermissions: SubagentTurnPermissions;
    initialPrompt?: string | null;
  }): Promise<void>;
  enqueueSubagentResume: BackgroundWorkerQueue["enqueue"];
}) {
  async function runsForGoal(parentSessionId: string, goalId: string): Promise<SubagentRun[]> {
    if (!deps.subagentToolsAvailable()) return [];
    return deps.requireSubagentDeps().listRuns({ parentSessionId, parentGoalId: goalId, limit: 1000 });
  }

  async function markGoalSubagentsNeedsResume(input: {
    context: ModelToolExecutionContext;
    goalId: string;
    action: OpenPondGoalControlAction;
  }): Promise<number> {
    if (input.action !== "pause" && input.action !== "resume") return 0;
    if (!deps.subagentToolsAvailable()) return 0;
    const runtime = deps.requireSubagentDeps();
    if (input.action === "pause") {
      const runs = (await runsForGoal(input.context.session.id, input.goalId))
        .filter((run) => run.status === "queued" || run.status === "running");
      for (const run of runs) {
        if (run.status === "running" && run.childSessionId) {
          await deps.interruptSessionTurn(run.childSessionId, "Parent goal paused.").catch(() => undefined);
        }
        const updated = SubagentRunSchema.parse({
          ...run,
          status: "needs_resume",
          completedAt: null,
          error: null,
          progress: SubagentProgressSchema.parse({
            ...run.progress,
            latestMeaningfulActivity: "Paused with the parent goal.",
            updatedAt: now(),
          }),
        });
        await runtime.upsertRun(updated);
        await deps.appendSubagentReceipt({
          parentSession: input.context.session,
          parentTurnId: input.context.turnId,
          run: updated,
          eventName: "subagent.progress",
          status: "pending",
          output: `${run.roleId} child paused with the parent goal.`,
        });
      }
      return runs.length;
    }

    const preferences = await deps.loadAppPreferences();
    const runs = (await runsForGoal(input.context.session.id, input.goalId))
      .filter((run) => run.status === "needs_resume" && run.childSessionId);
    let queuedCount = 0;
    for (const run of runs) {
      const role = preferences.subagents.roles.find((candidate) => candidate.id === run.roleId);
      if (!role?.enabled || !run.childSessionId) continue;
      const childSession = await deps.getSession(run.childSessionId).catch(() => null);
      if (!childSession) continue;
      const queued = SubagentRunSchema.parse({
        ...run,
        status: "queued",
        completedAt: null,
        error: null,
        progress: SubagentProgressSchema.parse({
          ...run.progress,
          latestMeaningfulActivity: "Queued to resume with the parent goal.",
          currentBlocker: null,
          updatedAt: now(),
        }),
      });
      await runtime.upsertRun(queued);
      deps.enqueueSubagentResume(
        {
          label: `Resume ${role.id}: ${run.objective.slice(0, 80)}`,
          metadata: { runId: run.id, childSessionId: childSession.id, parentSessionId: input.context.session.id },
        },
        () => deps.runSubagentChildTurn({
          run: queued,
          role,
          childSession,
          parentSession: input.context.session,
          parentTurnId: input.context.turnId,
          contextPack: typeof run.metadata?.context === "string" ? run.metadata.context : null,
          childTurnPermissions: deps.subagentChildTurnPermissions(input.context.turnPermissions, role),
          initialPrompt: "Continue the assignment from where you stopped.",
        }),
      );
      queuedCount += 1;
    }
    return queuedCount;
  }

  async function applyGoalLifecycleToSubagents(input: {
    context: ModelToolExecutionContext;
    goalId: string;
    action: OpenPondGoalControlAction;
  }): Promise<Record<string, number>> {
    const result = { cancelledCount: 0, cleanedCount: 0, archivedCount: 0 };
    if (!["complete", "stop", "restart"].includes(input.action)) return result;
    if (!deps.subagentToolsAvailable()) return result;
    const runtime = deps.requireSubagentDeps();
    const active = (await runsForGoal(input.context.session.id, input.goalId))
      .filter((run) => run.status === "queued" || run.status === "running" || run.status === "needs_resume");
    for (const run of active) {
      if (run.childSessionId) {
        await deps.interruptSessionTurn(run.childSessionId, `Parent goal ${input.action}.`).catch(() => undefined);
      }
      const reason = `Child cancelled because parent goal was ${input.action}.`;
      const cancelled = SubagentRunSchema.parse({
        ...run,
        status: "cancelled",
        completedAt: now(),
        error: reason,
        report: {
          ...(run.report ?? {}),
          summary: run.report?.summary || reason,
          blockers: run.report?.blockers ?? [],
          followUpNeeded: false,
        },
        metadata: {
          ...(run.metadata ?? {}),
          goalLifecycle: { action: "cancelled_by_parent_goal", goalAction: input.action, at: now() },
        },
      });
      await runtime.upsertRun(cancelled);
      await deps.appendSubagentReceipt({
        parentSession: input.context.session,
        parentTurnId: input.context.turnId,
        run: cancelled,
        eventName: "subagent.cancelled",
        status: "failed",
        output: reason,
      });
      result.cancelledCount += 1;
    }
    return result;
  }

  async function archiveSubagentChildSession(input: {
    parentSession: Session;
    parentTurnId?: string | null;
    run: SubagentRun;
    reason: string;
    policy: string;
  }): Promise<{ run: SubagentRun; sessionArchive: Record<string, unknown> }> {
    const runtime = deps.requireSubagentDeps();
    if (!input.run.childSessionId) {
      return { run: input.run, sessionArchive: { status: "missing_child_session" } };
    }
    let sessionArchive: Record<string, unknown>;
    try {
      const child = await deps.getSession(input.run.childSessionId);
      if (!child.archived) await deps.updateSession(child.id, { archived: true });
      sessionArchive = { status: child.archived ? "already_archived" : "archived", archivedAt: now() };
    } catch (error) {
      sessionArchive = { status: "failed", error: textFromUnknown(error) || "Failed to archive child conversation." };
    }
    const updated = SubagentRunSchema.parse({
      ...input.run,
      metadata: {
        ...(input.run.metadata ?? {}),
        childSessionArchive: { ...sessionArchive, reason: input.reason, policy: input.policy },
      },
    });
    await runtime.upsertRun(updated);
    await deps.appendSubagentReceipt({
      parentSession: input.parentSession,
      parentTurnId: input.parentTurnId,
      run: updated,
      eventName: "subagent.archived",
      status: sessionArchive.status === "failed" ? "failed" : "completed",
      output: sessionArchive.status === "failed"
        ? `Failed to archive ${updated.roleId} child conversation.`
        : `Archived ${updated.roleId} child conversation.`,
    });
    return { run: updated, sessionArchive };
  }

  function subagentLifecycleActionNextStep(
    action: SubagentLifecycleActionResponse["action"],
    workspaceCleanup: Record<string, unknown> | null,
    sessionArchive: Record<string, unknown> | null,
  ): string {
    if (action === "cleanup") return workspaceCleanup ? "Child workspace cleanup finished." : "No child workspace cleanup was needed.";
    if (action === "archive") return sessionArchive ? "Child conversation archive finished." : "No child conversation was available to archive.";
    return "Child workspace cleanup and conversation archive finished.";
  }

  return {
    applyGoalLifecycleToSubagents,
    archiveSubagentChildSession,
    markGoalSubagentsNeedsResume,
    subagentLifecycleActionNextStep,
  };
}
