import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBackgroundWorkerQueue } from "../apps/server/src/runtime/background-worker-queue";
import { createSubagentLifecycleWatcher } from "../apps/server/src/runtime/subagent-lifecycle-watcher";
import { createTurnRunner } from "../apps/server/src/runtime/turn-runner";
import { withTurnRunnerTestStore } from "./helpers/turn-runner-test-harness";
import { latestSubagentRuntimeFromEvents } from "../apps/web/src/lib/subagent-runtime";
import {
  AppPreferencesSchema,
  ModelUsageRecordSchema,
  SubagentMessageSchema,
  SubagentRunSchema,
  type Approval,
  type AppPreferences,
  type ConnectedAppConnectionLike,
  type ModelUsageRecord,
  type RuntimeEvent,
  type Session,
  type SubagentMessage,
  type SubagentRun,
  type Turn,
  type WorkspaceToolResult,
} from "../packages/contracts/src";
import {
  activeGoalEvent,
  baseSession,
  createSubagentHarness,
  git,
  preferences,
  preferencesWithSubagentRole,
  subagentWatcherStoreForHarness,
  turnFixture,
  usageRecord,
  withTimeout,
} from "./helpers/turn-runner-subagent-harness";

describe("turn runner subagent native tools", () => {
  test("resolves same-turn goal control against fresh runtime events", async () => {
    let startedGoalId: string | null = null;
    const harness = createSubagentHarness({
      toolName: "openpond_goal_control",
      toolArgs: {},
      preferences: preferences(),
      disableDefaultToolCall: true,
      toolCallForStream: async (_streamInput, context) => {
        if (context.streamPass === 1) {
          return {
            name: "openpond_goal_control",
            args: {
              action: "start",
              objective: "Fix the same-turn goal snapshot regression.",
              reason: "Start the requested goal.",
            },
          };
        }
        if (context.streamPass === 2) {
          const latestGoal = context.events.filter(
            (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
          ).at(-1);
          startedGoalId = (latestGoal?.data as any)?.goal?.id ?? null;
          if (!startedGoalId) throw new Error("Expected the first goal-control call to persist a thread goal.");
          return {
            name: "openpond_goal_control",
            args: {
              action: "complete",
              targetGoalId: startedGoalId,
              reason: "The same model turn completed the bounded goal.",
            },
          };
        }
        return null;
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start and complete this bounded goal in one turn",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const goalControls = harness.events.filter(
      (event) => event.name === "tool.completed" && event.action === "openpond_goal_control",
    );
    expect(goalControls).toHaveLength(2);
    expect(goalControls[0]).toMatchObject({ status: "completed" });
    expect(goalControls[1]).toMatchObject({
      status: "completed",
      data: {
        result: {
          goalId: startedGoalId,
          action: "complete",
          status: "completed",
        },
      },
    });
  });

  test("marks active child runs as needs_resume when the parent goal resumes", async () => {
    const pausedGoal = activeGoalEvent();
    ((pausedGoal.data as any).goal as any).status = "paused";
    const activeRun = SubagentRunSchema.parse({
      id: "run_active",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_active",
      roleId: "research",
      objective: "Resume research",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "running",
      required: true,
      createdAt: "2026-07-07T09:00:00.000Z",
      startedAt: "2026-07-07T09:00:01.000Z",
    });
    const completedRun = SubagentRunSchema.parse({
      ...activeRun,
      id: "run_completed",
      childSessionId: "session_child_completed",
      status: "completed",
      completedAt: "2026-07-07T09:10:00.000Z",
    });
    const harness = createSubagentHarness({
      toolName: "openpond_goal_control",
      toolArgs: {
        action: "resume",
        targetGoalId: "goal_1",
        reason: "Resume the paused goal.",
      },
      preferences: preferences(),
      initialEvents: [pausedGoal],
      initialRuns: [activeRun, completedRun],
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Resume this goal",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.runs.find((run) => run.id === "run_active")).toMatchObject({
      status: "needs_resume",
      report: {
        followUpNeeded: true,
        blockers: [
          "Goal resumed; this child conversation needs resume before its required subagent work can finish.",
        ],
      },
      metadata: {
        needsResumeReason: "parent_goal_resumed",
      },
    });
    expect(harness.runs.find((run) => run.id === "run_completed")?.status).toBe("completed");
    expect(harness.events.some(
      (event) =>
        event.name === "subagent.blocked" &&
        (event.data as any)?.run?.id === "run_active" &&
        (event.data as any)?.run?.status === "needs_resume",
    )).toBe(true);
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_goal_control",
    );
    expect((completed?.data as any)?.result?.nextStep).toContain("1 active subagent needs resume.");
  });

  test("resumes child follow-up turns with subagent attribution and turn budget accounting", async () => {
    const run = SubagentRunSchema.parse({
      id: "run_resume_followup",
      parentSessionId: "session_1",
      parentTurnId: "turn_parent",
      parentGoalId: "goal_1",
      childSessionId: "session_child",
      roleId: "research",
      objective: "Finish the resumed research pass",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "needs_resume",
      required: true,
      createdAt: "2026-07-07T09:00:00.000Z",
      startedAt: "2026-07-07T09:01:00.000Z",
      report: {
        summary: "Research was interrupted.",
        blockers: ["Goal resumed; this child conversation needs resume before its required subagent work can finish."],
        followUpNeeded: true,
      },
      metadata: {
        childTurnPermissions: {
          approvalPolicy: "never",
          sandbox: "read-only",
          codexPermissionMode: "full-access",
        },
        tokenBudget: {
          roleMaxTurns: 2,
        },
      },
    });
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_status",
      toolArgs: {},
      preferences: preferencesWithSubagentRole("research", { maxTurns: 2 }),
      initialEvents: [activeGoalEvent()],
      initialRuns: [run],
      textBySessionId: {
        session_child: ["Follow-up research complete."],
      },
      usageBySessionId: {
        session_child: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      },
    });
    harness.sessions.set(
      "session_child",
      baseSession({
        id: "session_child",
        parentSessionId: "session_1",
        parentTurnId: "turn_parent",
        parentGoalId: "goal_1",
        subagentRunId: "run_resume_followup",
        subagentRoleId: "research",
        hiddenFromDefaultSidebar: true,
        title: "Research child",
        metadata: {
          subagent: {
            runId: "run_resume_followup",
            roleId: "research",
            parentSessionId: "session_1",
            parentGoalId: "goal_1",
            toolPolicy: "read_only",
          },
        },
      }),
    );
    harness.turns.push(turnFixture({ id: "turn_child_initial", sessionId: "session_child" }));

    const turn = await harness.runner.sendTurn("session_child", {
      prompt: "Resume and finish the research pass",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      sandbox: "danger-full-access",
      approvalPolicy: "on-request",
      codexPermissionMode: "default",
    });

    expect(turn.status).toBe("completed");
    expect(turn.metadata).toMatchObject({
      usageAttribution: {
        workflowKind: "subagent",
        goalId: "goal_1",
        subagentRunId: "run_resume_followup",
        subagentRoleId: "research",
      },
    });
    const updatedRun = harness.runs.find((candidate) => candidate.id === "run_resume_followup");
    expect(updatedRun).toMatchObject({
      status: "submitted_for_review",
      review: {
        status: "submitted_for_review",
      },
      report: {
        summary: "Follow-up research complete.",
        followUpNeeded: false,
      },
      metadata: {
        usage: {
          totalTokens: 12,
          requestCount: 1,
        },
        turnBudget: {
          usedTurns: 2,
          maxTurns: 2,
        },
      },
    });
    expect(harness.usageRecords.find((record) => record.attribution.subagentRunId === "run_resume_followup")).toMatchObject({
      requestKind: "subagent",
      visibility: "background",
      totalTokens: 12,
      attribution: {
        workflowKind: "subagent",
        goalId: "goal_1",
        subagentRunId: "run_resume_followup",
        subagentRoleId: "research",
      },
    });
    expect(harness.events.some((event) => event.name === "subagent.started" && event.sessionId === "session_1")).toBe(true);
    expect(harness.events.some((event) => event.name === "subagent.submitted" && event.sessionId === "session_1")).toBe(true);
  });

  test("blocks child follow-up turns when the role turn budget is exhausted", async () => {
    const run = SubagentRunSchema.parse({
      id: "run_turn_budget",
      parentSessionId: "session_1",
      parentTurnId: "turn_parent",
      parentGoalId: "goal_1",
      childSessionId: "session_child",
      roleId: "research",
      objective: "Do one bounded research pass",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "needs_resume",
      required: true,
      createdAt: "2026-07-07T09:00:00.000Z",
    });
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_status",
      toolArgs: {},
      preferences: preferencesWithSubagentRole("research", { maxTurns: 1 }),
      initialEvents: [activeGoalEvent()],
      initialRuns: [run],
    });
    harness.sessions.set(
      "session_child",
      baseSession({
        id: "session_child",
        parentSessionId: "session_1",
        parentTurnId: "turn_parent",
        parentGoalId: "goal_1",
        subagentRunId: "run_turn_budget",
        subagentRoleId: "research",
        hiddenFromDefaultSidebar: true,
      }),
    );
    harness.turns.push(turnFixture({ id: "turn_child_initial", sessionId: "session_child" }));

    await expect(
      harness.runner.sendTurn("session_child", {
        prompt: "Try one more research turn",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      }),
    ).rejects.toThrow("Subagent role research turn budget reached: 1/1 turns used for run run_turn_budget.");
    expect(harness.turns.filter((turn) => turn.sessionId === "session_child")).toHaveLength(1);
    expect(harness.streamInputs).toHaveLength(0);
    expect(harness.runs.find((candidate) => candidate.id === "run_turn_budget")?.status).toBe("needs_resume");
  });

  test("cancels an unfinished subagent and cleans up its isolated workspace", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-subagent-cancel-test-"));
    const workspaceRoot = path.join(tempRoot, "isolated");
    try {
      await mkdir(workspaceRoot, { recursive: true });
      await writeFile(path.join(workspaceRoot, "marker.txt"), "child workspace\n", "utf8");
      const run = SubagentRunSchema.parse({
        id: "run_cancel",
        parentSessionId: "session_1",
        parentTurnId: "turn_parent",
        parentGoalId: "goal_1",
        childSessionId: "session_child",
        roleId: "coding",
        objective: "Cancelled coding task",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
        isolationMode: "copy_on_write",
        toolPolicy: "workspace_write",
        background: true,
        peerMessages: "goal_scoped",
        status: "needs_resume",
        required: true,
        createdAt: "2026-07-07T09:00:00.000Z",
        metadata: {
          subagentWorkspace: {
            mode: "copy_on_write",
            implementation: "git_worktree",
            target: "local",
            workspaceRoot,
            repoPath: path.join(workspaceRoot, "repo"),
            worktreePath: path.join(workspaceRoot, "repo"),
            parentRepoPath: null,
          },
        },
      });
      const harness = createSubagentHarness({
        toolName: "openpond_subagent_cancel",
        toolArgs: {
          runId: "run_cancel",
          reason: "No longer needed.",
        },
        preferences: preferences(),
        initialEvents: [activeGoalEvent()],
        initialRuns: [run],
      });
      harness.sessions.set(
        "session_child",
        baseSession({
          id: "session_child",
          parentSessionId: "session_1",
          parentTurnId: "turn_parent",
          parentGoalId: "goal_1",
          subagentRunId: "run_cancel",
          subagentRoleId: "coding",
          hiddenFromDefaultSidebar: true,
        }),
      );

      const turn = await harness.runner.sendTurn("session_1", {
        prompt: "Cancel the coding subagent",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      });

      expect(turn.status).toBe("completed");
      const cancelledRun = harness.runs.find((candidate) => candidate.id === "run_cancel");
      expect(cancelledRun).toMatchObject({
        status: "cancelled",
        error: "No longer needed.",
        report: {
          followUpNeeded: false,
          blockers: ["No longer needed."],
        },
        metadata: {
          lifecycleCleanup: {
            reason: "cancel_requested",
            workspaceCleanup: {
              status: "removed",
              workspaceRoot,
            },
          },
          cancellation: {
            reason: "No longer needed.",
            workspaceCleanup: {
              status: "removed",
              workspaceRoot,
            },
          },
        },
      });
      await expect(readFile(path.join(workspaceRoot, "marker.txt"), "utf8")).rejects.toThrow();
      expect(harness.events.some((event) => event.name === "subagent.cleanup" && event.status === "started")).toBe(true);
      expect(harness.events.some((event) => event.name === "subagent.cleanup" && event.status === "completed")).toBe(true);
      expect(
        harness.events.some(
          (event) =>
            event.name === "subagent.cancelled" &&
            event.sessionId === "session_1" &&
            (event.data as any)?.run?.status === "cancelled",
        ),
      ).toBe(true);
      const completed = harness.events.find(
        (event) => event.name === "tool.completed" && event.action === "openpond_subagent_cancel",
      );
      expect((completed?.data as any)?.result).toMatchObject({
        runId: "run_cancel",
        status: "cancelled",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("blocks goal completion while required subagents are unresolved", async () => {
    const unresolvedRun = SubagentRunSchema.parse({
      id: "run_unresolved",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_unresolved",
      roleId: "research",
      objective: "Finish research",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "submitted_for_review",
      required: true,
      review: {
        status: "submitted_for_review",
      },
      report: {
        summary: "Child submitted research but parent has not accepted it.",
        followUpNeeded: true,
      },
      createdAt: "2026-07-07T09:00:00.000Z",
    });
    const harness = createSubagentHarness({
      toolName: "openpond_goal_control",
      toolArgs: {
        action: "complete",
        targetGoalId: "goal_1",
        reason: "The parent thinks the goal is done.",
      },
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      initialRuns: [unresolvedRun],
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Complete this goal",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_goal_control",
    );
    expect(completed).toMatchObject({ status: "failed" });
    expect(completed?.output).toContain("Cannot complete goal goal_1 while required subagents are unresolved");
    expect(completed?.output).toContain("research submitted_for_review (run_unresolved)");
    const latestThreadGoal = harness.events.filter(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
    ).at(-1);
    expect((latestThreadGoal?.data as any)?.goal?.status).toBe("running");
  });

  test("allows goal completion after a failed required subagent is explicitly dismissed", async () => {
    const failedRun = SubagentRunSchema.parse({
      id: "run_failed_required",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_failed_required",
      roleId: "research",
      objective: "Finish research",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "failed",
      required: true,
      error: "Research provider failed after retries.",
      report: {
        summary: "Research failed before producing useful evidence.",
        blockers: ["Research provider failed after retries."],
        followUpNeeded: true,
      },
      createdAt: "2026-07-07T09:00:00.000Z",
      completedAt: "2026-07-07T09:10:00.000Z",
    });
    const harness = createSubagentHarness({
      toolName: "openpond_goal_control",
      toolArgs: {},
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      initialRuns: [failedRun],
      disableDefaultToolCall: true,
      toolCallForStream: async (_streamInput, context) => {
        if (!context.injectedFlags.completeBeforeDismiss) {
          context.injectedFlags.completeBeforeDismiss = true;
          return {
            name: "openpond_goal_control",
            args: {
              action: "complete",
              targetGoalId: "goal_1",
              reason: "Try to finish before acknowledging failed research.",
            },
          };
        }
        if (!context.injectedFlags.dismissFailedChild) {
          context.injectedFlags.dismissFailedChild = true;
          return {
            name: "openpond_subagent_review",
            args: {
              runId: "run_failed_required",
              decision: "dismiss",
              summary: "Acknowledged failed required research; parent will proceed without accepting child work.",
              issues: ["Research provider failed after retries."],
            },
          };
        }
        if (!context.injectedFlags.completeAfterDismiss) {
          context.injectedFlags.completeAfterDismiss = true;
          return {
            name: "openpond_goal_control",
            args: {
              action: "complete",
              targetGoalId: "goal_1",
              reason: "Required failed child was explicitly dismissed.",
            },
          };
        }
        return null;
      },
    });
    harness.sessions.set(
      "session_child_failed_required",
      baseSession({
        id: "session_child_failed_required",
        parentSessionId: "session_1",
        parentTurnId: "turn_prior",
        parentGoalId: "goal_1",
        subagentRunId: "run_failed_required",
        subagentRoleId: "research",
        hiddenFromDefaultSidebar: true,
      }),
    );

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Complete this goal after acknowledging failed subagent work",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const goalCompletions = harness.events.filter(
      (event) => event.name === "tool.completed" && event.action === "openpond_goal_control",
    );
    expect(goalCompletions[0]).toMatchObject({ status: "failed" });
    expect(goalCompletions[0]?.output).toContain("research failed (run_failed_required)");
    expect(goalCompletions.at(-1)).toMatchObject({
      status: "completed",
      data: {
        result: {
          action: "complete",
          status: "completed",
        },
      },
    });
    const reviewCompleted = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_subagent_review",
    );
    expect((reviewCompleted?.data as any)?.result).toMatchObject({
      status: "failed",
      review: {
        status: "dismissed",
      },
      report: {
        followUpNeeded: false,
      },
    });
    expect(harness.events.some((event) => event.name === "subagent.dismissed" && (event.data as any)?.run?.id === "run_failed_required")).toBe(true);
    expect(harness.events.some((event) => event.name === "subagent.accepted" && (event.data as any)?.run?.id === "run_failed_required")).toBe(false);
    const dismissedRun = harness.runs.find((candidate) => candidate.id === "run_failed_required");
    expect(dismissedRun).toMatchObject({
      status: "failed",
      review: {
        status: "dismissed",
        summary: "Acknowledged failed required research; parent will proceed without accepting child work.",
      },
      metadata: {
        reviewDecision: {
          decision: "dismiss",
        },
        childSessionArchive: {
          status: "archived",
          policy: "goal_completed",
        },
      },
    });
    const latestThreadGoal = harness.events.filter(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
    ).at(-1);
    expect((latestThreadGoal?.data as any)?.goal).toMatchObject({
      status: "completed",
      subagents: {
        requiredAcceptedCount: 0,
        requiredBlockingCount: 0,
        requiredUnresolvedCount: 0,
        requiredArchivedCount: 1,
        runs: [
          expect.objectContaining({
            id: "run_failed_required",
            status: "failed",
            reviewStatus: "dismissed",
            archiveStatus: "archived",
            sessionArchived: true,
          }),
        ],
      },
    });
  });

  test("allows goal completion after a blocked required subagent is explicitly dismissed", async () => {
    const blockedRun = SubagentRunSchema.parse({
      id: "run_blocked_required",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_blocked_required",
      roleId: "research",
      objective: "Finish research that needs external approval",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "blocked",
      required: true,
      report: {
        summary: "Research is blocked waiting for an external approval.",
        blockers: ["External approval is unavailable."],
        followUpNeeded: true,
      },
      progress: {
        phase: "report",
        currentBlocker: "External approval is unavailable.",
        latestMeaningfulActivity: "Child reported a blocker.",
      },
      createdAt: "2026-07-07T09:00:00.000Z",
      updatedAt: "2026-07-07T09:10:00.000Z",
    });
    const harness = createSubagentHarness({
      toolName: "openpond_goal_control",
      toolArgs: {},
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      initialRuns: [blockedRun],
      disableDefaultToolCall: true,
      toolCallForStream: async (_streamInput, context) => {
        if (!context.injectedFlags.completeBeforeDismiss) {
          context.injectedFlags.completeBeforeDismiss = true;
          return {
            name: "openpond_goal_control",
            args: {
              action: "complete",
              targetGoalId: "goal_1",
              reason: "Try to finish before acknowledging blocked research.",
            },
          };
        }
        if (!context.injectedFlags.dismissBlockedChild) {
          context.injectedFlags.dismissBlockedChild = true;
          return {
            name: "openpond_subagent_review",
            args: {
              runId: "run_blocked_required",
              decision: "dismiss",
              summary: "Acknowledged blocked required research; parent will proceed without accepting child work.",
              issues: ["External approval is unavailable."],
            },
          };
        }
        if (!context.injectedFlags.completeAfterDismiss) {
          context.injectedFlags.completeAfterDismiss = true;
          return {
            name: "openpond_goal_control",
            args: {
              action: "complete",
              targetGoalId: "goal_1",
              reason: "Required blocked child was explicitly dismissed.",
            },
          };
        }
        return null;
      },
    });
    harness.sessions.set(
      "session_child_blocked_required",
      baseSession({
        id: "session_child_blocked_required",
        parentSessionId: "session_1",
        parentTurnId: "turn_prior",
        parentGoalId: "goal_1",
        subagentRunId: "run_blocked_required",
        subagentRoleId: "research",
        hiddenFromDefaultSidebar: true,
      }),
    );

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Complete this goal after acknowledging blocked subagent work",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const goalCompletions = harness.events.filter(
      (event) => event.name === "tool.completed" && event.action === "openpond_goal_control",
    );
    expect(goalCompletions[0]).toMatchObject({ status: "failed" });
    expect(goalCompletions[0]?.output).toContain("research blocked (run_blocked_required)");
    expect(goalCompletions.at(-1)).toMatchObject({
      status: "completed",
      data: {
        result: {
          action: "complete",
          status: "completed",
        },
      },
    });
    const reviewCompleted = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_subagent_review",
    );
    expect((reviewCompleted?.data as any)?.result).toMatchObject({
      status: "blocked",
      review: {
        status: "dismissed",
      },
      report: {
        followUpNeeded: false,
      },
    });
    expect(harness.events.some((event) => event.name === "subagent.dismissed" && (event.data as any)?.run?.id === "run_blocked_required")).toBe(true);
    expect(harness.events.some((event) => event.name === "subagent.accepted" && (event.data as any)?.run?.id === "run_blocked_required")).toBe(false);
    const dismissedRun = harness.runs.find((candidate) => candidate.id === "run_blocked_required");
    expect(dismissedRun).toMatchObject({
      status: "blocked",
      review: {
        status: "dismissed",
        summary: "Acknowledged blocked required research; parent will proceed without accepting child work.",
      },
      progress: {
        currentBlocker: null,
      },
      metadata: {
        reviewDecision: {
          decision: "dismiss",
        },
        childSessionArchive: {
          status: "archived",
          policy: "goal_completed",
        },
      },
    });
    const latestThreadGoal = harness.events.filter(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
    ).at(-1);
    expect((latestThreadGoal?.data as any)?.goal).toMatchObject({
      status: "completed",
      subagents: {
        requiredAcceptedCount: 0,
        requiredBlockingCount: 0,
        requiredUnresolvedCount: 0,
        requiredArchivedCount: 1,
        runs: [
          expect.objectContaining({
            id: "run_blocked_required",
            status: "blocked",
            reviewStatus: "dismissed",
            archiveStatus: "archived",
            sessionArchived: true,
          }),
        ],
      },
    });
  });

  test("allows goal completion when required subagents are resolved", async () => {
    const completedRun = SubagentRunSchema.parse({
      id: "run_completed",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_completed",
      roleId: "research",
      objective: "Finish research",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "completed",
      required: true,
      createdAt: "2026-07-07T09:00:00.000Z",
      completedAt: "2026-07-07T09:10:00.000Z",
    });
    const optionalOpenRun = SubagentRunSchema.parse({
      ...completedRun,
      id: "run_optional",
      childSessionId: "session_child_optional",
      status: "running",
      required: false,
      completedAt: null,
    });
    const harness = createSubagentHarness({
      toolName: "openpond_goal_control",
      toolArgs: {
        action: "complete",
        targetGoalId: "goal_1",
        reason: "Required child work is resolved.",
      },
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      initialRuns: [completedRun, optionalOpenRun],
    });
    harness.sessions.set(
      "session_child_completed",
      baseSession({
        id: "session_child_completed",
        parentSessionId: "session_1",
        parentTurnId: "turn_prior",
        parentGoalId: "goal_1",
        subagentRunId: "run_completed",
        subagentRoleId: "research",
        hiddenFromDefaultSidebar: true,
      }),
    );
    harness.sessions.set(
      "session_child_optional",
      baseSession({
        id: "session_child_optional",
        parentSessionId: "session_1",
        parentTurnId: "turn_prior",
        parentGoalId: "goal_1",
        subagentRunId: "run_optional",
        subagentRoleId: "research",
        hiddenFromDefaultSidebar: true,
      }),
    );

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Complete this goal",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_goal_control",
    );
    expect((completed?.data as any)?.result).toMatchObject({
      action: "complete",
      status: "completed",
      nextStep: expect.stringContaining("OpenPond goal completed."),
    });
    expect(completed?.output).toContain("1 linked subagent was cancelled.");
    expect(completed?.output).toContain("2 linked child sessions were archived.");
    const optionalRun = harness.runs.find((candidate) => candidate.id === "run_optional");
    expect(optionalRun).toMatchObject({
      status: "cancelled",
      error: "Parent goal goal_1 completed before optional subagent finished.",
      metadata: {
        goalLifecycle: {
          action: "cancelled_by_parent_goal",
          workspaceCleanup: {
            status: "skipped",
          },
        },
      },
    });
    const threadGoalIds = harness.events
      .filter((event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal")
      .map((event) => (event.data as any)?.goal?.id);
    expect([...new Set(threadGoalIds)]).toEqual(["goal_1"]);
    expect(latestSubagentRuntimeFromEvents(harness.events, "session_1")).toMatchObject({
      blockedCount: 0,
      unresolvedCount: 0,
      terminalCount: 2,
      label: "1 subagent cancelled",
      runs: expect.arrayContaining([
        expect.objectContaining({ id: "run_optional", status: "cancelled", required: false }),
      ]),
    });
    expect(harness.runs.find((candidate) => candidate.id === "run_completed")).toMatchObject({
      metadata: {
        childSessionArchive: {
          status: "archived",
          sessionId: "session_child_completed",
          policy: "goal_completed",
        },
      },
    });
    expect(optionalRun).toMatchObject({
      metadata: {
        childSessionArchive: {
          status: "archived",
          sessionId: "session_child_optional",
          policy: "goal_completed",
        },
      },
    });
    expect(harness.sessions.get("session_child_completed")).toMatchObject({
      archived: true,
      hiddenFromDefaultSidebar: true,
      metadata: {
        subagentArchive: {
          status: "archived",
          policy: "goal_completed",
          runId: "run_completed",
        },
      },
    });
    expect(harness.sessions.get("session_child_optional")).toMatchObject({
      archived: true,
      hiddenFromDefaultSidebar: true,
      metadata: {
        subagentArchive: {
          status: "archived",
          policy: "goal_completed",
          runId: "run_optional",
        },
      },
    });
    expect(harness.events.some((event) => event.name === "subagent.cleanup" && event.status === "completed")).toBe(true);
    expect(harness.events.some((event) => event.name === "subagent.cancelled" && (event.data as any)?.run?.id === "run_optional")).toBe(true);
    expect(harness.events.filter((event) => event.name === "subagent.archived" && event.status === "completed")).toHaveLength(2);
    const latestThreadGoal = harness.events.filter(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
    ).at(-1);
    expect((latestThreadGoal?.data as any)?.goal).toMatchObject({
      id: "goal_1",
      status: "completed",
      controlAction: "complete",
      subagents: {
        source: "subagent_runs",
        totalCount: 2,
        requiredCount: 1,
        optionalCount: 1,
        activeCount: 0,
        acceptedCount: 1,
        blockingCount: 0,
        terminalCount: 2,
        cleanupNeededCount: 0,
        archivedCount: 2,
        unresolvedCount: 0,
        requiredAcceptedCount: 1,
        requiredArchivedCount: 1,
        requiredUnresolvedCount: 0,
        runs: expect.arrayContaining([
          expect.objectContaining({
            id: "run_completed",
            status: "completed",
            required: true,
            cleanupStatus: "skipped",
            archiveStatus: "archived",
            sessionArchived: true,
          }),
          expect.objectContaining({
            id: "run_optional",
            status: "cancelled",
            required: false,
            cleanupStatus: "skipped",
            archiveStatus: "archived",
            sessionArchived: true,
          }),
        ]),
      },
    });
  });

  test("restarts a goal and supersedes linked child runs", async () => {
    const activeRun = SubagentRunSchema.parse({
      id: "run_restart_active",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_restart_active",
      roleId: "coding",
      objective: "Implement the old goal attempt",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "workspace_write",
      background: true,
      peerMessages: "goal_scoped",
      status: "running",
      required: true,
      createdAt: "2026-07-07T09:00:00.000Z",
      startedAt: "2026-07-07T09:00:10.000Z",
      updatedAt: "2026-07-07T09:00:10.000Z",
    });
    const acceptedRun = SubagentRunSchema.parse({
      id: "run_restart_accepted",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_restart_accepted",
      roleId: "review",
      objective: "Review the old goal attempt",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "accepted",
      required: true,
      createdAt: "2026-07-07T09:00:00.000Z",
      completedAt: "2026-07-07T09:10:00.000Z",
      updatedAt: "2026-07-07T09:10:00.000Z",
      review: {
        status: "accepted",
        decidedAt: "2026-07-07T09:10:00.000Z",
      },
      report: {
        summary: "Old attempt was reviewed.",
      },
    });
    const harness = createSubagentHarness({
      toolName: "openpond_goal_control",
      toolArgs: {
        action: "restart",
        targetGoalId: "goal_1",
        reason: "Restart with a cleaner assignment.",
      },
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      initialRuns: [activeRun, acceptedRun],
      initialTurns: [
        turnFixture({
          id: "turn_child_restart_active",
          sessionId: "session_child_restart_active",
          status: "in_progress",
          completedAt: null,
        }),
      ],
    });
    harness.sessions.set(
      "session_child_restart_active",
      baseSession({
        id: "session_child_restart_active",
        parentSessionId: "session_1",
        parentTurnId: "turn_prior",
        parentGoalId: "goal_1",
        subagentRunId: "run_restart_active",
        subagentRoleId: "coding",
        hiddenFromDefaultSidebar: true,
        status: "active",
      }),
    );

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Restart this goal",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_goal_control",
    );
    expect((completed?.data as any)?.result).toMatchObject({
      action: "restart",
      status: "queued",
      nextStep: expect.stringContaining("2 linked subagents were superseded."),
    });
    expect(harness.events.filter((event) => event.name === "subagent.superseded")).toHaveLength(2);
    expect(harness.turns.find((candidate) => candidate.id === "turn_child_restart_active")).toMatchObject({
      status: "interrupted",
    });
    expect(harness.runs.find((candidate) => candidate.id === "run_restart_active")).toMatchObject({
      status: "superseded",
      error: null,
      report: {
        summary: "Subagent superseded by parent goal restart.",
        followUpNeeded: false,
      },
      metadata: {
        superseded: {
          previousStatus: "running",
          previousGoalId: "goal_1",
          supersededByGoalId: "goal_1",
          interruptResult: {
            status: "interrupted",
            turnId: "turn_child_restart_active",
          },
        },
      },
    });
    expect(harness.runs.find((candidate) => candidate.id === "run_restart_accepted")).toMatchObject({
      status: "superseded",
      review: {
        status: "accepted",
      },
      report: {
        summary: "Old attempt was reviewed.",
        followUpNeeded: false,
      },
      metadata: {
        superseded: {
          previousStatus: "accepted",
          previousGoalId: "goal_1",
          supersededByGoalId: "goal_1",
          interruptResult: null,
        },
      },
    });
    const latestThreadGoal = harness.events.filter(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
    ).at(-1);
    expect((latestThreadGoal?.data as any)?.goal).toMatchObject({
      id: "goal_1",
      status: "queued",
      controlAction: "restart",
      subagents: {
        totalCount: 2,
        requiredCount: 2,
        activeCount: 0,
        acceptedCount: 0,
        blockingCount: 0,
        terminalCount: 2,
        cleanupNeededCount: 0,
        unresolvedCount: 0,
        requiredAcceptedCount: 0,
        requiredBlockingCount: 0,
        requiredUnresolvedCount: 0,
        runs: expect.arrayContaining([
          expect.objectContaining({
            id: "run_restart_active",
            status: "superseded",
            reviewStatus: "pending",
          }),
          expect.objectContaining({
            id: "run_restart_accepted",
            status: "superseded",
            reviewStatus: "accepted",
          }),
        ]),
      },
    });
  });

  test("stops a goal and cancels linked active subagents", async () => {
    const activeRun = SubagentRunSchema.parse({
      id: "run_active_goal_child",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_active",
      roleId: "coding",
      objective: "Implement optional work",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "running",
      required: true,
      createdAt: "2026-07-07T09:00:00.000Z",
    });
    const harness = createSubagentHarness({
      toolName: "openpond_goal_control",
      toolArgs: {
        action: "stop",
        targetGoalId: "goal_1",
        reason: "User stopped the goal.",
      },
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      initialRuns: [activeRun],
    });
    harness.sessions.set(
      "session_child_active",
      baseSession({
        id: "session_child_active",
        parentSessionId: "session_1",
        parentTurnId: "turn_prior",
        parentGoalId: "goal_1",
        subagentRunId: "run_active_goal_child",
        subagentRoleId: "coding",
        hiddenFromDefaultSidebar: true,
      }),
    );

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Stop this goal",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_goal_control",
    );
    expect((completed?.data as any)?.result).toMatchObject({
      action: "stop",
      status: "cancelled",
      nextStep: expect.stringContaining("1 linked subagent was cancelled."),
    });
    expect(completed?.output).toContain("1 linked child session was archived.");
    expect(harness.runs.find((candidate) => candidate.id === "run_active_goal_child")).toMatchObject({
      status: "cancelled",
      error: "Parent goal goal_1 stopped.",
      metadata: {
        goalLifecycle: {
          action: "cancelled_by_parent_goal",
          workspaceCleanup: {
            status: "skipped",
          },
        },
        childSessionArchive: {
          status: "archived",
          sessionId: "session_child_active",
          policy: "goal_stopped",
        },
      },
    });
    expect(harness.sessions.get("session_child_active")).toMatchObject({
      archived: true,
      metadata: {
        subagentArchive: {
          status: "archived",
          policy: "goal_stopped",
          runId: "run_active_goal_child",
        },
      },
    });
    expect(harness.events.some((event) => event.name === "subagent.cancelled" && (event.data as any)?.run?.id === "run_active_goal_child")).toBe(true);
    expect(harness.events.some((event) => event.name === "subagent.archived" && (event.data as any)?.run?.id === "run_active_goal_child")).toBe(true);
    const latestThreadGoal = harness.events.filter(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
    ).at(-1);
    expect((latestThreadGoal?.data as any)?.goal).toMatchObject({
      id: "goal_1",
      status: "cancelled",
      controlAction: "stop",
      subagents: {
        totalCount: 1,
        requiredCount: 1,
        activeCount: 0,
        acceptedCount: 0,
        blockingCount: 0,
        terminalCount: 1,
        cleanupNeededCount: 0,
        archivedCount: 1,
        requiredBlockingCount: 0,
        requiredArchivedCount: 1,
        requiredUnresolvedCount: 0,
        runs: [
          expect.objectContaining({
            id: "run_active_goal_child",
            status: "cancelled",
            required: true,
            cleanupStatus: "skipped",
            archiveStatus: "archived",
            sessionArchived: true,
          }),
        ],
      },
    });
  });
});
