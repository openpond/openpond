import { describe, expect, test } from "vitest";
import type { ModelUsageRecord, Session, Turn } from "@openpond/contracts";
import { startProviderRequestUsageRecorder } from "../apps/server/src/runtime/model-usage-recorder";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";

describe("model usage recorder", () => {
  test("writes a started row and completes it with normalized provider usage", async () => {
    const rows: ModelUsageRecord[] = [];
    const recorder = await startProviderRequestUsageRecorder({
      session: usageSession(),
      turn: usageTurn({
        metadata: {
          usageAttribution: {
            surface: "chat",
            workflowKind: "slash_command",
            commandName: "/skill",
            commandSource: "composer_selection",
          },
        },
      }),
      provider: "openrouter",
      model: "test/model",
      requestId: "turn_usage:model:0",
      requestOrdinal: 0,
      upsert: async (record) => {
        const index = rows.findIndex((candidate) => candidate.requestId === record.requestId);
        if (index === -1) rows.push(record);
        else rows[index] = record;
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requestId: "turn_usage:model:0",
      status: "started",
      completedAt: null,
      durationMs: null,
      source: "missing",
    });

    recorder.observeDelta({ text: "hello" });
    recorder.observeDelta({ usage: { input_tokens: 30, output_tokens: 12 } });
    await recorder.complete();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "completed",
      source: "provider_usage",
      route: "local_byok",
      promptTokens: 30,
      completionTokens: 12,
      totalTokens: 42,
      requestKind: "slash_command",
      attribution: {
        commandName: "/skill",
        commandSource: "composer_selection",
        workflowKind: "slash_command",
      },
    });
    expect(rows[0]?.firstTokenMs).not.toBeNull();
    expect(rows[0]?.completedAt).not.toBeNull();
  });

  test("does not create duplicate rows when a stream finalizer completes twice", async () => {
    const rows: ModelUsageRecord[] = [];
    const recorder = await startProviderRequestUsageRecorder({
      session: usageSession(),
      turn: usageTurn(),
      provider: "openrouter",
      model: "test/model",
      requestId: "turn_usage:model:double-finalizer",
      requestOrdinal: 0,
      upsert: async (record) => {
        const index = rows.findIndex((candidate) => candidate.requestId === record.requestId);
        if (index === -1) rows.push(record);
        else rows[index] = record;
      },
    });

    recorder.observeDelta({ text: "hello" });
    recorder.observeDelta({ usage: { prompt_tokens: 18, completion_tokens: 7, total_tokens: 25 } });
    await recorder.complete();
    await recorder.complete();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requestId: "turn_usage:model:double-finalizer",
      status: "completed",
      source: "provider_usage",
      promptTokens: 18,
      completionTokens: 7,
      totalTokens: 25,
    });
  });

  test("marks failed requests without token frames as missing usage", async () => {
    const rows: ModelUsageRecord[] = [];
    const recorder = await startProviderRequestUsageRecorder({
      session: usageSession(),
      turn: usageTurn(),
      provider: "openpond",
      model: "openpond-chat",
      requestId: "turn_usage:model:1",
      requestOrdinal: 1,
      upsert: async (record) => {
        rows.push(record);
      },
    });

    await recorder.fail(new TypeError("provider failed"), "failed");

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      status: "failed",
      source: "missing",
      route: "openpond_hosted",
      requestKind: "tool_loop",
      errorType: "TypeError",
      errorMessage: "provider failed",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
  });

  test("records create planner rows with model-tool command attribution", async () => {
    const rows: ModelUsageRecord[] = [];
    const recorder = await startProviderRequestUsageRecorder({
      session: usageSession(),
      turn: usageTurn({
        createImproveRun: usageCreateImproveRun(),
      }),
      provider: "openrouter",
      model: "test/model",
      requestId: "turn_usage:create-planner",
      requestOrdinal: 0,
      requestKind: "create_improve_planner",
      upsert: async (record) => {
        const index = rows.findIndex((candidate) => candidate.requestId === record.requestId);
        if (index === -1) rows.push(record);
        else rows[index] = record;
      },
    });

    recorder.observeDelta({ text: "{\"decision\":\"plan\"" });
    recorder.observeDelta({ usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } });
    await recorder.complete();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requestId: "turn_usage:create-planner",
      requestKind: "create_improve_planner",
      visibility: "background",
      source: "provider_usage",
      totalTokens: 50,
      attribution: {
        surface: "create_improve",
        workflowKind: "planner",
        createImproveRunId: "create_improve_usage",
        commandName: "/create",
        commandSource: "model_tool",
      },
    });
  });

  test("records session-level background usage without a turn", async () => {
    const rows: ModelUsageRecord[] = [];
    const recorder = await startProviderRequestUsageRecorder({
      session: usageSession(),
      turn: null,
      provider: "openpond",
      model: "openpond-chat",
      requestId: "session_usage:context-compaction:manual",
      requestOrdinal: 0,
      requestKind: "context_compaction",
      upsert: async (record) => {
        const index = rows.findIndex((candidate) => candidate.requestId === record.requestId);
        if (index === -1) rows.push(record);
        else rows[index] = record;
      },
    });

    recorder.observeDelta({ text: "summary" });
    recorder.observeDelta({ usage: { prompt_tokens: 70, completion_tokens: 8, total_tokens: 78 } });
    await recorder.complete();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "session_usage",
      turnId: null,
      requestKind: "context_compaction",
      visibility: "background",
      source: "provider_usage",
      totalTokens: 78,
      attribution: {
        surface: "compaction",
        workflowKind: "summary",
        sessionId: "session_usage",
        turnId: null,
      },
    });
  });

  test("classifies explicit subagent usage attribution as background subagent work", async () => {
    const rows: ModelUsageRecord[] = [];
    const recorder = await startProviderRequestUsageRecorder({
      session: usageSession({ id: "session_child_subagent" }),
      turn: usageTurn({
        id: "turn_child_subagent",
        sessionId: "session_child_subagent",
        metadata: {
          usageAttribution: {
            surface: "goal",
            workflowKind: "subagent",
            goalId: "goal_usage",
            subagentRunId: "run_usage_research",
            subagentRoleId: "research",
          },
        },
      }),
      provider: "openrouter",
      model: "test/model",
      requestId: "turn_child_subagent:model:0",
      requestOrdinal: 0,
      upsert: async (record) => {
        const index = rows.findIndex((candidate) => candidate.requestId === record.requestId);
        if (index === -1) rows.push(record);
        else rows[index] = record;
      },
    });

    recorder.observeDelta({ text: "research report" });
    recorder.observeDelta({ usage: { prompt_tokens: 44, completion_tokens: 11, total_tokens: 55 } });
    await recorder.complete();

    expect(rows[0]).toMatchObject({
      requestKind: "subagent",
      visibility: "background",
      totalTokens: 55,
      attribution: {
        surface: "goal",
        workflowKind: "subagent",
        sessionId: "session_child_subagent",
        turnId: "turn_child_subagent",
        goalId: "goal_usage",
        subagentRunId: "run_usage_research",
        subagentRoleId: "research",
      },
    });
  });
});

