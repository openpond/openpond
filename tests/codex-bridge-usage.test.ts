import { describe, expect, test } from "bun:test";
import type { CodexNotification } from "@openpond/codex-provider";
import type { ModelUsageRecord, RuntimeEvent, Session, Turn } from "@openpond/contracts";
import type { SqliteStore } from "../apps/server/src/store/store";
import { createBackgroundWorkerQueue } from "../apps/server/src/runtime/background-worker-queue";
import { createCodexBridge } from "../apps/server/src/runtime/codex-bridge";

describe("codex bridge usage ledger", () => {
  test("records Codex token usage notifications as context usage rows", async () => {
    const queue = createBackgroundWorkerQueue({ queueId: "codex-usage-ingestion" });
    const events: RuntimeEvent[] = [];
    const usageRecords: ModelUsageRecord[] = [];
    const session = codexSession();
    const turn = codexTurn();
    const bridge = createCodexBridge({
      store: {
        async snapshot() {
          return {
            sessions: [session],
            turns: [turn],
            events,
            approvals: [],
          };
        },
        async upsertModelUsageRecord(record: ModelUsageRecord) {
          usageRecords.push(record);
          return record;
        },
      } as unknown as SqliteStore,
      upsertApproval: async () => undefined,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      providerRuntimeIngestionQueue: queue,
    });

    const receipt = bridge.mapCodexNotification("session_codex", {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "codex_thread",
        turnId: "provider_turn",
        model: "gpt-5.3-codex",
        tokenUsage: {
          total: { totalTokens: 64000 },
          last: { totalTokens: 1200 },
          modelContextWindow: 128000,
        },
      },
    } as CodexNotification);

    expect(receipt.status).toBe("queued");
    await queue.drain();

    const usageEvent = events.find((event) => event.name === "session.context.updated");
    expect(usageEvent).toMatchObject({
      sessionId: "session_codex",
      turnId: "turn_codex",
      source: "provider",
    });
    expect(usageEvent?.data).toMatchObject({
      provider: "codex",
      model: "gpt-5.3-codex",
      usedTokens: 1200,
      maxContextTokens: 128000,
      source: "provider_usage",
    });

    expect(usageRecords).toHaveLength(1);
    expect(usageRecords[0]).toMatchObject({
      requestId: `codex:session_codex:context:${usageEvent?.id}`,
      sessionId: "session_codex",
      turnId: "turn_codex",
      provider: "codex",
      model: "gpt-5.3-codex",
      route: "codex_app_server",
      source: "codex_context_usage",
      requestKind: "codex_context",
      visibility: "background",
      status: "completed",
      promptTokens: null,
      completionTokens: null,
      totalTokens: 1200,
      attribution: {
        surface: "system",
        workflowKind: "other",
        sessionId: "session_codex",
        turnId: "turn_codex",
        appId: "app_codex",
        workspaceKind: "local_project",
        workspaceId: "workspace_codex",
        localProjectId: "project_codex",
      },
    });
  });
});

function codexSession(): Session {
  return {
    id: "session_codex",
    provider: "codex",
    modelRef: { providerId: "codex", modelId: "gpt-5.3-codex" },
    title: "Codex chat",
    appId: "app_codex",
    appName: "Codex App",
    workspaceKind: "local_project",
    workspaceId: "workspace_codex",
    workspaceName: "Codex Workspace",
    localProjectId: "project_codex",
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/tmp/openpond-codex",
    codexThreadId: "codex_thread",
    createdAt: "2026-07-04T10:00:00.000Z",
    updatedAt: "2026-07-04T10:00:00.000Z",
    status: "active",
    pinned: false,
    archived: false,
    order: 0,
  };
}

function codexTurn(): Turn {
  return {
    id: "turn_codex",
    sessionId: "session_codex",
    providerTurnId: "provider_turn",
    modelRef: { providerId: "codex", modelId: "gpt-5.3-codex" },
    prompt: "Use Codex",
    startedAt: "2026-07-04T10:01:00.000Z",
    completedAt: null,
    status: "in_progress",
    error: null,
    metadata: {},
    createPipelineRequest: null,
    createPipeline: null,
  };
}
