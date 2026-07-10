import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBackgroundWorkerQueue } from "../apps/server/src/runtime/background-worker-queue";
import { createSubagentLifecycleWatcher } from "../apps/server/src/runtime/subagent-lifecycle-watcher";
import { createTurnRunner } from "../apps/server/src/runtime/turn-runner";
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

describe("turn runner subagent native tools", () => {
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

function createSubagentHarness(input: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  preferences: AppPreferences;
  initialEvents?: RuntimeEvent[];
  initialTurns?: Turn[];
  initialRuns?: SubagentRun[];
  initialUsageRecords?: ModelUsageRecord[];
  sessionOverrides?: Partial<Session>;
  applyWorkspaceWrites?: boolean;
  writeOnChildReport?: {
    roleId: string;
    path: string;
    content: string;
  };
  usageBySessionId?: Record<string, unknown>;
  textBySessionId?: Record<string, string[]>;
  forceStoredChildTurnFailureAfterComplete?: string;
  onStreamInput?: (
    streamInput: any,
    context: {
      streamPass: number;
      requestTurn: Turn | undefined;
      requestSession: Session | null;
      events: RuntimeEvent[];
      runs: SubagentRun[];
      injectedFlags: Record<string, boolean>;
    },
  ) => void | Promise<void>;
  toolCallForStream?: (
    streamInput: any,
    context: {
      streamPass: number;
      requestTurn: Turn | undefined;
      requestSession: Session | null;
      events: RuntimeEvent[];
      runs: SubagentRun[];
      injectedFlags: Record<string, boolean>;
    },
  ) => { name: string; args: Record<string, unknown>; id?: string } | null | Promise<{ name: string; args: Record<string, unknown>; id?: string } | null>;
  workspaceToolResultForRequest?: (input: {
    sessionId: string;
    request: any;
  }) => WorkspaceToolResult | null | Promise<WorkspaceToolResult | null>;
  executeOpenPondCommand?: (input: {
    command: string;
    cwd?: string | null;
    timeoutSeconds?: number | null;
  }) => Promise<{
    ok: boolean;
    command: string;
    cwd: string | null;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    timeoutSeconds: number;
    truncated: boolean;
    blockedReason: string | null;
  }>;
  maxHostedWorkspaceToolRounds?: number;
  disableDefaultToolCall?: boolean;
  enableWebSearchTool?: boolean;
  integrationConnections?: ConnectedAppConnectionLike[];
  forkSandboxForSubagent?: (input: {
    sandboxId: string;
    payload: Record<string, unknown>;
    parentSession: Session;
    role: AppPreferences["subagents"]["roles"][number];
    runId: string;
  }) => Promise<unknown>;
  cleanupSandboxForSubagent?: (input: {
    sandboxId: string;
    run: SubagentRun;
  }) => Promise<unknown>;
}) {
  const sessions = new Map<string, Session>([
    ["session_1", baseSession(input.sessionOverrides)],
  ]);
  const turns: Turn[] = [...(input.initialTurns ?? [])];
  const events: RuntimeEvent[] = [...(input.initialEvents ?? [])];
  const approvals: Approval[] = [];
  const runs: SubagentRun[] = [...(input.initialRuns ?? [])];
  const messages: SubagentMessage[] = [];
  const usageRecords: ModelUsageRecord[] = [...(input.initialUsageRecords ?? [])];
  const workspaceRequests: Array<{ sessionId: string; request: any }> = [];
  const sandboxForkRequests: Array<{
    sandboxId: string;
    payload: Record<string, unknown>;
    parentSession: Session;
    role: AppPreferences["subagents"]["roles"][number];
    runId: string;
  }> = [];
  const sandboxCleanupRequests: Array<{
    sandboxId: string;
    run: SubagentRun;
  }> = [];
  const streamInputs: any[] = [];
  let streamPass = 0;
  const injectedFlags: Record<string, boolean> = {};
  const subagentQueue = createBackgroundWorkerQueue({ queueId: "subagent-test" });
  const turnFollowUpQueue = createBackgroundWorkerQueue({ queueId: "turn-follow-up-subagent-test" });

  const runner = createTurnRunner({
    attachmentRootDir: "/tmp/openpond-test-attachments",
    store: {
      async snapshot() {
        return { events, turns };
      },
      async getTurn(turnId) {
        return turns.find((turn) => turn.id === turnId) ?? null;
      },
      async insertTurn(turn) {
        turns.push(turn);
      },
      async updateTurn(turnId, updater) {
        const index = turns.findIndex((turn) => turn.id === turnId);
        if (index === -1) return null;
        turns[index] = updater(turns[index]!);
        return turns[index]!;
      },
      async getApproval(approvalId) {
        return approvals.find((approval) => approval.id === approvalId) ?? null;
      },
      async upsertModelUsageRecord(record) {
        const parsed = ModelUsageRecordSchema.parse(record);
        const index = usageRecords.findIndex((candidate) => candidate.requestId === parsed.requestId);
        if (index === -1) usageRecords.push(parsed);
        else usageRecords[index] = parsed;
        return parsed;
      },
      async listModelUsageRecords(query = {}) {
        return usageRecords.filter((record) => {
          if (query.sessionId && record.sessionId !== query.sessionId) return false;
          if (query.turnId && record.turnId !== query.turnId) return false;
          if (query.visibility && query.visibility !== "all" && record.visibility !== query.visibility) return false;
          if (query.status && query.status !== "all") {
            if (query.status === "missing") {
              if (record.source !== "missing") return false;
            } else if (record.status !== query.status) {
              return false;
            }
          }
          return true;
        }).slice(0, query.limit ?? 1000);
      },
      async upsertSubagentRun(run) {
        const parsed = SubagentRunSchema.parse(run);
        const index = runs.findIndex((candidate) => candidate.id === parsed.id);
        if (index === -1) runs.push(parsed);
        else runs[index] = parsed;
        return parsed;
      },
      async getSubagentRun(runId) {
        return runs.find((run) => run.id === runId) ?? null;
      },
      async listSubagentRuns(query = {}) {
        return runs.filter((run) => {
          if (query.parentSessionId && run.parentSessionId !== query.parentSessionId) return false;
          if (query.parentGoalId && run.parentGoalId !== query.parentGoalId) return false;
          if (query.childSessionId && run.childSessionId !== query.childSessionId) return false;
          if (query.status) {
            const statuses = Array.isArray(query.status) ? query.status : [query.status];
            if (!statuses.includes(run.status)) return false;
          }
          return true;
        }).slice(0, query.limit ?? 1000);
      },
      async appendSubagentMessage(message) {
        messages.push(message);
        return message;
      },
      async listSubagentMessages(query = {}) {
        return messages.filter((message) => {
          if (query.parentGoalId && message.parentGoalId !== query.parentGoalId) return false;
          if (query.fromRunId && message.fromRunId !== query.fromRunId) return false;
          if (query.toRunId && message.toRunId !== query.toRunId) return false;
          if (query.toRole && message.toRole !== query.toRole) return false;
          return true;
        }).slice(0, query.limit ?? 1000);
      },
    },
    upsertApproval: async (approval) => {
      const index = approvals.findIndex((candidate) => candidate.id === approval.id);
      if (index === -1) approvals.push(approval);
      else approvals[index] = approval;
    },
    createSession: async (payload) => {
      const record = payload as Partial<Session>;
      const session = baseSession({
        id: `session_${sessions.size + 1}`,
        provider: record.provider ?? "openrouter",
        modelRef: record.modelRef,
        openPondCommandAccessMode: record.openPondCommandAccessMode,
        hiddenFromDefaultSidebar: record.hiddenFromDefaultSidebar,
        parentSessionId: record.parentSessionId,
        parentTurnId: record.parentTurnId,
        parentGoalId: record.parentGoalId,
        subagentRunId: record.subagentRunId,
        subagentRoleId: record.subagentRoleId,
        title: record.title ?? "Child session",
        appId: record.appId ?? null,
        appName: record.appName ?? null,
        workspaceKind: record.workspaceKind,
        workspaceId: record.workspaceId ?? null,
        workspaceName: record.workspaceName ?? null,
        localProjectId: record.localProjectId ?? null,
        cloudProjectId: record.cloudProjectId ?? null,
        cloudTeamId: record.cloudTeamId ?? null,
        metadata: record.metadata,
        cwd: record.cwd ?? null,
      });
      sessions.set(session.id, session);
      return session;
    },
    getSession: async (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      return session;
    },
    updateSession: async (sessionId, patch) => {
      const current = sessions.get(sessionId);
      if (!current) throw new Error(`unknown session ${sessionId}`);
      const next = { ...current, ...patch };
      sessions.set(sessionId, next);
      return next;
    },
    completeTurn: async (sessionId, turnId, providerTurnId = null) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn) throw new Error("turn not found");
      const session = sessions.get(sessionId);
      Object.assign(turn, {
        providerTurnId,
        completedAt: "2026-07-07T10:00:01.000Z",
        status: "completed",
      });
      if (session) sessions.set(sessionId, { ...session, status: "idle" });
      const completed = { ...turn };
      if (session?.subagentRunId && input.forceStoredChildTurnFailureAfterComplete) {
        Object.assign(turn, {
          completedAt: "2026-07-07T10:00:02.000Z",
          status: "failed",
          error: input.forceStoredChildTurnFailureAfterComplete,
        });
        sessions.set(sessionId, { ...session, status: "failed" });
      }
      return completed;
    },
    failTurn: async (_session, turnId, message) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn) throw new Error("turn not found");
      Object.assign(turn, { status: "failed", error: message });
      return turn;
    },
    interruptTurn: async (_session, turnId) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn) throw new Error("turn not found");
      Object.assign(turn, { status: "interrupted" });
      return turn;
    },
    defaultSessionCwd: () => "/tmp/openpond",
    findOpenPondApp: async () => {
      throw new Error("no app lookup expected");
    },
    resolveSessionWorkspaceCwd: async () => null,
    ensureCodexRuntime: async () => {
      throw new Error("Codex runtime should not be used for BYOK providers");
    },
    appendWorkspaceDiffEvent: async () => undefined,
    workspaceDiffBaseline: async () => null,
    appendRuntimeEvent: async (event) => {
      events.push(event);
    },
    forkSandboxForSubagent: input.forkSandboxForSubagent
      ? async (request) => {
          sandboxForkRequests.push(request);
          return input.forkSandboxForSubagent!(request);
        }
      : undefined,
    cleanupSandboxForSubagent: input.cleanupSandboxForSubagent
      ? async (request) => {
          sandboxCleanupRequests.push(request);
          return input.cleanupSandboxForSubagent!(request);
        }
      : undefined,
    executeWorkspaceTool: async (sessionId, request) => {
      workspaceRequests.push({ sessionId, request });
      const customResult = await input.workspaceToolResultForRequest?.({ sessionId, request });
      if (customResult) return customResult;
      if (input.applyWorkspaceWrites && request.action === "write_file") {
        const session = sessions.get(sessionId);
        const filePath = typeof request.args?.path === "string" ? request.args.path : null;
        const content = typeof request.args?.content === "string" ? request.args.content : "";
        if (!session?.cwd || !filePath) throw new Error("write_file test request is missing cwd or path");
        await writeFile(path.join(session.cwd, filePath), content, "utf8");
      }
      return {
        ok: true,
        action: request.action,
        output: "workspace tool executed",
      };
    },
    executeOpenPondCommand: input.executeOpenPondCommand
      ? async (request) => input.executeOpenPondCommand!({
          command: request.command,
          cwd: request.cwd ?? null,
          timeoutSeconds: request.timeoutSeconds ?? null,
        })
      : undefined,
    executeWebSearch: input.enableWebSearchTool
      ? async () => ({
          query: "fallback",
          provider: "test",
          searchedAt: "2026-07-07T10:00:00.000Z",
          results: [],
          truncated: false,
        })
      : undefined,
    loadPersonalizationSoul: async () => "",
    loadAppPreferences: async () => input.preferences,
    maybeCreateScaffoldForTurn: async (nextSession) => nextSession,
    hostedSystemPrompt: async (_base, _soul, _session, options) =>
      ["System prompt", options?.extraSystemContext].filter(Boolean).join("\n\n"),
    appendAssistantText: async (nextSession, turnId, text) => {
      events.push({
        id: `assistant_${events.length}`,
        sessionId: nextSession.id,
        turnId,
        name: "assistant.delta",
        timestamp: "2026-07-07T10:00:00.000Z",
        source: "provider",
        output: text,
      });
    },
    appendHostedContextUsage: async () => undefined,
    listIntegrationConnections: input.integrationConnections
      ? async () => ({
          teamId: null,
          connections: input.integrationConnections!,
        })
      : undefined,
    streamLocalByokChatTurn: async function* (streamInput) {
      streamInputs.push(streamInput);
      streamPass += 1;
      const requestTurn = turns.find((candidate) => candidate.id === streamInput.requestId);
      const requestSession = requestTurn?.sessionId ? sessions.get(requestTurn.sessionId) : null;
      await input.onStreamInput?.(streamInput, {
        streamPass,
        requestTurn,
        requestSession: requestSession ?? null,
        events,
        runs,
        injectedFlags,
      });
      const scriptedToolCall = await input.toolCallForStream?.(streamInput, {
        streamPass,
        requestTurn,
        requestSession: requestSession ?? null,
        events,
        runs,
        injectedFlags,
      });
      if (scriptedToolCall) {
        yield {
          toolCalls: [
            {
              index: 0,
              id: scriptedToolCall.id ?? `call_${scriptedToolCall.name}_${streamPass}`,
              type: "function",
              function: {
                name: scriptedToolCall.name,
                arguments: JSON.stringify(scriptedToolCall.args),
              },
            },
          ],
          raw: { pass: streamPass, scriptedToolCall: true },
        };
        yield { finishReason: "tool_calls", raw: { pass: streamPass, scriptedToolCall: true } };
        return;
      }
      const scripted = requestTurn?.sessionId
        ? input.textBySessionId?.[requestTurn.sessionId] ??
          (requestSession?.subagentRoleId ? input.textBySessionId?.[`role:${requestSession.subagentRoleId}`] : null)
        : null;
      if (scripted?.length) {
        const text = scripted.shift() ?? "";
        if (
          input.writeOnChildReport &&
          scripted.length === 0 &&
          requestSession?.subagentRoleId === input.writeOnChildReport.roleId
        ) {
          if (!requestSession.cwd) throw new Error("scripted child write is missing cwd");
          await writeFile(
            path.join(requestSession.cwd, input.writeOnChildReport.path),
            input.writeOnChildReport.content,
            "utf8",
          );
        }
        yield { text, raw: { pass: streamPass, scripted: true } };
        const usage = requestTurn?.sessionId ? input.usageBySessionId?.[requestTurn.sessionId] : null;
        if (usage) yield { usage, raw: { pass: streamPass, scripted: true, usage: true } };
        return;
      }
      if (!input.disableDefaultToolCall && streamPass === 1) {
        yield {
          toolCalls: [
            {
              index: 0,
              id: "call_subagent",
              type: "function",
              function: {
                name: input.toolName,
                arguments: JSON.stringify(input.toolArgs),
              },
            },
          ],
          raw: { pass: 1 },
        };
        yield { finishReason: "tool_calls", raw: { pass: 1 } };
        return;
      }
      yield { text: "Subagent tool handled.", raw: { pass: streamPass } };
      const usage = requestTurn?.sessionId ? input.usageBySessionId?.[requestTurn.sessionId] : null;
      if (usage) yield { usage, raw: { pass: streamPass, usage: true } };
    },
    turnFollowUpQueue,
    subagentQueue,
    enableGoalContinuations: false,
    maxHostedWorkspaceToolRounds: input.maxHostedWorkspaceToolRounds ?? 3,
    maxRepeatedInvalidToolRequests: 2,
  });

  return {
    runner,
    sessions,
    turns,
    events,
    approvals,
    runs,
    messages,
    usageRecords,
    workspaceRequests,
    sandboxForkRequests,
    sandboxCleanupRequests,
    streamInputs,
    subagentQueue,
    turnFollowUpQueue,
  };
}

