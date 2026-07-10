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

describe("turn runner subagent workspace and execution tools", () => {
  test("injects the resolved delegation mode into parent turns and records its source", async () => {
    const configuredPreferences = preferences();
    configuredPreferences.subagents.delegationMode = "proactive";
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_status",
      toolArgs: {},
      preferences: configuredPreferences,
      sessionOverrides: { subagentDelegationMode: "manual" },
      disableDefaultToolCall: true,
      textBySessionId: { session_1: ["Handled without delegation."] },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Handle this directly",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.metadata.subagentDelegation).toEqual({
      mode: "manual",
      source: "session_override",
    });
    expect(JSON.stringify(harness.streamInputs[0])).toContain("Subagent delegation mode: manual.");
    expect(JSON.stringify(harness.streamInputs[0])).toContain(
      "Start subagents only when the user explicitly requests delegation.",
    );
  });

  test("passes the enabled role catalog into the native subagent tool", async () => {
    const configuredPreferences = preferences();
    configuredPreferences.subagents.roles = configuredPreferences.subagents.roles.map((role) => ({
      ...role,
      enabled: role.id === "coding" || role.id === "review",
    }));
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_status",
      toolArgs: {},
      preferences: configuredPreferences,
      disableDefaultToolCall: true,
      textBySessionId: { session_1: ["Role catalog inspected."] },
    });

    await harness.runner.sendTurn("session_1", {
      prompt: "Inspect available child roles",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    const startTool = harness.streamInputs[0].tools.find(
      (tool: any) => tool.function.name === "openpond_subagent_start",
    );
    expect(startTool.function.parameters.properties.roleId.enum).toEqual(["coding", "review"]);
    expect(startTool.function.parameters.properties.roleId.description).toContain(
      "coding: Make scoped code changes",
    );
  });

  test("prioritizes connected app instruction tools for prompt-only @x mentions", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "unused",
      },
      preferences: preferences(),
      disableDefaultToolCall: true,
      textBySessionId: {
        session_1: ["Connected app request handled."],
      },
      integrationConnections: [
        {
          id: "conn_x_social",
          provider: "x",
          providerAccountName: "0xglu",
          status: "active",
        },
      ],
      enableWebSearchTool: true,
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "@x find me the most recent 0xglu posts and summarize them",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const firstStream = harness.streamInputs[0];
    expect(firstStream.toolChoice).toEqual({
      type: "function",
      function: { name: "connected_app_skill_read" },
    });
    const toolNames = (firstStream.tools ?? []).map((tool: any) => tool.function?.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(["connected_app_skill_read", "connected_app_search", "connected_app_read"]),
    );
    expect(toolNames.indexOf("connected_app_skill_read")).toBeLessThan(toolNames.indexOf("web_search"));
    expect(toolNames).toContain("web_search");
  });

  test("starts a linked child conversation and blocks write-capable subagents without a git workspace", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "coding",
        objective: "Implement the search index change",
        required: true,
      },
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a coding subagent for this goal",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.streamInputs[0].tools.map((tool: any) => tool.function.name)).toContain("openpond_subagent_start");
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]).toMatchObject({
      parentSessionId: "session_1",
      parentGoalId: "goal_1",
      roleId: "coding",
      status: "blocked",
      required: true,
      report: {
        followUpNeeded: true,
      },
    });
    expect(harness.runs[0]?.error).toContain("copy_on_write isolation unavailable:");
    const childSession = [...harness.sessions.values()].find((session) => session.parentSessionId === "session_1");
    expect(childSession).toMatchObject({
      hiddenFromDefaultSidebar: true,
      parentGoalId: "goal_1",
      subagentRunId: harness.runs[0]?.id,
      subagentRoleId: "coding",
    });
    expect(harness.events.some((event) => event.name === "subagent.blocked" && event.sessionId === "session_1")).toBe(true);
    const blockedReceipt = harness.events.find(
      (event) => event.name === "subagent.blocked" && event.sessionId === "session_1",
    );
    expect((blockedReceipt?.data as any)?.childSession).toMatchObject({
      id: childSession?.id,
      parentSessionId: "session_1",
      subagentRunId: harness.runs[0]?.id,
      subagentRoleId: "coding",
    });
    expect((blockedReceipt?.data as any)?.childSession?.metadata).toBeUndefined();
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_subagent_start",
    );
    expect(completed).toMatchObject({
      status: "completed",
      data: {
        result: {
          roleId: "coding",
          status: "blocked",
          toolPolicy: "workspace_write",
        },
      },
    });
  });

  test("runs thread-scoped subagents without an active goal", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Inspect thread-scoped context without a goal",
        required: true,
      },
      preferences: preferences(),
      textBySessionId: {
        "role:research": ["Thread-scoped research report complete."],
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a research subagent without a goal",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.subagentQueue.drain();

    expect(turn.status).toBe("completed");
    const run = harness.runs.find((candidate) => candidate.roleId === "research");
    const childSession = [...harness.sessions.values()].find((session) => session.parentSessionId === "session_1");
    const childTurn = harness.turns.find((candidate) => candidate.sessionId === childSession?.id);
    expect(run).toMatchObject({
      parentSessionId: "session_1",
      parentGoalId: null,
      childSessionId: childSession?.id,
      roleId: "research",
      status: "submitted_for_review",
      review: {
        status: "submitted_for_review",
      },
      report: {
        summary: expect.any(String),
        followUpNeeded: false,
      },
    });
    expect(childSession).toMatchObject({
      hiddenFromDefaultSidebar: true,
      parentSessionId: "session_1",
      subagentRunId: run?.id,
      subagentRoleId: "research",
    });
    expect(childSession?.parentGoalId ?? null).toBeNull();
    expect(childTurn?.metadata).toMatchObject({
      usageAttribution: {
        workflowKind: "subagent",
        goalId: null,
        subagentRunId: run?.id,
        subagentRoleId: "research",
      },
    });
    expect(harness.events.some((event) =>
      event.name === "subagent.submitted" &&
      event.sessionId === "session_1" &&
      (event.data as any)?.run?.id === run?.id &&
      ((event.data as any)?.run?.parentGoalId ?? null) === null
    )).toBe(true);
    expect(
      harness.events.some((event) =>
        event.name === "diagnostic" &&
        ((event.data as any)?.kind === "thread_goal" || (event.data as any)?.kind === "goal_control")
      ),
    ).toBe(false);
  });

  test("flags submitted packets as weak when requested validation is missing", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Inspect thread-scoped context without a goal",
        required: true,
        workerBrief: {
          validationCommands: ["bun test tests/focused.test.ts"],
        },
      },
      preferences: preferences(),
      textBySessionId: {
        "role:research": ["Research report complete."],
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a research subagent without a goal",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.subagentQueue.drain();

    expect(turn.status).toBe("completed");
    const run = harness.runs.find((candidate) => candidate.roleId === "research");
    expect(run).toMatchObject({
      status: "submitted_for_review",
      error: null,
      report: {
        summary: expect.any(String),
        confidence: "low",
        followUpNeeded: true,
      },
      progress: {
        phase: "submitted",
      },
      review: {
        status: "submitted_for_review",
        humanReviewRecommended: true,
        independentReviewRecommended: true,
        reviewerRoutingReasons: ["packet_quality_weak", "low_confidence", "validation_missing"],
        reviewerRoutingEvidence: {
          packetQualityStatus: "weak",
          confidence: "low",
          changedFileCount: 0,
          highRiskFileCount: 0,
          validationAttemptCount: 0,
          failedValidationCount: 0,
          missingRequestedValidation: true,
          providerFailureAfterChanges: false,
          userRequestedIndependentReview: false,
        },
        packetQuality: {
          status: "weak",
          warnings: ["Worker brief requested validation, but no validation attempt was observed."],
          evidence: {
            finalSummaryPresent: true,
            requestedValidationCommandCount: 1,
            validationAttemptCount: 0,
            testsRunCount: 0,
            changedFileCount: 0,
            unvalidatedWorkspaceChanges: false,
          },
        },
      },
    });
    expect(harness.events.some((event) => event.name === "subagent.submitted" && (event.data as any)?.run?.id === run?.id)).toBe(true);
  });

  test("queues a watcher-driven parent wake after a required child submits while the parent is idle", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Audit insights notification behavior when nothing changed",
        required: true,
        workerBrief: {
          plan: ["Inspect the notification flow", "Report whether unchanged insights notify"],
          targetFiles: ["apps/server/src/insights"],
          acceptanceCriteria: ["Parent receives a review packet before acceptance"],
          validationCommands: ["bun test tests/turn-runner-subagents.test.ts"],
          stopConditions: ["Stop if the relevant code path cannot be located"],
        },
      },
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      textBySessionId: {
        "role:research": ["Research submitted for review with no direct parent message."],
      },
    });

    const parentTurn = await harness.runner.sendTurn("session_1", {
      prompt: "Start the required research child and continue idling.",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.subagentQueue.drain();

    const submittedRun = harness.runs.find((candidate) => candidate.roleId === "research");
    expect(parentTurn.status).toBe("completed");
    expect(harness.runner.isSessionTurnActive("session_1")).toBe(false);
    expect(harness.sessions.get("session_1")?.status).toBe("idle");
    expect(submittedRun).toMatchObject({
      parentSessionId: "session_1",
      parentGoalId: "goal_1",
      status: "submitted_for_review",
      required: true,
      review: {
        status: "submitted_for_review",
      },
    });

    const watcherNow = new Date(
      Date.parse(submittedRun?.updatedAt ?? submittedRun?.completedAt ?? submittedRun?.createdAt ?? new Date().toISOString()) +
        1000,
    );
    const watcher = createSubagentLifecycleWatcher({
      store: subagentWatcherStoreForHarness(harness),
      queue: createBackgroundWorkerQueue({ queueId: "subagent-lifecycle-integration-test" }),
      parentWakeQueue: harness.turnFollowUpQueue,
      loadAppPreferences: async () => preferences(),
      appendRuntimeEvent: async (event) => {
        harness.events.push(event);
      },
      getSession: async (sessionId) => harness.sessions.get(sessionId) ?? null,
      sendTurn: async (sessionId, payload) => harness.runner.sendTurn(sessionId, payload),
      isSessionActive: (sessionId) => harness.runner.isSessionTurnActive(sessionId),
      isClosing: () => false,
      now: () => watcherNow,
    });

    const result = await watcher.tickNow("manual");
    expect(result).toMatchObject({
      activeCount: 1,
      submittedForReviewCount: 1,
      staleCount: 0,
      wakeQueued: true,
      wakeQueuedCount: 1,
      wakeReasons: ["required_submitted_for_review"],
    });

    await harness.turnFollowUpQueue.drain();

    const lifecycleWakeTurns = harness.turns.filter((turn) => turn.metadata?.subagentLifecycleWake);
    expect(lifecycleWakeTurns).toHaveLength(1);
    expect(lifecycleWakeTurns[0]).toMatchObject({
      sessionId: "session_1",
      status: "completed",
      metadata: {
        subagentLifecycleWake: {
          parentSessionId: "session_1",
          parentGoalId: "goal_1",
          runIds: [submittedRun?.id],
          reasons: ["required_submitted_for_review"],
        },
      },
    });
    expect(lifecycleWakeTurns[0]?.prompt).toContain("required child work that needs main-agent attention");
    expect(lifecycleWakeTurns[0]?.prompt).toContain("Audit insights notification behavior when nothing changed");
    expect(lifecycleWakeTurns[0]?.prompt).toContain("Final report:");
    expect(harness.events.find((event) => (event.data as any)?.kind === "subagent_lifecycle_watcher_wake")).toMatchObject({
      status: "pending",
      data: {
        wakeQueued: true,
        wakeQueuedParentSessionId: "session_1",
        reasons: ["required_submitted_for_review"],
      },
    });
    expect(harness.events.find((event) => (event.data as any)?.kind === "subagent_lifecycle_watcher_tick")).toMatchObject({
      data: {
        activeRunIds: [submittedRun?.id],
        wakeQueued: true,
        wakePolicy: "waking_parent_for_required_lifecycle_attention",
      },
    });

    const duplicate = await watcher.tickNow("manual");
    await harness.turnFollowUpQueue.drain();

    expect(duplicate).toMatchObject({
      wakeQueued: false,
      wakeSkippedCount: 1,
      wakeReasons: ["required_submitted_for_review"],
    });
    expect(harness.turns.filter((turn) => turn.metadata?.subagentLifecycleWake)).toHaveLength(1);
  });

  test("runs write-capable local subagents in a git worktree and reports an isolated patch", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-subagent-worktree-test-"));
    try {
      const repoPath = path.join(tempRoot, "repo");
      await mkdir(repoPath, { recursive: true });
      git(repoPath, ["init"]);
      git(repoPath, ["config", "user.email", "test@example.local"]);
      git(repoPath, ["config", "user.name", "Test User"]);
      await writeFile(path.join(repoPath, "README.md"), "parent\n", "utf8");
      git(repoPath, ["add", "README.md"]);
      git(repoPath, ["commit", "-m", "Initial commit"]);
      const expectedParentRepoPath = await realpath(repoPath);

      const harness = createSubagentHarness({
        toolName: "openpond_subagent_start",
        toolArgs: {
          roleId: "coding",
          objective: "Create child notes in isolation",
          required: true,
        },
        preferences: preferences(),
        initialEvents: [activeGoalEvent()],
        sessionOverrides: {
          cwd: repoPath,
        },
        writeOnChildReport: {
          roleId: "coding",
          path: "child-notes.md",
          content: "from child\n",
        },
        textBySessionId: {
          "role:coding": [
            [
              "```openpond_tool",
              JSON.stringify({ action: "write_file", args: { path: "child-notes.md", content: "from child\n" } }),
              "```",
            ].join("\n"),
            "Coding report complete.",
          ],
        },
      });

      const turn = await harness.runner.sendTurn("session_1", {
        prompt: "Start a coding subagent for this goal",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      });
      await harness.subagentQueue.drain();

      expect(turn.status).toBe("completed");
      const run = harness.runs.find((candidate) => candidate.roleId === "coding");
      const childSession = [...harness.sessions.values()].find((session) => session.parentSessionId === "session_1");
      const childTurn = harness.turns.find((candidate) => candidate.sessionId === childSession?.id);
      const childStreamInput = harness.streamInputs.find((input) => input.requestId === childTurn?.id);
      const worktreePath = childSession?.cwd ?? "";
      expect(run).toMatchObject({
        status: "submitted_for_review",
        progress: {
          phase: "submitted",
        },
        review: {
          status: "submitted_for_review",
          humanReviewRecommended: true,
        },
        report: {
          followUpNeeded: true,
          patchRef: {
            kind: "file",
          },
          diffRef: {
            kind: "diff",
          },
        },
      });
      expect(run?.workerBrief.acceptanceCriteria).toContain("Submit a reviewable result for: Create child notes in isolation");
      expect(childTurn?.prompt).toContain("Create child notes in isolation");
      expect(childTurn?.prompt).toContain("Structured worker brief:");
      expect(childTurn?.prompt).not.toContain("You are an OpenPond");
      expect(JSON.stringify(childStreamInput)).toContain(
        "You are an OpenPond coding subagent running in an addressable child conversation.",
      );
      expect(JSON.stringify(childStreamInput)).toContain("Use openpond_subagent_send_message to message the parent");
      expect(JSON.stringify(childStreamInput)).not.toContain("Subagent delegation mode:");
      expect(worktreePath).not.toBe(repoPath);
      expect(worktreePath).toContain("openpond-subagents");
      await expect(readFile(path.join(worktreePath, "child-notes.md"), "utf8")).resolves.toBe("from child\n");
      await expect(readFile(path.join(repoPath, "child-notes.md"), "utf8")).rejects.toThrow();
      expect((run?.metadata as any)?.subagentWorkspace).toMatchObject({
        implementation: "git_worktree",
        parentRepoPath: expectedParentRepoPath,
        repoPath: worktreePath,
      });
      expect((run?.metadata as any)?.workspaceHandoff).toMatchObject({
        status: "captured",
        changed: true,
      });
      expect((run?.metadata as any)?.workspaceHandoff?.patchPreview).toContain("child-notes.md");
      expect(harness.events.some((event) => event.name === "subagent.reported" && event.sessionId === "session_1")).toBe(true);
      const approval = harness.approvals.find((candidate) => candidate.kind === "subagent_patch_apply");
      expect(approval).toMatchObject({
        sessionId: "session_1",
        providerRequestId: run?.id,
        status: "pending",
      });
      expect(JSON.parse(approval?.detail ?? "{}")).toMatchObject({
        runId: run?.id,
        roleId: "coding",
        childSessionId: childSession?.id,
        parentRepoPath: expectedParentRepoPath,
      });
      expect(
        harness.events.some(
          (event) => event.name === "approval.requested" && event.action === "subagent_patch_apply",
        ),
      ).toBe(true);
      const resolved = await harness.runner.resolveSubagentPatchApplyApproval(approval!.id, {
        decision: "accept",
      });
      expect(resolved).toMatchObject({
        id: approval?.id,
        status: "accepted",
      });
      await expect(readFile(path.join(repoPath, "child-notes.md"), "utf8")).resolves.toBe("from child\n");
      const appliedRun = harness.runs.find((candidate) => candidate.id === run?.id);
      expect((appliedRun?.metadata as any)?.workspaceHandoff?.applyResult).toMatchObject({
        status: "applied",
        approvalId: approval?.id,
        parentRepoPath: expectedParentRepoPath,
      });
      const appliedHandoff = (appliedRun?.metadata as any)?.workspaceHandoff;
      expect(appliedHandoff?.patchPath).toContain(path.join("openpond-test-attachments", "subagents"));
      await expect(readFile(appliedHandoff.patchPath, "utf8")).resolves.toContain("child-notes.md");
      expect((appliedRun?.metadata as any)?.lifecycleCleanup?.workspaceCleanup).toMatchObject({
        status: "removed",
      });
      await expect(readFile(path.join(worktreePath, "child-notes.md"), "utf8")).rejects.toThrow();
      expect(harness.events.some((event) => event.name === "subagent.cleanup" && event.status === "started")).toBe(true);
      expect(harness.events.some((event) => event.name === "subagent.cleanup" && event.status === "completed")).toBe(true);
      expect(
        harness.events.some(
          (event) => event.name === "approval.resolved" && event.action === "subagent_patch_apply",
        ),
      ).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("uses role review-routing policy for broad and high-risk child handoffs", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-subagent-routing-policy-test-"));
    try {
      const repoPath = path.join(tempRoot, "repo");
      await mkdir(repoPath, { recursive: true });
      git(repoPath, ["init"]);
      git(repoPath, ["config", "user.email", "test@example.local"]);
      git(repoPath, ["config", "user.name", "Test User"]);
      await writeFile(path.join(repoPath, "README.md"), "parent\n", "utf8");
      git(repoPath, ["add", "README.md"]);
      git(repoPath, ["commit", "-m", "Initial commit"]);

      const harness = createSubagentHarness({
        toolName: "openpond_subagent_start",
        toolArgs: {
          roleId: "coding",
          objective: "Create a policy-sensitive child patch",
          required: true,
        },
        preferences: preferencesWithSubagentRole("coding", {
          reviewRouting: {
            broadEditSurfaceFileThreshold: 1,
            highRiskPathPatterns: ["(^|/)child-notes\\.md$"],
          },
        }),
        sessionOverrides: {
          cwd: repoPath,
        },
        writeOnChildReport: {
          roleId: "coding",
          path: "child-notes.md",
          content: "from child\n",
        },
        textBySessionId: {
          "role:coding": ["Coding report complete."],
        },
      });

      await harness.runner.sendTurn("session_1", {
        prompt: "Start a coding subagent for this goal",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      });
      await harness.subagentQueue.drain();

      const run = harness.runs.find((candidate) => candidate.roleId === "coding");
      const changedFileCount = Number(run?.review.reviewerRoutingEvidence.changedFileCount ?? 0);
      const highRiskFileCount = Number(run?.review.reviewerRoutingEvidence.highRiskFileCount ?? 0);
      expect(run).toMatchObject({
        status: "submitted_for_review",
        review: {
          independentReviewRecommended: true,
          reviewerRoutingReasons: expect.arrayContaining(["broad_edit_surface", "high_risk_files"]),
          reviewerRoutingEvidence: {
            highRiskFileCount: expect.any(Number),
            providerFailureAfterChanges: false,
            userRequestedIndependentReview: false,
          },
        },
      });
      expect(changedFileCount).toBeGreaterThanOrEqual(1);
      expect(highRiskFileCount).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("retains isolated worktrees when subagent patch approvals are declined or cancelled", async () => {
    const scenarios = [
      {
        decision: "decline" as const,
        approvalStatus: "declined",
        runStatus: "needs_revision",
        reviewStatus: "needs_revision",
        applyStatus: "declined",
        followUpNeeded: true,
        eventName: "subagent.needs_revision",
      },
      {
        decision: "cancel" as const,
        approvalStatus: "cancelled",
        runStatus: "cancelled",
        reviewStatus: "needs_user_input",
        applyStatus: "cancelled",
        followUpNeeded: false,
        eventName: "subagent.cancelled",
      },
    ];

    for (const scenario of scenarios) {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), `openpond-subagent-patch-${scenario.decision}-test-`));
      try {
        const repoPath = path.join(tempRoot, "repo");
        await mkdir(repoPath, { recursive: true });
        git(repoPath, ["init"]);
        git(repoPath, ["config", "user.email", "test@example.local"]);
        git(repoPath, ["config", "user.name", "Test User"]);
        await writeFile(path.join(repoPath, "README.md"), "parent\n", "utf8");
        git(repoPath, ["add", "README.md"]);
        git(repoPath, ["commit", "-m", "Initial commit"]);

        const childPath = `child-notes-${scenario.decision}.md`;
        const childContent = `from child ${scenario.decision}\n`;
        const harness = createSubagentHarness({
          toolName: "openpond_subagent_start",
          toolArgs: {
            roleId: "coding",
            objective: `Create child notes for ${scenario.decision}`,
          },
          preferences: preferences(),
          sessionOverrides: {
            cwd: repoPath,
          },
          writeOnChildReport: {
            roleId: "coding",
            path: childPath,
            content: childContent,
          },
          textBySessionId: {
            "role:coding": ["Coding report complete."],
          },
        });

        await harness.runner.sendTurn("session_1", {
          prompt: "Start a coding subagent for this goal",
          modelRef: { providerId: "openrouter", modelId: "test/model" },
        });
        await harness.subagentQueue.drain();

        const run = harness.runs.find((candidate) => candidate.roleId === "coding");
        const childSession = [...harness.sessions.values()].find((session) => session.parentSessionId === "session_1");
        const worktreePath = childSession?.cwd ?? "";
        const approval = harness.approvals.find((candidate) => candidate.kind === "subagent_patch_apply");
        expect(run?.status).toBe("submitted_for_review");
        expect(approval).toMatchObject({
          providerRequestId: run?.id,
          status: "pending",
        });
        await expect(readFile(path.join(worktreePath, childPath), "utf8")).resolves.toBe(childContent);
        await expect(readFile(path.join(repoPath, childPath), "utf8")).rejects.toThrow();

        const resolved = await harness.runner.resolveSubagentPatchApplyApproval(approval!.id, {
          decision: scenario.decision,
        });

        expect(resolved).toMatchObject({
          id: approval?.id,
          status: scenario.approvalStatus,
        });
        await expect(readFile(path.join(repoPath, childPath), "utf8")).rejects.toThrow();
        await expect(readFile(path.join(worktreePath, childPath), "utf8")).resolves.toBe(childContent);
        const reviewedRun = harness.runs.find((candidate) => candidate.id === run?.id);
        expect(reviewedRun).toMatchObject({
          status: scenario.runStatus,
          report: {
            followUpNeeded: scenario.followUpNeeded,
          },
          review: {
            status: scenario.reviewStatus,
            humanReviewRecommended: true,
          },
        });
        expect((reviewedRun?.metadata as any)?.workspaceHandoff?.applyResult).toMatchObject({
          status: scenario.applyStatus,
          approvalId: approval?.id,
          workspaceRetention: {
            status: "retained",
            reason: scenario.decision === "cancel"
              ? "Patch approval cancelled; child workspace retained for inspection."
              : "Patch approval declined; child workspace retained for revision.",
            retainedAt: expect.any(String),
            retentionPolicy: {
              kind: "retain_for_inspection",
              retentionDays: 7,
              expiresAt: expect.any(String),
              cleanupAfterExpiry: true,
              trigger: scenario.decision === "cancel" ? "patch_approval_cancelled" : "patch_approval_declined",
            },
          },
        });
        expect((reviewedRun?.metadata as any)?.lifecycleCleanup).toBeUndefined();
        expect(
          harness.events.some(
            (event) => event.name === "subagent.cleanup" && (event.data as any)?.run?.id === run?.id,
          ),
        ).toBe(false);
        expect(
          harness.events.some(
            (event) => event.name === scenario.eventName && (event.data as any)?.run?.id === run?.id,
          ),
        ).toBe(true);
        expect(
          harness.events.find(
            (event) => event.name === "subagent.workspace_retained" && (event.data as any)?.run?.id === run?.id,
          ),
        ).toMatchObject({
          status: "completed",
        });
        expect(
          harness.events.some(
            (event) =>
              event.name === "approval.resolved" &&
              event.action === "subagent_patch_apply" &&
              (event.data as any)?.status === scenario.approvalStatus,
          ),
        ).toBe(true);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    }
  });

  test("links ignored dependency artifacts into local subagent worktrees for focused tests", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-subagent-dependency-test-"));
    try {
      const repoPath = path.join(tempRoot, "repo");
      await mkdir(path.join(repoPath, "node_modules", "fixture-dep"), { recursive: true });
      git(repoPath, ["init"]);
      git(repoPath, ["config", "user.email", "test@example.local"]);
      git(repoPath, ["config", "user.name", "Test User"]);
      await writeFile(path.join(repoPath, ".gitignore"), "node_modules/\n", "utf8");
      await writeFile(
        path.join(repoPath, "package.json"),
        JSON.stringify(
          {
            name: "copy-on-write-dependency-fixture",
            private: true,
            type: "module",
            scripts: { "test:fixture": "bun test fixture.test.ts" },
            dependencies: { "fixture-dep": "1.0.0" },
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        path.join(repoPath, "fixture.test.ts"),
        [
          'import { expect, test } from "bun:test";',
          'import value from "fixture-dep";',
          'test("dependency resolves", () => {',
          '  expect(value).toBe("dependency-ready");',
          "});",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        path.join(repoPath, "node_modules", "fixture-dep", "package.json"),
        JSON.stringify({ name: "fixture-dep", version: "1.0.0", type: "module", main: "index.js" }, null, 2),
        "utf8",
      );
      await writeFile(
        path.join(repoPath, "node_modules", "fixture-dep", "index.js"),
        'export default "dependency-ready";\n',
        "utf8",
      );
      git(repoPath, ["add", ".gitignore", "package.json", "fixture.test.ts"]);
      git(repoPath, ["commit", "-m", "Initial commit"]);
      const expectedParentRepoPath = await realpath(repoPath);

      const commandResults: Array<{ cwd: string | null; exitCode: number | null; stdout: string; stderr: string }> = [];
      const harness = createSubagentHarness({
        toolName: "openpond_subagent_start",
        toolArgs: {
          roleId: "coding",
          objective: "Validate isolated dependencies",
          required: true,
          workerBrief: {
            validationCommands: ["bun test fixture.test.ts"],
          },
        },
        preferences: preferences(),
        initialEvents: [activeGoalEvent()],
        sessionOverrides: {
          cwd: repoPath,
        },
        maxHostedWorkspaceToolRounds: 4,
        textBySessionId: {
          "role:coding": ["Dependency validation complete."],
        },
        toolCallForStream: (_streamInput, context) => {
          if (context.requestSession?.subagentRoleId !== "coding" || context.injectedFlags.dependencyValidation) {
            return null;
          }
          context.injectedFlags.dependencyValidation = true;
          return {
            name: "exec_command",
            args: {
              command: "bun test fixture.test.ts",
              cwd: context.requestSession.cwd,
              timeoutSeconds: 30,
            },
          };
        },
        executeOpenPondCommand: async (request) => {
          const result = spawnSync("bash", ["-lc", request.command], {
            cwd: request.cwd ?? repoPath,
            encoding: "utf8",
          });
          const commandResult = {
            cwd: request.cwd ?? null,
            exitCode: result.status ?? 1,
            stdout: result.stdout,
            stderr: result.stderr,
          };
          commandResults.push(commandResult);
          return {
            ok: (result.status ?? 1) === 0,
            command: request.command,
            cwd: request.cwd ?? null,
            exitCode: result.status ?? 1,
            stdout: result.stdout,
            stderr: result.stderr,
            timedOut: false,
            timeoutSeconds: request.timeoutSeconds ?? 120,
            truncated: false,
            blockedReason: null,
          };
        },
      });

      await harness.runner.sendTurn("session_1", {
        prompt: "Start a coding subagent for this goal",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      });
      await harness.subagentQueue.drain();

      const run = harness.runs.find((candidate) => candidate.roleId === "coding");
      const childSession = [...harness.sessions.values()].find((session) => session.parentSessionId === "session_1");
      const worktreePath = childSession?.cwd ?? "";
      expect(commandResults).toHaveLength(1);
      expect(commandResults[0]?.exitCode).toBe(0);
      expect(commandResults[0]?.cwd).toBe(worktreePath);
      expect(worktreePath).toContain("openpond-subagents");
      await expect(readFile(path.join(worktreePath, "node_modules", "fixture-dep", "index.js"), "utf8")).resolves.toContain(
        "dependency-ready",
      );
      expect((await lstat(path.join(worktreePath, "node_modules"))).isSymbolicLink()).toBe(true);
      expect((run?.metadata as any)?.subagentWorkspace?.dependencyLinks).toContainEqual(
        expect.objectContaining({
          path: "node_modules",
          status: "linked",
          sourcePath: path.join(expectedParentRepoPath, "node_modules"),
          targetPath: path.join(worktreePath, "node_modules"),
        }),
      );
      expect(run?.progress.validationAttempts).toEqual([
        expect.objectContaining({
          command: "bun test fixture.test.ts",
          status: "passed",
          exitCode: 0,
        }),
      ]);
      expect(run?.status).toBe("submitted_for_review");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("derives subagent progress from child tool events and records piped validation failures", async () => {
    const validationCommand = "bun test tests/insights.test.ts | tail -40";
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Investigate insights notification behavior",
        required: true,
        workerBrief: {
          plan: ["Inspect notification code", "Run focused validation", "Submit review packet"],
          targetFiles: ["apps/server/src/insights.ts"],
          acceptanceCriteria: ["Explain whether the notification behavior changed"],
          validationCommands: [validationCommand],
          stopConditions: ["Stop if validation fails and report the failure"],
        },
      },
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      maxHostedWorkspaceToolRounds: 4,
      textBySessionId: {
        "role:research": ["Research report complete."],
      },
      workspaceToolResultForRequest: ({ request }) => {
        if (request.action !== "resource_search") return null;
        return {
          ok: true,
          action: "resource_search",
          output: "Found 1 resource.",
          data: {
            result: {
              query: request.args?.query,
              items: [
                {
                  ref: "workspace:file:apps/server/src/insights.ts",
                  title: "apps/server/src/insights.ts",
                  snippet: "notification behavior",
                  score: 0.9,
                },
              ],
            },
          },
        };
      },
      executeOpenPondCommand: async (request) => ({
        ok: true,
        command: request.command,
        cwd: "/tmp/openpond",
        exitCode: 0,
        stdout: "1 fail\nerror: expected notification to be suppressed\n",
        stderr: "",
        timedOut: false,
        timeoutSeconds: request.timeoutSeconds ?? 120,
        truncated: false,
        blockedReason: null,
      }),
      toolCallForStream: (_streamInput, context) => {
        if (context.requestSession?.subagentRoleId !== "research") return null;
        if (!context.injectedFlags.firstSearch) {
          context.injectedFlags.firstSearch = true;
          return {
            name: "resource_search",
            args: { scope: "workspace", query: "insights notification", limit: 5 },
          };
        }
        if (!context.injectedFlags.secondSearch) {
          context.injectedFlags.secondSearch = true;
          return {
            name: "resource_search",
            args: { scope: "workspace", query: "insights notification", limit: 5 },
          };
        }
        if (!context.injectedFlags.validation) {
          context.injectedFlags.validation = true;
          return {
            name: "exec_command",
            args: { command: validationCommand, timeoutSeconds: 120 },
          };
        }
        return null;
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a research subagent for this goal",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.subagentQueue.drain();

    expect(turn.status).toBe("completed");
    const run = harness.runs.find((candidate) => candidate.roleId === "research");
    expect(run).toMatchObject({
      status: "submitted_for_review",
      progress: {
        phase: "submitted",
        inspectedFiles: ["apps/server/src/insights.ts"],
        repeatedSearches: ["resource_search:insights notification"],
        repeatedCommands: [],
      },
      review: {
        status: "submitted_for_review",
      },
    });
    expect(run?.progress.validationAttempts).toEqual([
      expect.objectContaining({
        command: validationCommand,
        status: "failed",
        exitCode: 0,
      }),
    ]);
    expect(run?.progress.currentBlocker).toContain("Validation failed");
    expect(run?.progress.latestMeaningfulActivity).toBe("Child submitted a final report for parent review.");
    expect(JSON.stringify(harness.streamInputs)).toContain("Runtime subagent steering");
    expect(JSON.stringify(harness.streamInputs)).toContain("repeated the same search pattern");
  });

  test("uses role exploration steering thresholds before warning repeated searches", async () => {
    let searchCount = 0;
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Inspect insights notification behavior",
        required: true,
      },
      preferences: preferencesWithSubagentRole("research", {
        explorationSteering: {
          repeatedSearchThreshold: 3,
        },
      }),
      initialEvents: [activeGoalEvent()],
      textBySessionId: {
        "role:research": ["Research report complete after two searches."],
      },
      toolCallForStream: (_streamInput, context) => {
        if (context.requestSession?.subagentRoleId !== "research") return null;
        if (searchCount >= 2) return null;
        searchCount += 1;
        return {
          name: "resource_search",
          args: { scope: "workspace", query: "insights notification", limit: 5 },
        };
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a research subagent for this goal",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.subagentQueue.drain();

    expect(turn.status).toBe("completed");
    const run = harness.runs.find((candidate) => candidate.roleId === "research");
    expect(run).toMatchObject({
      status: "submitted_for_review",
      progress: {
        repeatedSearches: ["resource_search:insights notification"],
      },
    });
    expect(JSON.stringify(harness.streamInputs)).not.toContain("Runtime subagent steering");
  });

  test("runs sandbox-backed mutating subagents in a forked copy-on-write sandbox", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "coding",
        objective: "Mutate the Hybrid sandbox source",
        required: true,
      },
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      sessionOverrides: {
        workspaceKind: "sandbox",
        workspaceId: "sandbox_1",
        workspaceName: "Hybrid Sandbox",
        cwd: null,
        localProjectId: "local_project_1",
        cloudProjectId: "cloud_project_1",
        cloudTeamId: "team_1",
        metadata: { workspaceTarget: "hybrid" },
      },
      textBySessionId: {
        "role:coding": ["Coding sandbox report complete."],
      },
      forkSandboxForSubagent: async () => ({
        sandbox: {
          id: "sandbox_child_1",
          name: "Hybrid Sandbox coding fork",
        },
        sourceSandbox: {
          id: "sandbox_1",
          name: "Hybrid Sandbox",
        },
      }),
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a coding subagent for this Hybrid goal",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.subagentQueue.drain();

    expect(turn.status).toBe("completed");
    const run = harness.runs.find((candidate) => candidate.roleId === "coding");
    const childSession = [...harness.sessions.values()].find((session) => session.parentSessionId === "session_1");
    expect(run).toMatchObject({
      status: "submitted_for_review",
      progress: {
        phase: "submitted",
      },
      review: {
        status: "submitted_for_review",
        humanReviewRecommended: true,
      },
      report: {
        followUpNeeded: true,
        artifacts: [
          {
            kind: "artifact",
            id: "sandbox:sandbox_child_1",
          },
        ],
      },
      metadata: {
        subagentWorkspace: {
          implementation: "sandbox_fork",
          target: "sandbox",
          sandboxId: "sandbox_child_1",
          parentSandboxId: "sandbox_1",
        },
        workspaceHandoff: {
          implementation: "sandbox_fork",
          sandboxId: "sandbox_child_1",
          parentSandboxId: "sandbox_1",
          changed: true,
        },
      },
    });
    expect(childSession).toMatchObject({
      workspaceKind: "sandbox",
      workspaceId: "sandbox_child_1",
      workspaceName: "Hybrid Sandbox coding fork",
      localProjectId: "local_project_1",
      cloudProjectId: "cloud_project_1",
      cloudTeamId: "team_1",
      metadata: {
        workspaceTarget: "hybrid",
        subagent: {
          effectiveIsolationMode: "copy_on_write",
          workspace: {
            implementation: "sandbox_fork",
            target: "sandbox",
            sandboxId: "sandbox_child_1",
            parentSandboxId: "sandbox_1",
          },
        },
      },
    });
    expect(childSession?.cwd ?? "").not.toContain("openpond-subagents");
    expect(harness.sandboxForkRequests).toHaveLength(1);
    expect(harness.sandboxForkRequests[0]).toMatchObject({
      sandboxId: "sandbox_1",
      payload: {
        visibility: "private",
        metadata: {
          openpondPurpose: "subagent_copy_on_write",
          parentSessionId: "session_1",
          parentSandboxId: "sandbox_1",
          subagentRoleId: "coding",
          isolationMode: "copy_on_write",
        },
      },
    });
    expect(harness.workspaceRequests).toEqual([]);
    expect(harness.events.some((event) => event.name === "subagent.reported" && event.sessionId === "session_1")).toBe(true);
  });

  test("deletes sandbox fork workspaces when a sandbox-backed subagent is cancelled", async () => {
    const run = SubagentRunSchema.parse({
      id: "run_sandbox_cancel",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_sandbox_cancel",
      roleId: "coding",
      objective: "Cancel sandbox work",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "workspace_write",
      background: true,
      peerMessages: "goal_scoped",
      status: "running",
      required: false,
      createdAt: "2026-07-07T09:00:00.000Z",
      metadata: {
        subagentWorkspace: {
          mode: "copy_on_write",
          implementation: "sandbox_fork",
          target: "sandbox",
          sandboxId: "sandbox_child_cancel",
          workspaceId: "sandbox_child_cancel",
          workspaceName: "Sandbox child cancel fork",
          parentSandboxId: "sandbox_parent",
          sourceSandboxId: "sandbox_parent",
          forkedAt: "2026-07-07T09:00:00.000Z",
        },
      },
    });
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_cancel",
      toolArgs: {
        runId: "run_sandbox_cancel",
        reason: "Discard sandbox attempt.",
      },
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      initialRuns: [run],
      cleanupSandboxForSubagent: async ({ sandboxId }) => ({
        sandbox: {
          id: sandboxId,
          state: "deleted",
          name: "Sandbox child cancel fork",
        },
      }),
    });
    harness.sessions.set(
      "session_child_sandbox_cancel",
      baseSession({
        id: "session_child_sandbox_cancel",
        parentSessionId: "session_1",
        parentTurnId: "turn_prior",
        parentGoalId: "goal_1",
        subagentRunId: "run_sandbox_cancel",
        subagentRoleId: "coding",
        workspaceKind: "sandbox",
        workspaceId: "sandbox_child_cancel",
        hiddenFromDefaultSidebar: true,
      }),
    );

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Cancel sandbox subagent",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.sandboxCleanupRequests).toEqual([
      expect.objectContaining({
        sandboxId: "sandbox_child_cancel",
        run: expect.objectContaining({
          id: "run_sandbox_cancel",
        }),
      }),
    ]);
    expect(harness.runs.find((candidate) => candidate.id === "run_sandbox_cancel")).toMatchObject({
      status: "cancelled",
      metadata: {
        lifecycleCleanup: {
          reason: "cancel_requested",
          workspaceCleanup: {
            status: "deleted",
            implementation: "sandbox_fork",
            sandboxId: "sandbox_child_cancel",
            parentSandboxId: "sandbox_parent",
            payload: {
              sandboxId: "sandbox_child_cancel",
              state: "deleted",
            },
          },
        },
      },
    });
    expect(harness.events.some((event) =>
      event.name === "subagent.cleanup" &&
      event.status === "completed" &&
      (event.data as any)?.run?.metadata?.lifecycleCleanup?.workspaceCleanup?.status === "deleted"
    )).toBe(true);
  });

  test("keeps subagent patch approvals pending when the parent repo rejects the patch", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-subagent-apply-fail-test-"));
    try {
      const repoPath = path.join(tempRoot, "repo");
      await mkdir(repoPath, { recursive: true });
      git(repoPath, ["init"]);
      git(repoPath, ["config", "user.email", "test@example.local"]);
      git(repoPath, ["config", "user.name", "Test User"]);
      await writeFile(path.join(repoPath, "README.md"), "parent\n", "utf8");
      git(repoPath, ["add", "README.md"]);
      git(repoPath, ["commit", "-m", "Initial commit"]);

      const harness = createSubagentHarness({
        toolName: "openpond_subagent_start",
        toolArgs: {
          roleId: "coding",
          objective: "Create child notes in isolation",
        },
        preferences: preferences(),
        sessionOverrides: {
          cwd: repoPath,
        },
        writeOnChildReport: {
          roleId: "coding",
          path: "child-notes.md",
          content: "from child\n",
        },
        textBySessionId: {
          "role:coding": ["Coding report complete."],
        },
      });

      await harness.runner.sendTurn("session_1", {
        prompt: "Start a coding subagent for this goal",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      });
      await harness.subagentQueue.drain();

      const run = harness.runs.find((candidate) => candidate.roleId === "coding");
      const childSession = [...harness.sessions.values()].find((session) => session.parentSessionId === "session_1");
      const worktreePath = childSession?.cwd ?? "";
      const approval = harness.approvals.find((candidate) => candidate.kind === "subagent_patch_apply");
      expect(approval?.status).toBe("pending");
      expect(run?.status).toBe("submitted_for_review");
      await expect(readFile(path.join(worktreePath, "child-notes.md"), "utf8")).resolves.toBe("from child\n");
      await writeFile(path.join(repoPath, "child-notes.md"), "parent conflict\n", "utf8");
      await expect(
        harness.runner.resolveSubagentPatchApplyApproval(approval!.id, {
          decision: "accept",
        }),
      ).rejects.toThrow();
      expect(harness.approvals.find((candidate) => candidate.id === approval?.id)?.status).toBe("pending");
      await expect(readFile(path.join(repoPath, "child-notes.md"), "utf8")).resolves.toBe("parent conflict\n");
      await expect(readFile(path.join(worktreePath, "child-notes.md"), "utf8")).resolves.toBe("from child\n");
      const pendingRun = harness.runs.find((candidate) => candidate.id === run?.id);
      expect(pendingRun?.status).toBe("submitted_for_review");
      expect((pendingRun?.metadata as any)?.workspaceHandoff?.applyResult).toBeUndefined();
      expect((pendingRun?.metadata as any)?.lifecycleCleanup).toBeUndefined();
      expect(
        harness.events.some(
          (event) => event.name === "approval.resolved" && event.action === "subagent_patch_apply",
        ),
      ).toBe(false);
      expect(
        harness.events.some(
          (event) => event.name === "subagent.cleanup" && (event.data as any)?.run?.id === run?.id,
        ),
      ).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects subagent starts at the configured role concurrency ceiling", async () => {
    const activeRun = SubagentRunSchema.parse({
      id: "run_active",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child",
      roleId: "research",
      objective: "Existing research",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "queued",
      required: true,
      createdAt: "2026-07-07T10:00:00.000Z",
    });
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Do another research pass",
      },
      preferences: preferences(),
      initialRuns: [activeRun],
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start another research subagent",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.runs).toHaveLength(1);
    expect([...harness.sessions.values()].filter((session) => session.parentSessionId === "session_1")).toHaveLength(0);
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_subagent_start",
    );
    expect(completed).toMatchObject({
      status: "failed",
    });
    expect(completed?.output).toContain("Subagent role research concurrency limit reached: 1/1 active runs.");
  });

  test("rejects subagent starts at the configured provider concurrency ceiling", async () => {
    const activeRun = SubagentRunSchema.parse({
      id: "run_provider_active",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_provider",
      roleId: "research",
      objective: "Existing provider-bound research",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "running",
      required: true,
      createdAt: "2026-07-07T10:00:00.000Z",
    });
    const basePreferences = preferences();
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "review",
        objective: "Review the same issue",
      },
      preferences: preferences({
        subagents: {
          ...basePreferences.subagents,
          maxConcurrentRunsPerProvider: 1,
          maxConcurrentRunsPerWorkspaceTarget: null,
        },
      }),
      initialRuns: [activeRun],
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a review subagent",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.runs).toHaveLength(1);
    expect([...harness.sessions.values()].filter((session) => session.parentSessionId === "session_1")).toHaveLength(0);
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_subagent_start",
    );
    expect(completed).toMatchObject({ status: "failed" });
    expect(completed?.output).toContain("Subagent provider openrouter concurrency limit reached: 1/1 active runs.");
  });

  test("rejects subagent starts at the configured workspace target concurrency ceiling", async () => {
    const activeRun = SubagentRunSchema.parse({
      id: "run_workspace_active",
      parentSessionId: "session_1",
      parentTurnId: "turn_prior",
      parentGoalId: "goal_1",
      childSessionId: "session_child_workspace",
      roleId: "research",
      objective: "Existing workspace-bound research",
      modelRef: { providerId: "zai", modelId: "glm-5.2" },
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
      peerMessages: "goal_scoped",
      status: "running",
      required: true,
      createdAt: "2026-07-07T10:00:00.000Z",
      metadata: {
        concurrency: {
          providerId: "zai",
          workspaceTargetKey: "local:/tmp/openpond",
        },
      },
    });
    const basePreferences = preferences();
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "review",
        objective: "Review the same workspace",
      },
      preferences: preferences({
        subagents: {
          ...basePreferences.subagents,
          maxConcurrentRunsPerProvider: null,
          maxConcurrentRunsPerWorkspaceTarget: 1,
        },
      }),
      initialRuns: [activeRun],
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a workspace-constrained review subagent",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.runs).toHaveLength(1);
    expect([...harness.sessions.values()].filter((session) => session.parentSessionId === "session_1")).toHaveLength(0);
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_subagent_start",
    );
    expect(completed).toMatchObject({ status: "failed" });
    expect(completed?.output).toContain(
      "Subagent workspace target concurrency limit reached: 1/1 active runs for local:/tmp/openpond.",
    );
  });

  test("uses the parent turn model when a subagent role has no model override", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Research using the parent model",
      },
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      textBySessionId: {
        session_2: ["Research complete."],
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a research subagent on the current parent model",
      modelRef: { providerId: "zai", modelId: "glm-5.2" },
    });
    await harness.subagentQueue.drain();

    expect(turn.status).toBe("completed");
    const childSession = harness.sessions.get("session_2");
    expect(childSession).toMatchObject({
      provider: "zai",
      modelRef: { providerId: "zai", modelId: "glm-5.2" },
      subagentRoleId: "research",
    });
    expect(harness.runs[0]).toMatchObject({
      roleId: "research",
      modelRef: { providerId: "zai", modelId: "glm-5.2" },
      status: "submitted_for_review",
      review: {
        status: "submitted_for_review",
      },
    });
  });

  test("uses the configured subagent default model before the parent turn model", async () => {
    const basePreferences = preferences();
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Research using the subagent default model",
      },
      preferences: preferences({
        subagents: {
          ...basePreferences.subagents,
          defaultModelRef: { providerId: "zai", modelId: "glm-5.2" },
        },
      }),
      initialEvents: [activeGoalEvent()],
      textBySessionId: {
        session_2: ["Research complete."],
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a research subagent with the default subagent model",
      modelRef: { providerId: "openrouter", modelId: "parent/model" },
    });
    await harness.subagentQueue.drain();

    expect(turn.status).toBe("completed");
    const childSession = harness.sessions.get("session_2");
    expect(childSession).toMatchObject({
      provider: "zai",
      modelRef: { providerId: "zai", modelId: "glm-5.2" },
      subagentRoleId: "research",
    });
    expect(harness.runs[0]).toMatchObject({
      roleId: "research",
      modelRef: { providerId: "zai", modelId: "glm-5.2" },
      status: "submitted_for_review",
      review: {
        status: "submitted_for_review",
      },
    });
  });

  test("uses configured role model before the parent turn model", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Research using the configured role model",
      },
      preferences: preferencesWithSubagentRole("research", {
        modelRef: { providerId: "zai", modelId: "glm-5.2" },
      }),
      initialEvents: [activeGoalEvent()],
      textBySessionId: {
        session_2: ["Research complete."],
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a research subagent with a role model override",
      modelRef: { providerId: "openrouter", modelId: "parent/model" },
    });
    await harness.subagentQueue.drain();

    expect(turn.status).toBe("completed");
    const childSession = harness.sessions.get("session_2");
    expect(childSession).toMatchObject({
      provider: "zai",
      modelRef: { providerId: "zai", modelId: "glm-5.2" },
      subagentRoleId: "research",
    });
    expect(harness.runs[0]).toMatchObject({
      roleId: "research",
      modelRef: { providerId: "zai", modelId: "glm-5.2" },
      status: "submitted_for_review",
      review: {
        status: "submitted_for_review",
      },
    });
  });

  test("marks the subagent failed when the stored child turn fails after sendTurn returns", async () => {
    const harness = createSubagentHarness({
      toolName: "openpond_subagent_start",
      toolArgs: {
        roleId: "research",
        objective: "Research should fail if the child provider turn fails",
      },
      preferences: preferences(),
      initialEvents: [activeGoalEvent()],
      textBySessionId: {
        session_2: ["This text is discarded by the forced stored failure."],
      },
      forceStoredChildTurnFailureAfterComplete: "Provider zai stream failed: 429 1305",
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Start a research subagent and wait for it",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await harness.subagentQueue.drain();

    expect(turn.status).toBe("completed");
    expect(harness.sessions.get("session_2")).toMatchObject({ status: "failed" });
    expect(harness.runs[0]).toMatchObject({
      roleId: "research",
      status: "failed",
      error: "Provider zai stream failed: 429 1305",
      report: {
        summary: "Child conversation failed before producing a final report.",
        followUpNeeded: true,
      },
    });
    expect(harness.events.some((event) => event.name === "subagent.failed" && event.sessionId === "session_1")).toBe(true);
    expect(harness.events.some((event) => event.name === "subagent.completed" && event.sessionId === "session_1")).toBe(false);
  });

  test("hands off recoverable workspace changes when the stored child turn fails after validation", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-subagent-failure-handoff-test-"));
    try {
      const repoPath = path.join(tempRoot, "repo");
      await mkdir(repoPath, { recursive: true });
      git(repoPath, ["init"]);
      git(repoPath, ["config", "user.email", "test@example.local"]);
      git(repoPath, ["config", "user.name", "Test User"]);
      await writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
      git(repoPath, ["add", "README.md"]);
      git(repoPath, ["commit", "-m", "Initial commit"]);

      const validationCommand = "bun test failing.test.ts";
      const harness = createSubagentHarness({
        toolName: "openpond_subagent_start",
        toolArgs: {
          roleId: "coding",
          objective: "Make a recoverable edit before the provider fails",
          required: true,
          workerBrief: {
            validationCommands: [validationCommand],
          },
        },
        preferences: preferences(),
        initialEvents: [activeGoalEvent()],
        sessionOverrides: {
          cwd: repoPath,
        },
        maxHostedWorkspaceToolRounds: 4,
        writeOnChildReport: {
          roleId: "coding",
          path: "child-notes.md",
          content: "from child before provider failure\n",
        },
        textBySessionId: {
          "role:coding": ["This text is discarded by the forced stored failure."],
        },
        forceStoredChildTurnFailureAfterComplete: "Provider zai stream failed: 429 1305",
        toolCallForStream: (_streamInput, context) => {
          if (context.requestSession?.subagentRoleId !== "coding" || context.injectedFlags.failureHandoffValidation) {
            return null;
          }
          context.injectedFlags.failureHandoffValidation = true;
          return {
            name: "exec_command",
            args: {
              command: validationCommand,
              cwd: context.requestSession.cwd,
              timeoutSeconds: 30,
            },
          };
        },
        executeOpenPondCommand: async (request) => ({
          ok: false,
          command: request.command,
          cwd: request.cwd ?? null,
          exitCode: 1,
          stdout: "not ok 1 - expected insights notification to stay suppressed\n",
          stderr: "FAIL failing.test.ts\n",
          timedOut: false,
          timeoutSeconds: request.timeoutSeconds ?? 120,
          truncated: false,
          blockedReason: null,
        }),
      });

      const turn = await harness.runner.sendTurn("session_1", {
        prompt: "Start a coding subagent and wait for it",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      });
      await harness.subagentQueue.drain();

      expect(turn.status).toBe("completed");
      expect(harness.sessions.get("session_2")).toMatchObject({ status: "failed" });
      const run = harness.runs.find((candidate) => candidate.roleId === "coding");
      expect(run).toMatchObject({
        status: "failed_with_artifacts",
        error: "Provider zai stream failed: 429 1305",
        report: {
          summary: "Child conversation failed after producing recoverable artifacts.",
          testsRun: [validationCommand],
          blockers: [
            "Provider zai stream failed: 429 1305",
            `Validation failed: ${validationCommand}`,
          ],
          confidence: "low",
          followUpNeeded: true,
        },
        review: {
          status: "failed_with_artifacts",
          humanReviewRecommended: true,
        },
      });
      expect(run?.report?.patchRef).toMatchObject({ kind: "file", label: "Isolated child patch" });
      expect(run?.report?.diffRef).toMatchObject({ kind: "diff", label: "Isolated child diff" });
      expect(run?.progress.changedFiles).toContain("child-notes.md");
      expect(run?.progress.validationAttempts).toEqual([
        expect.objectContaining({
          command: validationCommand,
          status: "failed",
          exitCode: 1,
          outputSummary: expect.stringContaining("expected insights notification"),
        }),
      ]);
      const failureHandoff = (run?.metadata as any)?.failureHandoff;
      expect(failureHandoff).toMatchObject({
        status: "recoverable_artifacts",
        error: "Provider zai stream failed: 429 1305",
        confidence: "low",
        changedFiles: ["child-notes.md"],
        blockers: [
          "Provider zai stream failed: 429 1305",
          `Validation failed: ${validationCommand}`,
        ],
        lastValidationAttempt: expect.objectContaining({
          command: validationCommand,
          status: "failed",
          exitCode: 1,
          outputSummary: expect.stringContaining("expected insights notification"),
        }),
      });
      expect((run?.metadata as any)?.workspaceHandoff).toMatchObject({
        status: "captured",
        changed: true,
        changedFiles: ["child-notes.md"],
      });
      const patchPath = (run?.metadata as any)?.workspaceHandoff?.patchPath;
      expect(patchPath).toContain(path.join("openpond-test-attachments", "subagents"));
      await expect(readFile(patchPath, "utf8")).resolves.toContain("child-notes.md");
      expect(harness.events.some((event) => event.name === "subagent.failed" && event.sessionId === "session_1")).toBe(true);
      expect(harness.events.some((event) => event.name === "subagent.submitted" && event.sessionId === "session_1")).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

});
