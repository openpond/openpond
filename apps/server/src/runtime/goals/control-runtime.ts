import {
  type RuntimeEvent,
  type Session,
  type SubagentRun,
  type Turn,
} from "@openpond/contracts";
import type {
  OpenPondGoalControlToolInput,
  OpenPondGoalControlToolResult,
} from "../../openpond/capability-tool-registry.js";
import type { ModelToolExecutionContext } from "../../openpond/model-tool-registry.js";
import {
  runOpenPondGoalControl,
  type OpenPondGoalControlAction,
  type OpenPondGoalControlGoal,
  type OpenPondGoalControlResult,
  type OpenPondGoalSubagentRunSummary,
  type OpenPondGoalSubagentState,
} from "../../openpond/goal-control.js";
import {
  isContinuableOpenPondGoal,
  normalizeOpenPondGoalForContinuation,
  openPondGoalContinuationPrompt,
} from "./continuation-policy.js";
import { event, now, textFromUnknown } from "../../utils.js";
import type { BackgroundWorkerQueue, BackgroundWorkReceipt } from "../background-worker-queue.js";
import type { KeyedRegistry } from "../turns/keyed-registry.js";
import { recordFromUnknown, stringFromRecord } from "../turns/value-utils.js";

export function createGoalControlRuntime(deps: {
  enableGoalContinuations: boolean;
  subagentToolsAvailable(): boolean;
  requireSubagentDeps(): {
    listRuns(input: {
      parentSessionId?: string;
      parentGoalId?: string;
      status?: SubagentRun["status"][];
      limit?: number;
    }): Promise<SubagentRun[]>;
  };
  currentGoal(sessionId: string): Promise<Record<string, unknown> | null>;
  goalById(sessionId: string, goalId: string): Promise<Record<string, unknown> | null>;
  claimGoal?: ((input: {
    sessionId: string;
    goalId: string;
    status: string;
    updatedAt: string;
  }) => Promise<unknown>) | null;
  releaseGoalClaim?: ((sessionId: string, goalId: string) => Promise<unknown>) | null;
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
  turnFollowUpQueue: BackgroundWorkerQueue;
  goalContinuationJobs: KeyedRegistry<BackgroundWorkReceipt>;
  sendTurn(sessionId: string, payload: unknown): Promise<Turn>;
  activeInProgressTurn(sessionId: string): Promise<Turn | null>;
  findInProgressTurn(sessionId: string): Promise<Turn | null>;
  markGoalSubagentsNeedsResume(input: {
    context: ModelToolExecutionContext;
    goalId: string;
    action: OpenPondGoalControlAction;
  }): Promise<number>;
  applyGoalLifecycleToSubagents(input: {
    context: ModelToolExecutionContext;
    goalId: string;
    action: OpenPondGoalControlAction;
  }): Promise<Record<string, number>>;
}) {
  const enableGoalContinuations = deps.enableGoalContinuations;
  const subagentToolsAvailable = deps.subagentToolsAvailable;
  const requireSubagentDeps = deps.requireSubagentDeps;
  const appendRuntimeEvent = deps.appendRuntimeEvent;
  const turnFollowUpQueue = deps.turnFollowUpQueue;
  const goalContinuationJobs = deps.goalContinuationJobs;
  const sendTurn = deps.sendTurn;
  const activeInProgressTurn = deps.activeInProgressTurn;
  const findInProgressTurn = deps.findInProgressTurn;
  const markGoalSubagentsNeedsResume = deps.markGoalSubagentsNeedsResume;
  const applyGoalLifecycleToSubagents = deps.applyGoalLifecycleToSubagents;
  const store = {
    currentOpenPondThreadGoal: deps.currentGoal,
    openPondThreadGoalById: deps.goalById,
    claimOpenPondThreadGoal: deps.claimGoal,
    releaseOpenPondThreadGoalClaim: deps.releaseGoalClaim,
  };
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  async function startGoalControlFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondGoalControlToolInput,
  ): Promise<OpenPondGoalControlToolResult> {
    const targetGoal = normalizeOpenPondGoalForContinuation(input.targetGoalId
      ? await store.openPondThreadGoalById(context.session.id, input.targetGoalId)
      : await store.currentOpenPondThreadGoal(context.session.id));
    const result = runOpenPondGoalControl({
      session: context.session,
      targetGoal,
      request: input,
    });
    const claimed = result.action === "start" && Boolean(store.claimOpenPondThreadGoal);
    if (claimed) {
      await store.claimOpenPondThreadGoal!({
        sessionId: context.session.id,
        goalId: result.goal.id,
        status: result.goal.status,
        updatedAt: result.goal.updatedAt,
      });
    }
    try {
      return await persistGoalControlFromModelTool(context, input, result);
    } catch (error) {
      if (claimed) {
        await store.releaseOpenPondThreadGoalClaim?.(context.session.id, result.goal.id).catch(() => undefined);
      }
      throw error;
    }
  }

  async function persistGoalControlFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondGoalControlToolInput,
    result: OpenPondGoalControlResult,
  ): Promise<OpenPondGoalControlToolResult> {
    const resumedSubagentCount = await markGoalSubagentsNeedsResume({
      context,
      goalId: result.goal.id,
      action: result.action,
    });
    const lifecycleSubagentResult = await applyGoalLifecycleToSubagents({
      context,
      goalId: result.goal.id,
      action: result.action,
    });
    const subagentLifecycle = lifecycleSubagentResult;
    const lifecycleNotes = [
      resumedSubagentCount > 0
        ? result.action === "resume"
          ? `${resumedSubagentCount} ${resumedSubagentCount === 1 ? "subagent was" : "subagents were"} queued to resume.`
          : `${resumedSubagentCount} active ${resumedSubagentCount === 1 ? "subagent needs" : "subagents need"} resume.`
        : null,
      lifecycleSubagentResult.cancelledCount > 0
        ? `${lifecycleSubagentResult.cancelledCount} linked ${lifecycleSubagentResult.cancelledCount === 1 ? "subagent was" : "subagents were"} cancelled.`
        : null,
      lifecycleSubagentResult.cleanedCount > 0
        ? `${lifecycleSubagentResult.cleanedCount} linked ${lifecycleSubagentResult.cleanedCount === 1 ? "workspace was" : "workspaces were"} cleaned or retained by policy.`
        : null,
      lifecycleSubagentResult.archivedCount > 0
        ? `${lifecycleSubagentResult.archivedCount} linked child ${lifecycleSubagentResult.archivedCount === 1 ? "session was" : "sessions were"} archived.`
        : null,
    ].filter(Boolean);
    const nextStep = lifecycleNotes.length > 0
      ? `${result.nextStep} ${lifecycleNotes.join(" ")}`
      : result.nextStep;
    const goal = await openPondGoalWithDerivedSubagentState({
      context,
      goal: result.goal,
    });
    await appendRuntimeEvent(
      event({
        sessionId: context.session.id,
        turnId: context.turnId,
        name: "diagnostic",
        source: "provider",
        appId: context.session.appId,
        status: "completed",
        output: nextStep,
        data: {
          kind: "goal_control",
          provider: "openpond",
          action: input.action,
          mode: result.mode,
          reason: input.reason,
          goal,
          previousGoal: result.previousGoal,
          subagentLifecycle,
        },
      }),
    );
    await appendRuntimeEvent(
      event({
        sessionId: context.session.id,
        turnId: context.turnId,
        name: "diagnostic",
        source: "provider",
        appId: context.session.appId,
        status: "completed",
        output: goal.objective,
        data: {
          kind: "thread_goal",
          provider: "openpond",
          goal,
        },
      }),
    );
    if (shouldQueueOpenPondGoalContinuation(result.action, goal)) {
      queueOpenPondGoalContinuation({
        session: context.session,
        sourceTurnId: context.turnId,
        action: result.action,
        goal,
      });
    }
    return {
      goalId: goal.id,
      action: result.action,
      status: result.status,
      objective: goal.objective,
      mode: result.mode,
      nextStep,
    };
  }

  async function openPondGoalWithDerivedSubagentState(input: {
    context: ModelToolExecutionContext;
    goal: OpenPondGoalControlGoal;
  }): Promise<OpenPondGoalControlGoal> {
    if (!subagentToolsAvailable()) return input.goal;
    const subagents = await derivedGoalSubagentState({
      parentSessionId: input.context.session.id,
      parentGoalId: input.goal.id,
    });
    return {
      ...input.goal,
      subagents,
    };
  }

  async function derivedGoalSubagentState(input: {
    parentSessionId: string;
    parentGoalId: string;
  }): Promise<OpenPondGoalSubagentState> {
    const deps = requireSubagentDeps();
    const runs = await deps.listRuns({
      parentSessionId: input.parentSessionId,
      parentGoalId: input.parentGoalId,
      limit: 1000,
    });
    const summaries = runs.map(goalSubagentRunSummary);
    return {
      source: "subagent_runs",
      updatedAt: now(),
      totalCount: runs.length,
      activeCount: runs.filter(goalSubagentRunActive).length,
      completedCount: runs.filter((run) => run.status === "completed").length,
      failedCount: runs.filter((run) => run.status === "failed").length,
      cancelledCount: runs.filter((run) => run.status === "cancelled").length,
      needsResumeCount: runs.filter((run) => run.status === "needs_resume").length,
      terminalCount: runs.filter(goalSubagentRunTerminal).length,
      cleanupNeededCount: runs.filter(goalSubagentRunCleanupNeeded).length,
      archivedCount: runs.filter(goalSubagentRunArchived).length,
      unresolvedCount: runs.filter((run) => !subagentRunResolvedForGoal(run)).length,
      runs: summaries,
    };
  }

  function goalSubagentRunSummary(run: SubagentRun): OpenPondGoalSubagentRunSummary {
    const cleanup = recordFromUnknown(run.metadata?.lifecycleCleanup);
    const workspaceCleanup = recordFromUnknown(cleanup?.workspaceCleanup);
    const childSessionArchive = recordFromUnknown(run.metadata?.childSessionArchive);
    const archiveStatus = stringFromRecord(childSessionArchive ?? {}, "status");
    return {
      id: run.id,
      childSessionId: run.childSessionId,
      roleId: run.roleId,
      status: run.status,
      objective: run.objective,
      updatedAt: run.updatedAt ?? run.completedAt ?? run.startedAt ?? run.createdAt ?? null,
      cleanupStatus: stringFromRecord(workspaceCleanup ?? cleanup ?? {}, "status"),
      archiveStatus,
      sessionArchived: archiveStatus === "archived" || archiveStatus === "already_archived",
      blockerCount: (run.report?.blockers.length ?? 0) + (run.error ? 1 : 0),
      validationAttemptCount: run.progress?.validationAttempts.length ?? 0,
      changedFileCount: run.progress?.changedFiles.length ?? 0,
      followUpNeeded: run.report?.followUpNeeded ?? false,
    };
  }

  function goalSubagentRunActive(run: SubagentRun): boolean {
    return run.status === "queued" || run.status === "running" || run.status === "needs_resume";
  }

  function goalSubagentRunTerminal(run: SubagentRun): boolean {
    return run.status === "completed" || run.status === "failed" || run.status === "cancelled";
  }

  function subagentRunResolvedForGoal(run: SubagentRun): boolean {
    return goalSubagentRunTerminal(run);
  }

  function goalSubagentRunCleanupNeeded(run: SubagentRun): boolean {
    if (!goalSubagentRunTerminal(run)) return false;
    const metadata = recordFromUnknown(run.metadata);
    if (!metadata?.subagentWorkspace && !metadata?.workspaceHandoff) return false;
    const cleanup = recordFromUnknown(run.metadata?.lifecycleCleanup);
    const workspaceCleanup = recordFromUnknown(cleanup?.workspaceCleanup);
    return !workspaceCleanup;
  }

  function goalSubagentRunArchived(run: SubagentRun): boolean {
    const childSessionArchive = recordFromUnknown(run.metadata?.childSessionArchive);
    const archiveStatus = stringFromRecord(childSessionArchive ?? {}, "status");
    return archiveStatus === "archived" || archiveStatus === "already_archived";
  }

  function shouldQueueOpenPondGoalContinuation(
    action: OpenPondGoalControlAction,
    goal: OpenPondGoalControlGoal,
  ): boolean {
    return enableGoalContinuations &&
      (action === "start" || action === "restart" || action === "resume") &&
      isContinuableOpenPondGoal(goal);
  }

  function queueOpenPondGoalContinuation(input: {
    session: Session;
    sourceTurnId: string;
    action: OpenPondGoalControlAction;
    goal: OpenPondGoalControlGoal;
  }): void {
    const key = `${input.session.id}:${input.goal.id}:${input.sourceTurnId}:${input.action}`;
    if (goalContinuationJobs.has(key)) return;
    const receipt = turnFollowUpQueue.enqueue(
      {
        label: `Continue goal: ${input.goal.objective.slice(0, 80)}`,
        metadata: {
          key,
          sessionId: input.session.id,
          sourceTurnId: input.sourceTurnId,
          goalId: input.goal.id,
          action: input.action,
        },
      },
      async () => {
        try {
          await waitForSessionIdle(input.session.id);
          const latestGoal = normalizeOpenPondGoalForContinuation(
            await store.currentOpenPondThreadGoal(input.session.id),
          );
          if (!latestGoal || latestGoal.id !== input.goal.id || !isContinuableOpenPondGoal(latestGoal)) {
            await appendRuntimeEvent(
              event({
                sessionId: input.session.id,
                turnId: input.sourceTurnId,
                name: "goal.continuation.skipped",
                source: "server",
                appId: input.session.appId,
                status: "completed",
                output: "Goal continuation skipped because the goal is no longer active.",
                data: {
                  goalId: input.goal.id,
                  latestGoalId: latestGoal?.id ?? null,
                  latestStatus: latestGoal?.status ?? null,
                },
              }),
            );
            return;
          }

          if (subagentToolsAvailable()) {
            const activeChildren = await requireSubagentDeps().listRuns({
              parentSessionId: input.session.id,
              parentGoalId: latestGoal.id,
              status: ["queued", "running", "needs_resume"],
              limit: 1_000,
            });
            if (activeChildren.length > 0) {
              await appendRuntimeEvent(
                event({
                  sessionId: input.session.id,
                  turnId: input.sourceTurnId,
                  name: "goal.continuation.skipped",
                  source: "server",
                  appId: input.session.appId,
                  status: "completed",
                  output: "Goal continuation deferred to active child completion.",
                  data: {
                    goalId: latestGoal.id,
                    activeSubagentRunIds: activeChildren.map((run) => run.id),
                    reason: "active_subagent_completion_will_continue_parent",
                  },
                }),
              );
              return;
            }
          }

          await appendRuntimeEvent(
            event({
              sessionId: input.session.id,
              turnId: input.sourceTurnId,
              name: "goal.continuation.started",
              source: "server",
              appId: input.session.appId,
              status: "started",
              output: "Goal continuation queued.",
              data: {
                goalId: latestGoal.id,
                action: input.action,
              },
            }),
          );
          await sendTurn(input.session.id, {
            prompt: openPondGoalContinuationPrompt(latestGoal),
            metadata: {
              goalContinuation: {
                goalId: latestGoal.id,
                sourceTurnId: input.sourceTurnId,
                action: input.action,
              },
              threadGoal: latestGoal,
            },
            usageAttribution: {
              surface: "goal",
              workflowKind: "goal_control",
              goalId: latestGoal.id,
              commandName: "/goal",
              commandSource: "model_tool",
            },
          });
        } catch (error) {
          await appendRuntimeEvent(
            event({
              sessionId: input.session.id,
              turnId: input.sourceTurnId,
              name: "goal.continuation.failed",
              source: "server",
              appId: input.session.appId,
              status: "failed",
              output: textFromUnknown(error) || "Goal continuation failed.",
              error: textFromUnknown(error) || undefined,
              data: {
                goalId: input.goal.id,
                action: input.action,
              },
            }),
          ).catch(() => undefined);
        } finally {
          goalContinuationJobs.delete(key);
        }
      },
    );
    goalContinuationJobs.set(key, receipt);
  }

  async function waitForSessionIdle(sessionId: string): Promise<void> {
    while ((await activeInProgressTurn(sessionId)) || (await findInProgressTurn(sessionId))) {
      await delay(100);
    }
  }


  return { startGoalControlFromModelTool };
}
