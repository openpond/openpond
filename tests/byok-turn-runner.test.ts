import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createBackgroundWorkerQueue } from "../apps/server/src/runtime/background-worker-queue";
import { createTurnRunner } from "../apps/server/src/runtime/turn-runner";
import { withTurnRunnerTestStore } from "./helpers/turn-runner-test-harness";
import { createContextUsageSnapshot } from "../apps/server/src/openpond/context-usage";
import {
  AppPreferencesSchema,
  ProviderSettingsSchema,
  emptyOpenPondProfileState,
  type Approval,
  type AppPreferences,
  type ModelUsageRecord,
  type ProviderSettings,
  type RuntimeEvent,
  type Session,
  type Turn,
} from "../packages/contracts/src";
import { runProfileSkillCommand, runProfileSkillGoalCommand } from "../packages/cloud/src/profile/profile-skill-mutations";
import { loadProfileSkills, readProfileSkill } from "../packages/cloud/src/profile/profile-skills";
import {
  baseSession,
  createNativeGoalControlHarness,
  deferred,
  hostedCompactionPriorEvents,
  openRouterProviderSettingsWithContextWindow,
} from "./helpers/byok-turn-runner-harness";

describe("BYOK turn runner dispatch", () => {
  test("omits workflow delegation tools for terminal one-shot turns", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      sessionOverrides: {
        workspaceKind: undefined,
        workspaceId: null,
        localProjectId: null,
        cwd: "/tmp/openpond-bench-task",
      },
      finalText: "One-shot task complete.",
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "write the task output file",
      metadata: { openpondTerminalMode: "one-shot" },
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const toolNames = harness.streamInputs[0].tools.map((tool: any) => tool.function.name);
    expect(toolNames).not.toContain("openpond_create_pipeline");
    expect(toolNames).not.toContain("openpond_goal_control");
    expect(toolNames).not.toContain("openpond_profile_skill_goal");
    expect(toolNames).toEqual(expect.arrayContaining(["resource_search", "resource_read"]));
  });

  test("records local BYOK provider usage frames in the model usage ledger", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      sessionOverrides: {
        appId: "app_usage",
        appName: "Usage App",
        workspaceKind: "local_project",
        workspaceId: "workspace_usage",
        workspaceName: "Usage Workspace",
        localProjectId: "project_usage",
        cloudProjectId: "cloud_project_usage",
      },
      finalText: "Done.",
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "answer directly",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.usageRecords).toHaveLength(1);
    const usage = harness.usageRecords[0]!;
    expect(usage).toMatchObject({
      sessionId: "session_1",
      turnId: turn.id,
      provider: "openrouter",
      model: "test/model",
      route: "local_byok",
      source: "provider_usage",
      requestKind: "chat_turn",
      visibility: "user_facing",
      status: "completed",
      requestOrdinal: 0,
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
      attribution: {
        surface: "chat",
        workflowKind: "direct_chat",
        sessionId: "session_1",
        turnId: turn.id,
        appId: "app_usage",
        workspaceKind: "local_project",
        workspaceId: "workspace_usage",
        localProjectId: "project_usage",
        cloudProjectId: "cloud_project_usage",
      },
    });
    expect(usage.firstTokenMs).not.toBeNull();
    expect("rawUsage" in usage).toBe(false);
  });

  test("records OpenPond hosted provider usage frames in the model usage ledger", async () => {
    const harness = createNativeGoalControlHarness({
      providerId: "openpond",
      modelId: "openpond-chat",
      toolArgs: null,
      finalText: "Hosted answer.",
      usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "answer through hosted",
      modelRef: { providerId: "openpond", modelId: "openpond-chat" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.usageRecords).toHaveLength(1);
    expect(harness.usageRecords[0]).toMatchObject({
      sessionId: "session_1",
      turnId: turn.id,
      provider: "openpond",
      model: "openpond-chat",
      route: "openpond_hosted",
      source: "provider_usage",
      requestKind: "chat_turn",
      visibility: "user_facing",
      status: "completed",
      requestOrdinal: 0,
      promptTokens: 21,
      completionTokens: 7,
      totalTokens: 28,
      attribution: {
        surface: "chat",
        workflowKind: "direct_chat",
        sessionId: "session_1",
        turnId: turn.id,
      },
    });
  });

  test("records hosted auto context compaction usage in the model usage ledger", async () => {
    const harness = createNativeGoalControlHarness({
      providerId: "openpond",
      modelId: "openpond-1k",
      toolArgs: null,
      initialEvents: hostedCompactionPriorEvents(),
      finalText: "Hosted answer after compaction.",
      usageByPass: {
        1: { prompt_tokens: 90, completion_tokens: 14, total_tokens: 104 },
        2: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "answer after compaction",
      modelRef: { providerId: "openpond", modelId: "openpond-1k" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.events.some((event) => event.name === "session.compaction.started")).toBe(true);
    expect(harness.events.some((event) => event.name === "session.compaction.completed")).toBe(true);
    expect(harness.usageRecords).toHaveLength(2);

    const compactionUsage = harness.usageRecords.find((record) => record.requestKind === "context_compaction");
    expect(compactionUsage).toMatchObject({
      requestId: `${turn.id}:context-compaction:0`,
      requestOrdinal: 0,
      sessionId: "session_1",
      turnId: turn.id,
      provider: "openpond",
      model: "openpond-1k",
      route: "openpond_hosted",
      source: "provider_usage",
      requestKind: "context_compaction",
      visibility: "background",
      status: "completed",
      promptTokens: 90,
      completionTokens: 14,
      totalTokens: 104,
      attribution: {
        surface: "compaction",
        workflowKind: "summary",
        sessionId: "session_1",
        turnId: turn.id,
      },
    });
    expect(compactionUsage?.firstTokenMs).not.toBeNull();

    const chatUsage = harness.usageRecords.find((record) => record.requestKind === "chat_turn");
    expect(chatUsage).toMatchObject({
      requestId: `${turn.id}:model:0`,
      source: "provider_usage",
      visibility: "user_facing",
      totalTokens: 24,
    });
  });

  test("blocks hosted sends over the context limit when auto compaction is disabled", async () => {
    const harness = createNativeGoalControlHarness({
      providerId: "openpond",
      modelId: "openpond-1k",
      toolArgs: null,
      initialEvents: [
        ...hostedCompactionPriorEvents(),
        {
          id: "prior_large_assistant",
          sessionId: "session_1",
          turnId: "prior_large_turn",
          name: "assistant.delta",
          timestamp: "2026-07-03T09:20:00.000Z",
          source: "provider",
          output: "x".repeat(6000),
        },
      ],
      finalText: "Hosted answer without compaction.",
      usageByPass: {
        1: { prompt_tokens: 180, completion_tokens: 8, total_tokens: 188 },
      },
      preferences: AppPreferencesSchema.parse({
        contextCompaction: {
          autoEnabled: false,
        },
      }),
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "answer without compaction",
      modelRef: { providerId: "openpond", modelId: "openpond-1k" },
    });

    expect(turn.status).toBe("failed");
    expect(turn.error).toContain("Start a new chat or turn auto compaction on");
    expect(harness.events.some((event) => event.name === "session.compaction.started")).toBe(false);
    expect(harness.events.some((event) => event.name === "session.compaction.completed")).toBe(false);
    expect(harness.usageRecords).toHaveLength(0);
    expect(harness.streamInputs).toHaveLength(0);
  });

  test("auto compacts local BYOK context with the selected provider and model", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      initialEvents: hostedCompactionPriorEvents(),
      finalText: "BYOK answer after compaction.",
      usageByPass: {
        1: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 },
        2: { prompt_tokens: 22, completion_tokens: 5, total_tokens: 27 },
      },
      providerSettings: openRouterProviderSettingsWithContextWindow(2000),
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "answer after BYOK compaction",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.streamInputs).toHaveLength(2);
    expect(harness.streamInputs[0]).toMatchObject({
      providerId: "openrouter",
      modelId: "test/model",
      requestId: expect.stringMatching(/^compact-/),
    });
    expect(harness.streamInputs[0].tools).toBeUndefined();
    expect(harness.streamInputs[1]).toMatchObject({
      providerId: "openrouter",
      modelId: "test/model",
    });
    expect(harness.streamInputs[1].messages).toContainEqual(
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("Conversation summary from earlier turns"),
      }),
    );
    expect(JSON.stringify(harness.streamInputs[1].messages)).not.toContain(
      "We need to preserve the durable support workflow requirements.",
    );
    const completed = harness.events.find((event) => event.name === "session.compaction.completed");
    expect(completed?.data).toMatchObject({
      provider: "openrouter",
      model: "test/model",
      mode: "summary",
      maxContextTokens: 2000,
      summary: "BYOK answer after compaction.",
    });
    expect(harness.usageRecords.map((record) => record.requestKind)).toEqual([
      "context_compaction",
      "chat_turn",
    ]);
    expect(harness.usageRecords[0]).toMatchObject({
      provider: "openrouter",
      model: "test/model",
      route: "local_byok",
      requestKind: "context_compaction",
      visibility: "background",
      totalTokens: 90,
    });
  });

  test("preserves BYOK context and continues when summary compaction fails below the hard ceiling", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      initialEvents: hostedCompactionPriorEvents(),
      finalText: "BYOK answer after failed compaction.",
      failOnPass: 1,
      usageByPass: {
        2: { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 },
      },
      providerSettings: openRouterProviderSettingsWithContextWindow(2000),
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "answer after failed BYOK compaction",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.events.some((event) => event.name === "session.compaction.started")).toBe(true);
    const failed = harness.events.find((event) => event.name === "session.compaction.failed");
    expect(failed).toMatchObject({
      status: "failed",
      error: "stream failed on pass 1",
    });
    expect(harness.streamInputs).toHaveLength(2);
    expect(harness.streamInputs[1].messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: "answer after failed BYOK compaction",
      }),
    );
    expect(harness.usageRecords.map((record) => [record.requestKind, record.status])).toEqual([
      ["context_compaction", "failed"],
      ["chat_turn", "completed"],
    ]);
  });

  test("blocks local BYOK sends over a trusted context limit when auto compaction is disabled", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      initialEvents: [
        ...hostedCompactionPriorEvents(),
        {
          id: "prior_large_byok_assistant",
          sessionId: "session_1",
          turnId: "prior_large_byok_turn",
          name: "assistant.delta",
          timestamp: "2026-07-03T09:20:00.000Z",
          source: "provider",
          output: "x".repeat(6000),
        },
      ],
      preferences: AppPreferencesSchema.parse({
        contextCompaction: {
          autoEnabled: false,
        },
      }),
      providerSettings: openRouterProviderSettingsWithContextWindow(1000),
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "answer without BYOK compaction",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("failed");
    expect(turn.error).toContain("Start a new chat or turn auto compaction on");
    expect(harness.events.some((event) => event.name === "session.compaction.started")).toBe(false);
    expect(harness.streamInputs).toHaveLength(0);
    expect(harness.usageRecords).toHaveLength(0);
  });

  test("records local BYOK context usage when provider metadata includes a context window", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      finalText: "BYOK context measured.",
      usage: { prompt_tokens: 1200, completion_tokens: 50, total_tokens: 1250 },
      providerSettings: openRouterProviderSettingsWithContextWindow(10000),
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "measure local BYOK context",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const contextEvents = harness.events.filter((event) => event.name === "session.context.updated");
    expect(contextEvents).toHaveLength(2);
    expect(contextEvents.at(-1)?.data).toMatchObject({
      provider: "openrouter",
      model: "test/model",
      usedTokens: 1250,
      maxContextTokens: 10000,
      usableContextTokens: 2000,
      percentFull: 13,
      source: "provider_usage",
    });
    expect(harness.events.some((event) => event.name === "session.compaction.started")).toBe(false);
  });

  test("records Insights scan usage with system session attribution", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      sessionOverrides: {
        title: "Insights system session",
        systemKind: "openpond.insights",
        hiddenFromDefaultSidebar: true,
        workspaceKind: "local_project",
        workspaceId: "project_usage",
        localProjectId: "project_usage",
      },
      finalText: "Usage insight found.",
      usage: { prompt_tokens: 55, completion_tokens: 9, total_tokens: 64 },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "scan usage evidence",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      metadata: {
        insightsRun: {
          id: "insights_run_usage",
          trigger: "manual",
          sourceEventSequence: 123,
        },
        threadGoal: {
          id: "goal_insights_usage",
          provider: "openpond.insights",
          objective: "Find notable usage behavior.",
        },
      },
    });

    expect(turn.status).toBe("completed");
    expect(harness.usageRecords).toHaveLength(1);
    expect(harness.usageRecords[0]).toMatchObject({
      sessionId: "session_1",
      turnId: turn.id,
      provider: "openrouter",
      model: "test/model",
      route: "local_byok",
      source: "provider_usage",
      requestKind: "insights_scan",
      visibility: "system",
      status: "completed",
      promptTokens: 55,
      completionTokens: 9,
      totalTokens: 64,
      attribution: {
        surface: "insights",
        workflowKind: "scan",
        sessionId: "session_1",
        turnId: turn.id,
        insightRunId: "insights_run_usage",
        goalId: "goal_insights_usage",
        localProjectId: "project_usage",
        workspaceKind: "local_project",
        workspaceId: "project_usage",
        sourceEventSequence: 123,
      },
    });
  });

  test("records Insights question usage with distinct system attribution", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      sessionOverrides: {
        title: "Insights question session",
        systemKind: "openpond.insights",
        hiddenFromDefaultSidebar: true,
      },
      finalText: "The spike came from one model.",
      usage: { input_tokens: 24, output_tokens: 6 },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "answer the usage question",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      metadata: {
        insightsQuestion: {
          question: "Why did usage spike?",
          runCount: 2,
          insightCount: 1,
          startedAt: "2026-07-04T12:00:00.000Z",
        },
        threadGoal: {
          id: "goal_insights_question",
          provider: "openpond.insights",
          objective: "Answer an Insights question.",
        },
      },
    });

    expect(turn.status).toBe("completed");
    expect(harness.usageRecords).toHaveLength(1);
    expect(harness.usageRecords[0]).toMatchObject({
      sessionId: "session_1",
      turnId: turn.id,
      requestKind: "insights_question",
      visibility: "system",
      source: "provider_usage",
      promptTokens: 24,
      completionTokens: 6,
      totalTokens: 30,
      attribution: {
        surface: "insights",
        workflowKind: "scan",
        sessionId: "session_1",
        turnId: turn.id,
        insightRunId: null,
        goalId: "goal_insights_question",
      },
    });
  });

  test("records goal-control usage with thread-goal attribution", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      sessionOverrides: {
        workspaceKind: "local_project",
        workspaceId: "project_usage",
        localProjectId: "project_usage",
      },
      finalText: "Goal status updated.",
      usage: { prompt_tokens: 44, completion_tokens: 11, total_tokens: 55 },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "continue the usage tracking goal",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      metadata: {
        threadGoal: {
          id: "goal_usage_tracking",
          provider: "openpond",
          objective: "Implement usage tracking.",
          status: "active",
        },
      },
    });

    expect(turn.status).toBe("completed");
    expect(harness.usageRecords).toHaveLength(1);
    expect(harness.usageRecords[0]).toMatchObject({
      sessionId: "session_1",
      turnId: turn.id,
      provider: "openrouter",
      model: "test/model",
      route: "local_byok",
      source: "provider_usage",
      requestKind: "goal_control",
      visibility: "background",
      status: "completed",
      promptTokens: 44,
      completionTokens: 11,
      totalTokens: 55,
      attribution: {
        surface: "goal",
        workflowKind: "goal_control",
        sessionId: "session_1",
        turnId: turn.id,
        goalId: "goal_usage_tracking",
        localProjectId: "project_usage",
        workspaceKind: "local_project",
        workspaceId: "project_usage",
      },
    });
    expect(harness.events.some(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
    )).toBe(true);
  });

  test("records tool-loop follow-up requests with stable request ordinals", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: {
        action: "start",
        objective: "Track model usage carefully.",
        reason: "User asked to start a goal.",
      },
      finalText: "Goal started.",
      usageByPass: {
        1: { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 },
        2: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "start a goal to track usage",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.usageRecords.map((record) => record.requestId)).toEqual([
      `${turn.id}:model:0`,
      `${turn.id}:model:1`,
    ]);
    expect(harness.usageRecords.map((record) => record.requestOrdinal)).toEqual([0, 1]);
    expect(harness.usageRecords.map((record) => record.requestKind)).toEqual(["chat_turn", "tool_loop"]);
    expect(harness.usageRecords.map((record) => record.totalTokens)).toEqual([32, 45]);
    expect(harness.usageRecords[0]?.attribution.workflowKind).toBe("direct_chat");
    expect(harness.usageRecords[1]?.attribution.workflowKind).toBe("tool_loop");
    expect(harness.events.some((event) => event.name === "tool.completed" && event.action === "openpond_goal_control")).toBe(true);
  });

  test("replays ZAI preserved thinking with assistant tool calls", async () => {
    const reasoningContent = "I need to create the requested goal before I can report completion.";
    const harness = createNativeGoalControlHarness({
      providerId: "zai",
      modelId: "glm-5.2",
      toolArgs: {
        action: "start",
        objective: "Verify preserved thinking continuation.",
        reason: "Regression test for a multi-round tool turn.",
      },
      reasoningTextOnToolCall: reasoningContent,
      continuationOnToolCall: { kind: "chat_completions_reasoning", reasoningContent },
      finalText: "Goal started.",
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "start a goal to verify preserved thinking",
      modelRef: { providerId: "zai", modelId: "glm-5.2" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.streamInputs).toHaveLength(2);
    expect(harness.streamInputs[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: "",
        continuation: { kind: "chat_completions_reasoning", reasoningContent },
        tool_calls: expect.arrayContaining([
          expect.objectContaining({ id: "call_goal_control" }),
        ]),
      }),
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_goal_control",
      }),
    ]));
  });

  test("records failed provider requests in the usage ledger", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      failOnPass: 1,
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "this stream will fail",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("failed");
    expect(turn.error).toContain("stream failed on pass 1");
    expect(harness.usageRecords).toHaveLength(1);
    expect(harness.usageRecords[0]).toMatchObject({
      sessionId: "session_1",
      turnId: turn.id,
      provider: "openrouter",
      model: "test/model",
      route: "local_byok",
      source: "missing",
      requestKind: "chat_turn",
      status: "failed",
      requestOrdinal: 0,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      errorType: "Error",
      errorMessage: "stream failed on pass 1",
    });
    expect(harness.usageRecords[0]?.durationMs).not.toBeNull();
  });

  test("allows concurrent turns in different sessions while rejecting duplicate turns in one session", async () => {
    const sessions = new Map<string, Session>([
      ["session_1", baseSession()],
      ["session_2", baseSession({ id: "session_2", title: "Second BYOK chat" })],
    ]);
    const turns: Turn[] = [];
    const events: RuntimeEvent[] = [];
    const approvals: Approval[] = [];
    const firstStreamStarted = deferred();
    const secondStreamStarted = deferred();
    const releaseStreams = deferred();
    let streamStarts = 0;

    const runner = createTurnRunner({
      attachmentRootDir: "/tmp/openpond-test-attachments",
      store: withTurnRunnerTestStore({
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
      }),
      upsertApproval: async (approval) => {
        const index = approvals.findIndex((candidate) => candidate.id === approval.id);
        if (index === -1) approvals.push(approval);
        else approvals[index] = approval;
      },
      getSession: async (sessionId) => {
        const session = sessions.get(sessionId);
        if (!session) throw new Error(`session not found: ${sessionId}`);
        return session;
      },
      updateSession: async (sessionId, patch) => {
        const session = sessions.get(sessionId);
        if (!session) throw new Error(`session not found: ${sessionId}`);
        const next = { ...session, ...patch };
        sessions.set(sessionId, next);
        return next;
      },
      completeTurn: async (sessionId, turnId, providerTurnId = null) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, {
          providerTurnId,
          completedAt: "2026-06-30T10:00:01.000Z",
          status: "completed",
        });
        const session = sessions.get(sessionId);
        if (session) sessions.set(sessionId, { ...session, status: "idle" });
        return turn;
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
      executeWorkspaceTool: async () => {
        throw new Error("workspace tool execution should not be needed");
      },
      loadPersonalizationSoul: async () => "",
      maybeCreateScaffoldForTurn: async (nextSession) => nextSession,
      hostedSystemPrompt: async () => "System prompt",
      appendAssistantText: async (nextSession, turnId, text) => {
        events.push({
          id: `assistant_${events.length}`,
          sessionId: nextSession.id,
          turnId,
          name: "assistant.delta",
          timestamp: "2026-06-30T10:00:00.000Z",
          source: "provider",
          output: text,
        });
      },
      appendHostedContextUsage: async () => undefined,
      streamLocalByokChatTurn: async function* (input) {
        streamStarts += 1;
        if (streamStarts === 1) firstStreamStarted.resolve();
        if (streamStarts === 2) secondStreamStarted.resolve();
        await releaseStreams.promise;
        const turn = turns.find((candidate) => candidate.id === input.requestId);
        yield { text: `BYOK done ${turn?.sessionId ?? "unknown"}`, raw: { ok: true } };
      },
      turnFollowUpQueue: createBackgroundWorkerQueue({ queueId: "turn-follow-up-concurrent" }),
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    const firstTurnPromise = runner.sendTurn("session_1", {
      prompt: "first",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await firstStreamStarted.promise;

    await expect(
      runner.sendTurn("session_1", {
        prompt: "duplicate",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      }),
    ).rejects.toThrow("A turn is already running for this chat.");

    const secondTurnPromise = runner.sendTurn("session_2", {
      prompt: "second",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await secondStreamStarted.promise;

    releaseStreams.resolve();
    const [firstTurn, secondTurn] = await Promise.all([firstTurnPromise, secondTurnPromise]);

    expect(firstTurn.status).toBe("completed");
    expect(secondTurn.status).toBe("completed");
    expect(streamStarts).toBe(2);
    expect(turns.map((turn) => turn.prompt).sort()).toEqual(["first", "second"]);
    expect(events.some((event) => event.sessionId === "session_1" && event.output === "BYOK done session_1")).toBe(true);
    expect(events.some((event) => event.sessionId === "session_2" && event.output === "BYOK done session_2")).toBe(true);
  });

  test("allows a follow-up turn after interrupting a still-unwinding active turn", async () => {
    let session = baseSession();
    const turns: Turn[] = [];
    const events: RuntimeEvent[] = [];
    const approvals: Approval[] = [];
    const usageRecords: ModelUsageRecord[] = [];
    const firstStreamStarted = deferred();
    const secondStreamStarted = deferred();
    const releaseFirstStream = deferred();

    const runner = createTurnRunner({
      attachmentRootDir: "/tmp/openpond-test-attachments",
      store: withTurnRunnerTestStore({
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
          const index = usageRecords.findIndex((candidate) => candidate.requestId === record.requestId);
          if (index === -1) usageRecords.push(record);
          else usageRecords[index] = record;
          return record;
        },
      }),
      upsertApproval: async (approval) => {
        const index = approvals.findIndex((candidate) => candidate.id === approval.id);
        if (index === -1) approvals.push(approval);
        else approvals[index] = approval;
      },
      getSession: async () => session,
      updateSession: async (_sessionId, patch) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async (_sessionId, turnId, providerTurnId = null) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, {
          providerTurnId,
          completedAt: "2026-06-30T10:00:01.000Z",
          status: "completed",
        });
        session = { ...session, status: "idle" };
        return turn;
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
      executeWorkspaceTool: async () => {
        throw new Error("workspace tool execution should not be needed");
      },
      loadPersonalizationSoul: async () => "",
      maybeCreateScaffoldForTurn: async (nextSession) => nextSession,
      hostedSystemPrompt: async () => "System prompt",
      appendAssistantText: async (nextSession, turnId, text) => {
        events.push({
          id: `assistant_${events.length}`,
          sessionId: nextSession.id,
          turnId,
          name: "assistant.delta",
          timestamp: "2026-06-30T10:00:00.000Z",
          source: "provider",
          output: text,
        });
      },
      appendHostedContextUsage: async () => undefined,
      streamLocalByokChatTurn: async function* (input) {
        const turn = turns.find((candidate) => candidate.id === input.requestId);
        if (turn?.prompt === "first") {
          firstStreamStarted.resolve();
          await releaseFirstStream.promise;
        } else {
          secondStreamStarted.resolve();
        }
        yield { text: `BYOK done ${turn?.prompt ?? "unknown"}`, raw: { ok: true } };
        if (turn?.prompt === "second") {
          yield {
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
            raw: { ok: true, usage: true },
          };
        }
      },
      turnFollowUpQueue: createBackgroundWorkerQueue({ queueId: "turn-follow-up-interrupt" }),
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    const firstTurnPromise = runner.sendTurn("session_1", {
      prompt: "first",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await firstStreamStarted.promise;

    const interrupted = await runner.interruptSessionTurn("session_1");
    expect(interrupted.status).toBe("interrupted");

    const secondTurnPromise = runner.sendTurn("session_1", {
      prompt: "second",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await secondStreamStarted.promise;

    releaseFirstStream.resolve();
    const [firstTurn, secondTurn] = await Promise.all([firstTurnPromise, secondTurnPromise]);

    expect(firstTurn.status).toBe("interrupted");
    expect(secondTurn.status).toBe("completed");
    expect(turns.map((turn) => turn.prompt)).toEqual(["first", "second"]);
    expect(usageRecords).toHaveLength(2);

    const interruptedUsage = usageRecords.find((record) => record.turnId === firstTurn.id);
    expect(interruptedUsage).toMatchObject({
      requestId: `${firstTurn.id}:model:0`,
      sessionId: "session_1",
      turnId: firstTurn.id,
      provider: "openrouter",
      model: "test/model",
      route: "local_byok",
      source: "missing",
      requestKind: "chat_turn",
      visibility: "user_facing",
      status: "interrupted",
      requestOrdinal: 0,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      errorType: "AbortError",
      errorMessage: "Stopped by user",
      attribution: {
        surface: "chat",
        workflowKind: "direct_chat",
        sessionId: "session_1",
        turnId: firstTurn.id,
      },
    });
    expect(interruptedUsage?.durationMs).not.toBeNull();

    const completedUsage = usageRecords.find((record) => record.turnId === secondTurn.id);
    expect(completedUsage).toMatchObject({
      requestId: `${secondTurn.id}:model:0`,
      status: "completed",
      source: "provider_usage",
      promptTokens: 10,
      completionTokens: 3,
      totalTokens: 13,
    });
  });
});
