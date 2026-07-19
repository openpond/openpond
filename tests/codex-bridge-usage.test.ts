import { describe, expect, test } from "vitest";
import type { CodexNotification } from "@openpond/codex-provider";
import {
  SubagentRunSchema,
  type Approval,
  type ModelUsageRecord,
  type RuntimeEvent,
  type Session,
  type SubagentRun,
  type Turn,
} from "@openpond/contracts";
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
        async turnByProviderTurnId() { return turn; },
        async latestTurnForSession() { return turn; },
        async getSession() { return session; },
        async runtimeEventsForSession() { return events; },
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

  test("mirrors child approval waits and resolutions to parent subagent receipts", async () => {
    const queue = createBackgroundWorkerQueue({ queueId: "codex-approval-ingestion" });
    const events: RuntimeEvent[] = [];
    const approvals: Approval[] = [];
    const runs: SubagentRun[] = [
      subagentRun({
        id: "run_child",
        parentSessionId: "session_parent",
        parentTurnId: "turn_parent",
        parentGoalId: "goal_parent",
        childSessionId: "session_child",
        status: "running",
      }),
    ];
    const parentSession = codexSession({
      id: "session_parent",
      title: "Parent chat",
    });
    const childSession = codexSession({
      id: "session_child",
      title: "Research child",
      parentSessionId: "session_parent",
      parentTurnId: "turn_parent",
      parentGoalId: "goal_parent",
      subagentRunId: "run_child",
      subagentRoleId: "research",
      hiddenFromDefaultSidebar: true,
    });
    const bridge = createCodexBridge({
      store: {
        async getSession(sessionId: string) {
          return [parentSession, childSession].find((session) => session.id === sessionId) ?? null;
        },
        async getSubagentRun(runId: string) {
          return runs.find((run) => run.id === runId) ?? null;
        },
        async upsertSubagentRun(run: SubagentRun) {
          const parsed = SubagentRunSchema.parse(run);
          const index = runs.findIndex((candidate) => candidate.id === parsed.id);
          if (index === -1) runs.push(parsed);
          else runs[index] = parsed;
          return parsed;
        },
      } as unknown as SqliteStore,
      upsertApproval: async (approval) => {
        const index = approvals.findIndex((candidate) => candidate.id === approval.id);
        if (index === -1) approvals.push(approval);
        else approvals[index] = approval;
      },
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      providerRuntimeIngestionQueue: queue,
    });

    const pendingResult = bridge.handleCodexServerRequest("session_child", {
      id: "provider_request_1",
      method: "item/commandExecution/requestApproval",
      params: {
        turnId: "turn_child",
        command: "pnpm test tests/subagent-child-lifecycle.test.ts",
        reason: "Validate child subagent changes.",
      },
    } as any);
    await waitFor(() => events.some((event) => event.name === "subagent.progress" && event.sessionId === "session_parent"));

    expect(runs[0]).toMatchObject({
      status: "running",
      error: "Waiting for approval: pnpm test tests/subagent-child-lifecycle.test.ts",
      metadata: {
        pendingApproval: {
          sessionId: "session_child",
          status: "pending",
        },
      },
    });
    expect(events.find((event) => event.name === "subagent.progress" && event.sessionId === "session_parent")).toMatchObject({
      status: "pending",
      output: "Subagent research is waiting for approval: pnpm test tests/subagent-child-lifecycle.test.ts",
      data: {
        childSessionId: "session_child",
        parentGoalId: "goal_parent",
      },
    });

    await bridge.resolveApproval(approvals[0]!.id, { decision: "accept" });
    await pendingResult;

    expect(runs[0]).toMatchObject({
      status: "running",
      error: null,
      metadata: {
        lastApproval: {
          status: "accepted",
        },
      },
    });
    expect(events.find((event) => event.name === "subagent.started" && event.sessionId === "session_parent")).toMatchObject({
      status: "started",
      output: "Subagent research approval accepted; child run is continuing.",
    });
  });
});

function codexSession(overrides: Partial<Session> = {}): Session {
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
    ...overrides,
  };
}

function codexTurn(overrides: Partial<Turn> = {}): Turn {
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
    createImproveRun: null,
    ...overrides,
  };
}

function subagentRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return SubagentRunSchema.parse({
    id: "run_child",
    parentSessionId: "session_parent",
    parentTurnId: "turn_parent",
    parentGoalId: "goal_parent",
    childSessionId: "session_child",
    roleId: "research",
    objective: "Review approval behavior",
    modelRef: { providerId: "codex", modelId: "gpt-5.3-codex" },
    isolationMode: "copy_on_write",
    toolPolicy: "read_only",
    background: true,
    peerMessages: "goal_scoped",
    status: "running",
    required: true,
    createdAt: "2026-07-04T10:00:00.000Z",
    startedAt: "2026-07-04T10:00:01.000Z",
    ...overrides,
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition.");
}
