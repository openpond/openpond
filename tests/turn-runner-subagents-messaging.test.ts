import { describe, expect, test } from "bun:test";
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

describe("turn runner subagent messaging and policy tools", () => {
  test("rejects child sessions that try to start another subagent", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Nested research should not start",
      },
      preferences: preferences(),
      initialRuns: [
        SubagentRunSchema.parse({
          id: "run_parent_child",
          parentSessionId: "session_1",
          parentTurnId: "turn_parent",
          parentGoalId: "goal_1",
          childSessionId: "session_child",
          roleId: "coding",
          objective: "Existing coding child",
          modelRef: { providerId: "openrouter", modelId: "test/model" },
          isolationMode: "copy_on_write",
          toolPolicy: "workspace_write",
          background: true,
          peerMessages: "goal_scoped",
          status: "needs_resume",
          required: true,
          createdAt: "2026-07-07T10:00:00.000Z",
        }),
      ],
    });
    harness.sessions.set(
      "session_child",
      baseSession({
        id: "session_child",
        parentSessionId: "session_1",
        parentTurnId: "turn_parent",
        parentGoalId: "goal_1",
        subagentRunId: "run_parent_child",
        subagentRoleId: "coding",
        hiddenFromDefaultSidebar: true,
      }),
    );

    const turn = await harness.runner.sendTurn("session_child", {
      prompt: "Try to fan out from a child",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.runs).toHaveLength(1);
    expect([...harness.sessions.values()].filter((session) => session.parentSessionId === "session_child")).toHaveLength(0);
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_subagent_start",
    );
    expect(completed).toMatchObject({ status: "failed" });
    expect(completed?.output).toContain("Child subagents cannot start additional subagents in this version.");
  });

  test("rejects child attempts to accept their own submitted work", async () => {
    const submittedRun = SubagentRunSchema.parse({
      id: "run_child_self_review",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_self_review",
      roleId: "coding",
      objective: "Fix notification behavior",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "workspace_write",
      background: true,
      peerMessages: "goal_scoped",
      status: "submitted_for_review",
      required: true,
      review: {
        status: "submitted_for_review",
      },
      report: {
        summary: "I think this is done.",
        followUpNeeded: true,
      },
      createdAt: "2026-07-07T10:00:00.000Z",
      completedAt: null,
    });
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_review",
      toolArgs: {
        runId: "run_child_self_review",
        decision: "accept",
        summary: "Child tried to self-accept.",
      },
      preferences: preferences(),
      initialRuns: [submittedRun],
      initialEvents: [activeGoalEvent()],
    });
    harness.sessions.set(
      "session_child_self_review",
      baseSession({
        id: "session_child_self_review",
        parentSessionId: "session_1",
        parentTurnId: "turn_prior",
        parentGoalId: "goal_1",
        subagentRunId: "run_child_self_review",
        subagentRoleId: "coding",
        hiddenFromDefaultSidebar: true,
      }),
    );

    const turn = await harness.runner.sendTurn("session_child_self_review", {
      prompt: "Accept my own submitted work",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.runs.find((candidate) => candidate.id === "run_child_self_review")).toMatchObject({
      status: "submitted_for_review",
      review: {
        status: "submitted_for_review",
      },
    });
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_subagent_review",
    );
    expect(completed).toMatchObject({ status: "failed" });
    expect(completed?.output).toContain("Child subagents cannot review their own submission.");
    expect(harness.events.some((event) => event.name === "subagent.accepted")).toBe(false);
  });

  test("delivers subagent mailbox messages to matching child sessions", async () => {
    const reviewRun = SubagentRunSchema.parse({
      id: "run_review",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_review",
      roleId: "review",
      objective: "Review the patch",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "running",
      required: true,
      createdAt: "2026-07-07T10:00:00.000Z",
      startedAt: "2026-07-07T10:00:01.000Z",
    });
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_send_message",
      toolArgs: {
        toRole: "review",
        kind: "question",
        body: "Can you check the patch boundary?",
      },
      preferences: preferences(),
      initialRuns: [reviewRun],
      initialEvents: [activeGoalEvent()],
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Ask review subagents a question",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]).toMatchObject({
      toRole: "review",
      kind: "question",
      body: "Can you check the patch boundary?",
      priority: "normal",
      delivery: {
        status: "delivered",
        deliveredRunIds: ["run_review"],
        acknowledgedRunIds: ["run_review"],
      },
    });
    expect(harness.events.find(
      (event) => event.sessionId === "session_child_review" && event.name === "subagent.message",
    )).toMatchObject({
      status: "pending",
      data: {
        deliveredToRunId: "run_review",
        acknowledgedRunId: "run_review",
        priority: "normal",
      },
    });
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_subagent_send_message",
    );
    expect((completed?.data as any)?.result).toMatchObject({
      delivery: {
        status: "delivered",
        deliveredRunIds: ["run_review"],
        acknowledgedRunIds: ["run_review"],
      },
      nextStep: "Message persisted, delivered, and acknowledged by 1 subagent run at the runtime boundary.",
    });
  });

  test("accepts submitted child work through a parent review decision without patch approval", async () => {
    const submittedRun = SubagentRunSchema.parse({
      id: "run_review_accept",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_accept",
      roleId: "research",
      objective: "Summarize notification behavior",
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
        summary: "Notifications are already suppressed when nothing changes.",
        followUpNeeded: true,
      },
      metadata: {
        workspaceHandoff: {
          status: "captured",
          changed: true,
          changedFiles: ["docs/notes.md"],
          applyResult: null,
        },
      },
      createdAt: "2026-07-07T10:00:00.000Z",
      completedAt: null,
    });
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_review",
      toolArgs: {
        runId: "run_review_accept",
        decision: "accept",
        summary: "Evidence is sufficient for synthesis.",
      },
      preferences: preferences(),
      initialRuns: [submittedRun],
      initialEvents: [activeGoalEvent()],
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Review the submitted child work",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const run = harness.runs.find((candidate) => candidate.id === "run_review_accept");
    expect(run).toMatchObject({
      status: "accepted",
      report: {
        followUpNeeded: false,
      },
      review: {
        status: "accepted",
        reviewerSessionId: "session_1",
        summary: "Evidence is sufficient for synthesis.",
      },
      progress: {
        latestMeaningfulActivity: "Parent/reviewer accepted the child review packet.",
      },
      metadata: {
        lifecycleCleanup: {
          reason: "accepted_review",
          policy: "auto_after_acceptance",
          workspaceCleanup: {
            status: "retained",
            reason: "Changed child workspace has not been applied; retain for inspection.",
            retainedAt: expect.any(String),
            retentionPolicy: {
              kind: "retain_for_inspection",
              retentionDays: 7,
              expiresAt: expect.any(String),
              cleanupAfterExpiry: true,
              trigger: "auto_after_acceptance",
            },
          },
        },
      },
    });
    expect(harness.events.find((event) => event.name === "subagent.accepted")).toMatchObject({
      status: "completed",
      data: {
        run: expect.objectContaining({
          id: "run_review_accept",
          status: "accepted",
        }),
      },
    });
    expect(harness.events.find((event) => event.name === "subagent.workspace_retained")).toMatchObject({
      status: "completed",
      data: {
        run: expect.objectContaining({
          id: "run_review_accept",
          metadata: expect.objectContaining({
            lifecycleCleanup: expect.objectContaining({
              workspaceCleanup: expect.objectContaining({
                status: "retained",
                retentionPolicy: expect.objectContaining({
                  retentionDays: 7,
                  cleanupAfterExpiry: true,
                  trigger: "auto_after_acceptance",
                }),
              }),
            }),
          }),
        }),
      },
    });
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_subagent_review",
    );
    expect((completed?.data as any)?.result).toMatchObject({
      runId: "run_review_accept",
      status: "accepted",
      nextStep: "Subagent accepted; use its report and child conversation as evidence.",
    });
  });

  test("runs explicit subagent cleanup and archive lifecycle actions", async () => {
    const acceptedRun = SubagentRunSchema.parse({
      id: "run_manual_lifecycle",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_manual_lifecycle",
      roleId: "coding",
      objective: "Keep child lifecycle manageable",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "workspace_write",
      background: true,
      peerMessages: "goal_scoped",
      status: "accepted",
      required: true,
      review: {
        status: "accepted",
      },
      report: {
        summary: "Manual lifecycle action target.",
        followUpNeeded: false,
      },
      metadata: {
        workspaceHandoff: {
          status: "captured",
          changed: true,
          changedFiles: ["src/child.ts"],
          applyResult: null,
        },
      },
      createdAt: "2026-07-07T10:00:00.000Z",
      completedAt: "2026-07-07T10:01:00.000Z",
    });
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {},
      preferences: preferences(),
      initialRuns: [acceptedRun],
      disableDefaultToolCall: true,
    });
    harness.sessions.set(
      "session_child_manual_lifecycle",
      baseSession({
        id: "session_child_manual_lifecycle",
        parentSessionId: "session_1",
        parentTurnId: "turn_prior",
        parentGoalId: "goal_1",
        subagentRunId: "run_manual_lifecycle",
        subagentRoleId: "coding",
        status: "idle",
      }),
    );

    const result = await harness.runner.runSubagentLifecycleAction("run_manual_lifecycle", {
      action: "cleanup_and_archive",
      reason: "Manual cleanup/archive test.",
    });

    expect(result).toMatchObject({
      action: "cleanup_and_archive",
      workspaceCleanup: {
        status: "retained",
        retentionPolicy: {
          kind: "retain_for_inspection",
          retentionDays: 7,
          expiresAt: expect.any(String),
          cleanupAfterExpiry: true,
          trigger: "manual_cleanup",
        },
      },
      sessionArchive: {
        status: "archived",
        sessionId: "session_child_manual_lifecycle",
        evidenceRetention: {
          kind: "retain_with_parent",
          messageRetentionDays: null,
          artifactRetentionDays: null,
          cleanupAfterExpiry: false,
        },
      },
      run: {
        evidenceRetention: {
          kind: "retain_with_parent",
          messageRetentionDays: null,
          artifactRetentionDays: null,
          cleanupAfterExpiry: false,
        },
        metadata: {
          lifecycleCleanup: {
            policy: "manual_cleanup",
            evidenceRetention: {
              kind: "retain_with_parent",
              messageRetentionDays: null,
              artifactRetentionDays: null,
              cleanupAfterExpiry: false,
            },
            workspaceCleanup: {
              status: "retained",
              retentionPolicy: {
                kind: "retain_for_inspection",
                retentionDays: 7,
                expiresAt: expect.any(String),
                cleanupAfterExpiry: true,
                trigger: "manual_cleanup",
              },
            },
          },
          childSessionArchive: {
            policy: "manual_archive",
            status: "archived",
            evidenceRetention: {
              kind: "retain_with_parent",
              messageRetentionDays: null,
              artifactRetentionDays: null,
              cleanupAfterExpiry: false,
            },
          },
        },
      },
    });
    expect(harness.sessions.get("session_child_manual_lifecycle")).toMatchObject({
      archived: true,
      hiddenFromDefaultSidebar: true,
      metadata: {
        subagentArchive: {
          evidenceRetention: {
            kind: "retain_with_parent",
            messageRetentionDays: null,
            artifactRetentionDays: null,
            cleanupAfterExpiry: false,
          },
        },
      },
    });
    expect(harness.events.some((event) => event.name === "subagent.cleanup" && event.status === "completed")).toBe(true);
    expect(harness.events.some((event) => event.name === "subagent.workspace_retained")).toBe(true);
    expect(harness.events.some((event) => event.name === "subagent.archived" && event.status === "completed")).toBe(true);
  });

  test("cleans expired retained subagent workspaces instead of retaining them again", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-subagent-retention-expired-test-"));
    try {
      const workspaceRoot = path.join(tempRoot, "child-worktree");
      await mkdir(workspaceRoot, { recursive: true });
      await writeFile(path.join(workspaceRoot, "marker.txt"), "retained work\n", "utf8");
      const retainedWorkspaceCleanup = {
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
      };
      const retainedRun = SubagentRunSchema.parse({
        id: "run_expired_retained_cleanup",
        parentSessionId: "session_1",
        parentTurnId: "turn_prior",
        parentGoalId: "goal_1",
        childSessionId: "session_child_expired_retained",
        roleId: "coding",
        objective: "Clean expired retained workspace",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
        isolationMode: "copy_on_write",
        toolPolicy: "workspace_write",
        background: true,
        peerMessages: "goal_scoped",
        status: "accepted",
        required: true,
        review: {
          status: "accepted",
        },
        report: {
          summary: "Accepted work retained for inspection.",
          followUpNeeded: false,
        },
        metadata: {
          subagentWorkspace: {
            implementation: "git_worktree",
            workspaceRoot,
          },
          lifecycleCleanup: {
            reason: "accepted_review",
            policy: "auto_after_acceptance",
            workspaceCleanup: retainedWorkspaceCleanup,
          },
        },
        createdAt: "2026-07-01T09:59:00.000Z",
        completedAt: "2026-07-01T10:00:00.000Z",
      });
      const harness = createSubagentHarness({
        toolName: "openpond_subagent_start",
        toolArgs: {},
        preferences: preferences(),
        initialRuns: [retainedRun],
        disableDefaultToolCall: true,
      });

      const result = await harness.runner.cleanupExpiredRetainedSubagentWorkspace("run_expired_retained_cleanup", {
        checkedAt: "2026-07-09T12:00:00.000Z",
        reason: "Retained workspace expiry test.",
      });

      expect(result).toMatchObject({
        action: "cleanup",
        workspaceCleanup: {
          status: "removed",
          workspaceRoot,
        },
        run: {
          metadata: {
            lifecycleCleanup: {
              reason: "Retained workspace expiry test.",
              policy: "retention_expired",
              previousWorkspaceCleanup: retainedWorkspaceCleanup,
              workspaceCleanup: {
                status: "removed",
                workspaceRoot,
              },
            },
          },
        },
      });
      await expect(readFile(path.join(workspaceRoot, "marker.txt"), "utf8")).rejects.toThrow();
      expect(
        harness.events.some(
          (event) => event.name === "subagent.cleanup" && event.status === "completed" &&
            (event.data as any)?.run?.metadata?.lifecycleCleanup?.policy === "retention_expired",
        ),
      ).toBe(true);
      expect(
        harness.events.some(
          (event) => event.name === "subagent.workspace_retained" &&
            (event.data as any)?.run?.id === "run_expired_retained_cleanup",
        ),
      ).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("marks submitted child work needs revision and routes corrections back to the child", async () => {
    const submittedRun = SubagentRunSchema.parse({
      id: "run_review_revision",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_revision",
      roleId: "coding",
      objective: "Fix notification behavior",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "workspace_write",
      background: true,
      peerMessages: "goal_scoped",
      status: "submitted_for_review",
      required: true,
      review: {
        status: "submitted_for_review",
      },
      report: {
        summary: "Implemented suppression.",
        followUpNeeded: true,
      },
      createdAt: "2026-07-07T10:00:00.000Z",
      completedAt: null,
    });
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_review",
      toolArgs: {
        runId: "run_review_revision",
        decision: "needs_revision",
        summary: "Implementation is close but validation is missing.",
        issues: ["No regression test covers the unchanged-insight case."],
        requiredCorrections: ["Add a focused regression for unchanged insights and rerun it."],
        priority: "interrupt",
      },
      preferences: preferences(),
      initialRuns: [submittedRun],
      initialEvents: [activeGoalEvent()],
      textBySessionId: {
        session_child_revision: ["Revision acknowledged."],
      },
    });
    harness.sessions.set(
      "session_child_revision",
      baseSession({
        id: "session_child_revision",
        parentSessionId: "session_1",
        parentTurnId: "turn_prior",
        parentGoalId: "goal_1",
        subagentRunId: "run_review_revision",
        subagentRoleId: "coding",
        hiddenFromDefaultSidebar: true,
      }),
    );

    await harness.runner.sendTurn("session_1", {
      prompt: "Review the submitted coding child",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    const run = harness.runs.find((candidate) => candidate.id === "run_review_revision");
    expect(run).toMatchObject({
      status: "needs_revision",
      review: {
        status: "needs_revision",
        reviewerSessionId: "session_1",
        summary: "Implementation is close but validation is missing.",
        issues: ["No regression test covers the unchanged-insight case."],
        requiredCorrections: ["Add a focused regression for unchanged insights and rerun it."],
        humanReviewRecommended: true,
      },
      report: {
        followUpNeeded: true,
      },
    });
    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]).toMatchObject({
      fromRunId: "parent:session_1",
      toRunId: "run_review_revision",
      toRole: "coding",
      kind: "status",
      priority: "interrupt",
      delivery: {
        status: "delivered",
        deliveredRunIds: ["run_review_revision"],
        acknowledgedRunIds: ["run_review_revision"],
        wakeRequestedRunIds: ["run_review_revision"],
        wakeDeferredRunIds: ["run_review_revision"],
      },
    });
    expect(harness.messages[0]?.body).toContain("Add a focused regression for unchanged insights and rerun it.");
    expect(harness.events.find(
      (event) => event.sessionId === "session_child_revision" && event.name === "subagent.message",
    )).toMatchObject({
      output: "Interrupt subagent message received: status.",
      data: {
        deliveredToRunId: "run_review_revision",
        priority: "interrupt",
      },
    });
    await harness.runner.sendTurn("session_child_revision", {
      prompt: "Continue after parent review",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    expect(JSON.stringify(harness.streamInputs)).toContain(
      "Add a focused regression for unchanged insights and rerun it.",
    );
    expect(harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_subagent_review",
    )).toMatchObject({
      status: "completed",
      data: {
        result: expect.objectContaining({
          runId: "run_review_revision",
          status: "needs_revision",
        }),
      },
    });
  });

  test("delivers child subagent messages back to the parent chat", async () => {
    const researchRun = SubagentRunSchema.parse({
      id: "run_research",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_research",
      roleId: "research",
      objective: "Research the patch",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "running",
      required: true,
      createdAt: "2026-07-07T10:00:00.000Z",
      startedAt: "2026-07-07T10:00:01.000Z",
    });
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_send_message",
      toolArgs: {
        kind: "status",
        body: "Child status ping for the parent chat.",
      },
      preferences: preferences(),
      initialRuns: [researchRun],
      initialEvents: [activeGoalEvent()],
    });
    harness.sessions.set(
      "session_child_research",
      baseSession({
        id: "session_child_research",
        parentSessionId: "session_1",
        parentTurnId: "turn_prior",
        parentGoalId: "goal_1",
        subagentRunId: "run_research",
        subagentRoleId: "research",
      }),
    );

    const turn = await harness.runner.sendTurn("session_child_research", {
      prompt: "Send a status ping to the parent chat",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]).toMatchObject({
      fromRunId: "run_research",
      toRunId: null,
      toRole: null,
      kind: "status",
      body: "Child status ping for the parent chat.",
      delivery: {
        status: "delivered",
        deliveredRunIds: [],
        acknowledgedRunIds: [],
        deliveredParentSessionId: "session_1",
        acknowledgedParentSessionId: "session_1",
        wakeRequestedParentSessionId: "session_1",
        wakeQueuedParentSessionId: "session_1",
        wakeParentReason: "parent_wake_queued",
      },
    });
    expect(harness.events.find(
      (event) => event.sessionId === "session_1" && event.name === "subagent.message",
    )).toMatchObject({
      status: "completed",
      output: "Subagent run_research sent status.",
      data: {
        delivery: {
          status: "delivered",
          deliveredParentSessionId: "session_1",
          acknowledgedParentSessionId: "session_1",
          wakeQueuedParentSessionId: "session_1",
        },
      },
    });
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_subagent_send_message",
    );
    expect((completed?.data as any)?.result).toMatchObject({
      delivery: {
        status: "delivered",
        deliveredParentSessionId: "session_1",
        acknowledgedParentSessionId: "session_1",
        wakeQueuedParentSessionId: "session_1",
      },
      nextStep: "Message persisted, delivered to the parent chat at the runtime boundary. Main agent wake queued for this parent handoff.",
    });
    await harness.turnFollowUpQueue.drain();
    const wakeTurn = harness.turns.find(
      (candidate) => candidate.sessionId === "session_1" && (candidate.metadata as any)?.subagentParentWake?.messageId === harness.messages[0]?.id,
    );
    expect(wakeTurn).toMatchObject({
      sessionId: "session_1",
      status: "completed",
      metadata: {
        subagentParentWake: {
          fromRunId: "run_research",
          childSessionId: "session_child_research",
          childRoleId: "research",
          kind: "status",
        },
      },
    });
    const wakeInput = harness.streamInputs.find((input) => input.requestId === wakeTurn?.id);
    expect(JSON.stringify(wakeInput)).toContain("A research subagent sent a status handoff to this main chat.");
    expect(JSON.stringify(wakeInput)).toContain("Child status ping for the parent chat.");
  });

  test("defers repeated child-to-parent handoff wakes at the loop limit", async () => {
    const priorWakeTurns = Array.from({ length: 4 }, (_item, index) =>
      turnFixture({
        id: `turn_parent_wake_${index}`,
        sessionId: "session_1",
        prompt: `Prior parent wake ${index}`,
        metadata: {
          subagentParentWake: {
            messageId: `message_prior_${index}`,
            fromRunId: "run_research",
            childSessionId: "session_child_research",
            childRoleId: "research",
            kind: "handoff",
          },
        },
      }),
    );
    const researchRun = SubagentRunSchema.parse({
      id: "run_research",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_research",
      roleId: "research",
      objective: "Research the patch",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "running",
      required: true,
      createdAt: "2026-07-07T10:00:00.000Z",
      startedAt: "2026-07-07T10:00:01.000Z",
    });
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_send_message",
      toolArgs: {
        kind: "handoff",
        body: "This should be delivered but should not wake the parent again.",
      },
      preferences: preferences(),
      initialTurns: priorWakeTurns,
      initialRuns: [researchRun],
      initialEvents: [activeGoalEvent()],
    });
    harness.sessions.set(
      "session_child_research",
      baseSession({
        id: "session_child_research",
        parentSessionId: "session_1",
        parentTurnId: "turn_prior",
        parentGoalId: "goal_1",
        subagentRunId: "run_research",
        subagentRoleId: "research",
      }),
    );

    const turn = await harness.runner.sendTurn("session_child_research", {
      prompt: "Send another parent handoff",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.turnFollowUpQueue.drain();

    expect(turn.status).toBe("completed");
    expect(harness.messages[0]).toMatchObject({
      delivery: {
        status: "delivered",
        deliveredParentSessionId: "session_1",
        wakeRequestedParentSessionId: "session_1",
        wakeDeferredParentSessionId: "session_1",
        wakeParentReason: "parent_wake_loop_limit:4",
      },
    });
    const parentWakeTurns = harness.turns.filter(
      (candidate) => candidate.sessionId === "session_1" && (candidate.metadata as any)?.subagentParentWake?.fromRunId === "run_research",
    );
    expect(parentWakeTurns).toHaveLength(4);
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_subagent_send_message",
    );
    expect((completed?.data as any)?.result.nextStep).toContain("Main agent wake deferred (parent_wake_loop_limit:4).");
  });

  test("pushes subagent progress and completion receipts into the active parent model context", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Check whether the child result is pushed without polling",
      },
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      textBySessionId: {
        "role:research": ["Child result pushed without parent polling."],
      },
      onStreamInput: async (_streamInput, context) => {
        if (context.requestSession?.id !== "session_1" || context.streamPass < 2 || context.injectedFlags.parentCompletion) {
          return;
        }
        const run = context.runs.find((candidate) => candidate.parentSessionId === "session_1" && candidate.roleId === "research");
        if (!run) return;
        const completed = SubagentRunSchema.parse({
          ...run,
          status: "completed",
          completedAt: "2026-07-07T10:00:03.000Z",
          report: {
            summary: "Child result pushed without parent polling.",
            blockers: [],
            followUpNeeded: false,
          },
        });
        const index = context.runs.findIndex((candidate) => candidate.id === run.id);
        if (index >= 0) context.runs[index] = completed;
        context.events.push({
          id: "subagent_completed_during_parent_turn",
          name: "subagent.completed",
          timestamp: "2026-07-07T10:00:03.000Z",
          sessionId: "session_1",
          turnId: run.parentTurnId ?? context.requestTurn?.id,
          status: "completed",
          output: "research subagent completed.",
          data: {
            run: completed,
            childSessionId: completed.childSessionId,
            parentGoalId: completed.parentGoalId,
          },
        });
        context.injectedFlags.parentCompletion = true;
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a research subagent and continue when it reports back",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.subagentQueue.drain();

    expect(turn.status).toBe("completed");
    expect(harness.events.some((event) => event.name === "subagent.progress" && event.sessionId === "session_1")).toBe(true);
    expect(harness.events.some((event) => event.name === "subagent.completed" && event.sessionId === "session_1")).toBe(true);

    const parentInputs = harness.streamInputs.filter((input) => input.requestId === turn.id);
    expect(JSON.stringify(parentInputs)).toContain("Subagent update:");
    expect(JSON.stringify(parentInputs)).toContain("event: subagent.completed");
    expect(JSON.stringify(parentInputs)).toContain("Child result pushed without parent polling.");
  });

  test("injects child-to-parent handoffs into an active parent model context", async () => {
    let injectedHandoff = false;
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_status",
      toolArgs: {},
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      onStreamInput: async (_streamInput, context) => {
        if (context.requestSession?.id !== "session_1" || injectedHandoff) return;
        injectedHandoff = true;
        const message = SubagentMessageSchema.parse({
          id: "message_child_handoff",
          parentGoalId: "goal_1",
          fromRunId: "run_research",
          toRunId: null,
          toRole: null,
          kind: "handoff",
          priority: "normal",
          body: "Research found a blocker that the main agent should handle now.",
          refs: [],
          delivery: {
            status: "delivered",
            deliveredRunIds: [],
            acknowledgedRunIds: [],
            deliveredParentSessionId: "session_1",
            acknowledgedParentSessionId: "session_1",
            wakeRequestedParentSessionId: "session_1",
            wakeDeferredParentSessionId: "session_1",
            wakeParentReason: "parent_turn_active",
          },
          createdAt: "2026-07-07T10:00:01.000Z",
        });
        context.events.push({
          id: "event_child_handoff",
          sessionId: "session_1",
          turnId: context.requestTurn?.id ?? "turn_parent",
          name: "subagent.message",
          timestamp: "2026-07-07T10:00:01.000Z",
          source: "server",
          status: "completed",
          output: "Subagent run_research sent handoff.",
          data: {
            message,
            delivery: message.delivery,
            deliveredRunIds: [],
          },
        });
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Check subagent status and react to handoffs",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const parentInputs = harness.streamInputs.filter((input) => input.requestId === turn.id);
    expect(JSON.stringify(parentInputs)).toContain("Subagent handoff:");
    expect(JSON.stringify(parentInputs)).toContain("Research found a blocker that the main agent should handle now.");
    const parentWakeTurns = harness.turns.filter(
      (candidate) => candidate.sessionId === "session_1" && (candidate.metadata as any)?.subagentParentWake,
    );
    expect(parentWakeTurns).toHaveLength(0);
  });

  test("injects interrupt-priority subagent messages into the child model context at the next boundary", async () => {
    const reviewRun = SubagentRunSchema.parse({
      id: "run_review",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_review",
      roleId: "review",
      objective: "Review the patch",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "running",
      required: true,
      createdAt: "2026-07-07T10:00:00.000Z",
      startedAt: "2026-07-07T10:00:01.000Z",
    });
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_send_message",
      toolArgs: {
        toRunId: "run_review",
        kind: "status",
        priority: "interrupt",
        body: "Stop reviewing the old file; focus on the new diff only.",
      },
      preferences: preferences(),
      initialRuns: [reviewRun],
      initialEvents: [activeGoalEvent()],
      textBySessionId: {
        session_child_review: ["Review child acknowledged the interrupt."],
      },
    });
    harness.sessions.set(
      "session_child_review",
      baseSession({
        id: "session_child_review",
        parentSessionId: "session_1",
        parentTurnId: "turn_prior",
        parentGoalId: "goal_1",
        subagentRunId: "run_review",
        subagentRoleId: "review",
      }),
    );

    const parentTurn = await harness.runner.sendTurn("session_1", {
      prompt: "Steer the review child",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    const childTurn = await harness.runner.sendTurn("session_child_review", {
      prompt: "Continue review",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(parentTurn.status).toBe("completed");
    expect(childTurn.status).toBe("completed");
    expect(harness.messages[0]).toMatchObject({
      priority: "interrupt",
      delivery: {
        status: "delivered",
        deliveredRunIds: ["run_review"],
        acknowledgedRunIds: ["run_review"],
      },
    });
    const childInputs = harness.streamInputs.filter((input) => input.requestId === childTurn.id);
    expect(JSON.stringify(childInputs)).toContain("Subagent mailbox interrupt:");
    expect(JSON.stringify(childInputs)).toContain("Stop reviewing the old file; focus on the new diff only.");
    expect(JSON.stringify(childInputs)).toContain("Treat this as high-priority steering at this safe model boundary.");
  });

  test("wakes a long-running child turn for interrupt-priority steering and resumes with mailbox context", async () => {
    let sendStartTool = true;
    let parentStartReturned = false;
    let sendInterruptTool = true;
    let childStreamStarted = false;
    let resolveChildStreamStarted: (() => void) | null = null;
    let resolveChildAbort: (() => void) | null = null;
    const childStreamStartedPromise = new Promise<void>((resolve) => {
      resolveChildStreamStarted = resolve;
    });
    const childAbortPromise = new Promise<void>((resolve) => {
      resolveChildAbort = resolve;
    });
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {},
      disableDefaultToolCall: true,
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      textBySessionId: {
        "role:review": [
          "This review response should be interrupted before it lands.",
          "Review resumed after interrupt steering.",
        ],
      },
      toolCallForStream: (_streamInput, context) => {
        if (context.requestSession?.id !== "session_1") return null;
        if (sendStartTool) {
          sendStartTool = false;
          return {
            name: "openpond_subagent_start",
            args: {
              roleId: "review",
              objective: "Review the patch slowly before reporting",
              required: true,
            },
          };
        }
        if (!parentStartReturned || !childStreamStarted || !sendInterruptTool) return null;
        const run = context.runs.find((candidate) => candidate.roleId === "review");
        if (!run) return null;
        sendInterruptTool = false;
        return {
          name: "openpond_subagent_send_message",
          args: {
            toRunId: run.id,
            kind: "status",
            priority: "interrupt",
            body: "Stop waiting; report the narrowed review scope now.",
          },
        };
      },
      onStreamInput: async (streamInput, context) => {
        if (context.requestSession?.subagentRoleId !== "review" || context.injectedFlags.reviewWaitStarted) return;
        context.injectedFlags.reviewWaitStarted = true;
        childStreamStarted = true;
        resolveChildStreamStarted?.();
        await new Promise<void>((resolve) => {
          const signal: AbortSignal | undefined = streamInput.signal;
          if (!signal) {
            resolve();
            return;
          }
          if (signal.aborted) {
            resolveChildAbort?.();
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              resolveChildAbort?.();
              resolve();
            },
            { once: true },
          );
        });
      },
    });

    const startTurn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a slow review subagent",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    parentStartReturned = true;
    await withTimeout(childStreamStartedPromise, "child stream did not start");

    const messageTurn = await harness.runner.sendTurn("session_1", {
      prompt: "Interrupt the review child with new scope",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await withTimeout(childAbortPromise, "child stream was not interrupted");
    await harness.subagentQueue.drain();

    const run = harness.runs.find((candidate) => candidate.roleId === "review");
    const childSession = [...harness.sessions.values()].find((session) => session.subagentRunId === run?.id);
    expect(run).toBeTruthy();
    expect(childSession).toBeTruthy();
    const runId = run?.id ?? "missing-run";
    const childSessionId = childSession?.id ?? "missing-child-session";
    expect(startTurn.status).toBe("completed");
    expect(messageTurn.status).toBe("completed");
    expect(run).toMatchObject({
      status: "submitted_for_review",
      review: {
        status: "submitted_for_review",
      },
      report: {
        summary: "Review resumed after interrupt steering.",
      },
    });
    expect((run?.metadata as any)?.interruptWake).toMatchObject({
      status: "resuming",
      resumeCount: 1,
    });
    const interruptedChildTurns = harness.turns.filter(
      (turn) => turn.sessionId === childSessionId && turn.status === "interrupted",
    );
    const completedChildTurns = harness.turns.filter(
      (turn) => turn.sessionId === childSessionId && turn.status === "completed",
    );
    expect(interruptedChildTurns).toHaveLength(1);
    expect(completedChildTurns).toHaveLength(1);
    expect(harness.messages[0]).toMatchObject({
      priority: "interrupt",
      delivery: {
        status: "delivered",
        deliveredRunIds: [runId],
        acknowledgedRunIds: [runId],
      },
    });
    const messageResult = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_subagent_send_message",
    );
    expect((messageResult?.data as any)?.result.delivery).toMatchObject({
      wakeRequestedRunIds: [runId],
      wakeInterruptedRunIds: [runId],
      wakeDeferredRunIds: [],
    });
    expect((messageResult?.data as any)?.result.nextStep).toContain("Woke 1 active child turn");
    const resumedInput = harness.streamInputs.find((input) => input.requestId === completedChildTurns[0]?.id);
    expect(JSON.stringify(resumedInput)).toContain("Subagent mailbox interrupt:");
    expect(JSON.stringify(resumedInput)).toContain("Stop waiting; report the narrowed review scope now.");
  });

  test("inherits parent approval policy while clamping read-only child sandbox", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Inspect the API boundary without changing files",
      },
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a research subagent",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      codexPermissionMode: "full-access",
    });
    await harness.subagentQueue.drain();

    expect(turn.status).toBe("completed");
    const run = harness.runs.find((candidate) => candidate.roleId === "research");
    expect(run).toMatchObject({
      status: "submitted_for_review",
      review: {
        status: "submitted_for_review",
      },
      metadata: {
        childTurnPermissions: {
          approvalPolicy: "never",
          sandbox: "read-only",
          codexPermissionMode: "full-access",
        },
      },
    });
    const childTurn = harness.turns.find((candidate) => candidate.sessionId !== "session_1");
    expect(childTurn?.metadata).toMatchObject({
      subagentPermissions: {
        approvalPolicy: "never",
        sandbox: "read-only",
        codexPermissionMode: "full-access",
      },
    });
  });

  test("attributes child model usage to the subagent run and active parent goal", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Inspect the API boundary without changing files",
      },
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      usageBySessionId: {
        session_2: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a research subagent",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.subagentQueue.drain();

    expect(turn.status).toBe("completed");
    const run = harness.runs.find((candidate) => candidate.roleId === "research");
    expect(run?.status).toBe("submitted_for_review");
    expect(run?.review.status).toBe("submitted_for_review");
    expect(run?.metadata).toMatchObject({
      usage: {
        totalTokens: 84,
        promptTokens: 60,
        completionTokens: 24,
        requestCount: 2,
      },
    });
    const usage = harness.usageRecords.find(
      (record) => record.status === "completed" && record.attribution.subagentRunId === run?.id,
    );
    expect(usage).toMatchObject({
      sessionId: "session_2",
      provider: "openrouter",
      model: "test/model",
      requestKind: "subagent",
      visibility: "background",
      totalTokens: 42,
      attribution: {
        surface: "goal",
        workflowKind: "subagent",
        goalId: "goal_1",
        subagentRunId: run?.id,
        subagentRoleId: "research",
      },
    });
  });

  test("blocks mutating hosted workspace tools for read-only child subagents", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Inspect the docs without changing files",
      },
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      textBySessionId: {
        session_2: [
          [
            "```openpond_tool",
            JSON.stringify({ action: "write_file", args: { path: "notes.md", content: "mutate" } }),
            "```",
          ].join("\n"),
          "Read-only report complete.",
        ],
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a read-only research subagent",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.subagentQueue.drain();

    expect(turn.status).toBe("completed");
    expect(harness.workspaceRequests).toEqual([]);
    const childSession = harness.sessions.get("session_2");
    expect(childSession?.metadata).toMatchObject({
      subagent: {
        toolPolicy: "read_only",
        requestedIsolationMode: "copy_on_write",
        effectiveIsolationMode: "none",
      },
    });
    expect(harness.runs[0]).toMatchObject({
      roleId: "research",
      status: "submitted_for_review",
      review: {
        status: "submitted_for_review",
      },
    });
    expect(JSON.stringify(harness.streamInputs)).toContain(
      "Workspace action write_file is blocked by the read_only subagent tool policy",
    );
  });

  test("rejects new subagents when persisted role token budget is exhausted", async () => {
    const spentRun = SubagentRunSchema.parse({
      id: "run_spent",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_spent",
      roleId: "research",
      objective: "Existing research",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "completed",
      required: true,
      createdAt: "2026-07-07T09:00:00.000Z",
      startedAt: "2026-07-07T09:00:01.000Z",
      completedAt: "2026-07-07T09:00:10.000Z",
    });
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Do more research",
      },
      preferences: preferences({
        subagents: {
          roles: [
            {
              id: "research",
              maxTokens: 40,
            },
          ],
        },
      }),
      initialRuns: [spentRun],
      initialUsageRecords: [
        usageRecord({
          requestId: "usage_spent",
          sessionId: "session_child_spent",
          turnId: "turn_child_spent",
          requestKind: "subagent",
          visibility: "background",
          totalTokens: 40,
          attribution: {
            surface: "goal",
            workflowKind: "subagent",
            sessionId: "session_child_spent",
            turnId: "turn_child_spent",
            goalId: "goal_1",
            subagentRunId: "run_spent",
            subagentRoleId: "research",
          },
        }),
      ],
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start more research",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.runs).toHaveLength(1);
    expect([...harness.sessions.values()].filter((session) => session.parentSessionId === "session_1")).toHaveLength(0);
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_subagent_start",
    );
    expect(completed).toMatchObject({ status: "failed" });
    expect(completed?.output).toContain("Subagent role research token budget reached: 40/40 tokens used.");
  });

});