function usageSession(patch: Partial<Session> = {}): Session {
  return {
    id: "session_usage",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    title: "Usage",
    appId: null,
    appName: null,
    workspaceKind: "local_project",
    workspaceId: "project_usage",
    workspaceName: "Project",
    localProjectId: "project_usage",
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/tmp/openpond",
    codexThreadId: null,
    createdAt: "2026-07-04T10:00:00.000Z",
    updatedAt: "2026-07-04T10:00:00.000Z",
    status: "active",
    pinned: false,
    archived: false,
    order: 0,
    ...patch,
  };
}

function usageTurn(patch: Partial<Turn> = {}): Turn {
  return {
    id: "turn_usage",
    sessionId: "session_usage",
    providerTurnId: null,
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    prompt: "hello",
    startedAt: "2026-07-04T10:00:00.000Z",
    completedAt: null,
    status: "in_progress",
    error: null,
    metadata: {},
    createImproveRun: null,
    ...patch,
  };
}

function usageCreateImproveRun() {
  return createImproveRunFixture({
    id: "create_improve_usage",
    scope: {
      profileId: "default",
      conversationId: "session_usage",
      originTurnId: "turn_usage",
      workItemId: null,
      projectId: "project_usage",
      targetProject: null,
    },
    metadata: { source: "native_model_tool" },
  });
}