type SubagentRunListQuery = {
  parentSessionId?: string | null;
  parentGoalId?: string | null;
  childSessionId?: string | null;
  status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
  limit?: number;
};

const WATCHER_INTEGRATION_ACTIVE_STATUSES: readonly SubagentRun["status"][] = [
  "queued",
  "running",
  "blocked",
  "submitted_for_review",
  "needs_revision",
  "needs_user_input",
  "failed_with_artifacts",
  "needs_resume",
];

function subagentWatcherStoreForHarness(harness: ReturnType<typeof createSubagentHarness>) {
  return {
    listSubagentRuns: async (query: SubagentRunListQuery = {}) => listHarnessSubagentRuns(harness.runs, query),
    listActiveSubagentRuns: async (query: SubagentRunListQuery = {}) =>
      listHarnessSubagentRuns(harness.runs, {
        ...query,
        status: query.status ?? WATCHER_INTEGRATION_ACTIVE_STATUSES,
      }),
    listStaleSubagentRuns: async (
      query: SubagentRunListQuery & { olderThanMs: number; nowIso?: string | null },
    ) => {
      const nowMs = Date.parse(query.nowIso ?? new Date().toISOString());
      return listHarnessSubagentRuns(harness.runs, {
        ...query,
        status: query.status ?? WATCHER_INTEGRATION_ACTIVE_STATUSES,
      }).filter((run) => nowMs - subagentRunUpdatedAtMs(run) >= query.olderThanMs);
    },
    turnsForSession: async (sessionId: string, limit = 100) =>
      harness.turns.filter((turn) => turn.sessionId === sessionId).slice(-limit),
  };
}

function listHarnessSubagentRuns(runs: SubagentRun[], query: SubagentRunListQuery = {}): SubagentRun[] {
  const statuses = query.status
    ? new Set(Array.isArray(query.status) ? query.status : [query.status])
    : null;
  return runs.filter((run) => {
    if (query.parentSessionId !== undefined && query.parentSessionId !== null && run.parentSessionId !== query.parentSessionId) {
      return false;
    }
    if (query.parentGoalId !== undefined && (run.parentGoalId ?? null) !== (query.parentGoalId ?? null)) {
      return false;
    }
    if (query.childSessionId !== undefined && query.childSessionId !== null && run.childSessionId !== query.childSessionId) {
      return false;
    }
    if (statuses && !statuses.has(run.status)) return false;
    return true;
  }).slice(0, query.limit ?? 1000);
}

function subagentRunUpdatedAtMs(run: SubagentRun): number {
  const parsed = Date.parse(run.updatedAt ?? run.completedAt ?? run.startedAt ?? run.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
  }
}

async function withTimeout<T>(promise: Promise<T>, message: string, ms = 3000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function preferences(patch: Record<string, unknown> = {}): AppPreferences {
  return AppPreferencesSchema.parse({
    defaultChatProvider: "openrouter",
    defaultChatModel: "test/model",
    defaultChatModelRef: { providerId: "openrouter", modelId: "test/model" },
    ...patch,
  });
}

function preferencesWithSubagentRole(roleId: string, patch: Record<string, unknown>): AppPreferences {
  const base = preferences();
  return AppPreferencesSchema.parse({
    ...base,
    subagents: {
      ...base.subagents,
      roles: base.subagents.roles.map((role) => role.id === roleId ? { ...role, ...patch } : role),
    },
  });
}

function turnFixture(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn_fixture",
    sessionId: "session_1",
    providerTurnId: null,
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    prompt: "Fixture turn",
    startedAt: "2026-07-07T09:00:00.000Z",
    completedAt: "2026-07-07T09:01:00.000Z",
    status: "completed",
    error: null,
    metadata: {},
    createPipelineRequest: null,
    createPipeline: null,
    ...overrides,
  };
}

function usageRecord(patch: Partial<ModelUsageRecord>): ModelUsageRecord {
  const { attribution, ...rest } = patch;
  return ModelUsageRecordSchema.parse({
    id: "usage_record",
    requestId: "usage_record",
    requestOrdinal: 0,
    sessionId: "session_child",
    turnId: "turn_child",
    provider: "openrouter",
    model: "test/model",
    route: "local_byok",
    source: "provider_usage",
    requestKind: "subagent",
    visibility: "background",
    status: "completed",
    startedAt: "2026-07-07T09:00:01.000Z",
    completedAt: "2026-07-07T09:00:02.000Z",
    durationMs: 1000,
    firstTokenMs: 10,
    promptTokens: 20,
    completionTokens: 20,
    totalTokens: 40,
    errorType: null,
    errorMessage: null,
    attribution: {
      surface: "goal",
      workflowKind: "subagent",
      sessionId: "session_child",
      turnId: "turn_child",
      insightRunId: null,
      goalId: "goal_1",
      subagentRunId: "run_child",
      subagentRoleId: "research",
      createPipelineRequestId: null,
      createPipelineId: null,
      commandName: null,
      commandSource: null,
      appId: null,
      workspaceKind: "local_project",
      workspaceId: null,
      localProjectId: null,
      cloudProjectId: null,
      sourceEventSequence: null,
      ...(attribution ?? {}),
    },
    ...rest,
  });
}

function activeGoalEvent(): RuntimeEvent {
  return {
    id: "goal_event",
    sessionId: "session_1",
    turnId: "turn_prior",
    name: "diagnostic",
    timestamp: "2026-07-07T09:59:00.000Z",
    source: "provider",
    status: "completed",
    output: "Ship subagent orchestration.",
    data: {
      kind: "thread_goal",
      provider: "openpond",
      goal: {
        id: "goal_1",
        provider: "openpond",
        objective: "Ship subagent orchestration.",
        status: "running",
        mode: "local",
        timeUsedSeconds: 20,
        tokensUsed: 100,
      },
    },
  };
}

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    openPondCommandAccessMode: "ask",
    title: "BYOK chat",
    appId: null,
    appName: null,
    workspaceKind: "local_project",
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/tmp/openpond",
    codexThreadId: null,
    createdAt: "2026-07-07T10:00:00.000Z",
    updatedAt: "2026-07-07T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}
