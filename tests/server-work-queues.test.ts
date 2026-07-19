import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  type Approval,
  type RuntimeEvent,
  type Session,
  type Turn,
  type WorkspaceDiffSummary,
} from "@openpond/contracts";
import type { CodexNotification } from "@openpond/codex-provider";
import {
  createBackgroundWorkerQueue,
  createServerWorkQueues,
} from "../apps/server/src/runtime/background-worker-queue";
import { createCodexBridge } from "../apps/server/src/runtime/codex-bridge";
import { createTurnRunner } from "../apps/server/src/runtime/turn-runner";
import { withTurnRunnerTestStore } from "./helpers/turn-runner-test-harness";
import { createWorkspaceSessionWorkflows } from "../apps/server/src/workspace/server-workspace-session-workflows";
import type { SqliteStore } from "../apps/server/src/store/store";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("server work queues", () => {
  test("keeps subagent lifecycle watcher work off the child execution queue", async () => {
    const queues = createServerWorkQueues({ warn: () => undefined });
    let releaseChild!: () => void;
    const childWork = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });

    const childReceipt = queues.subagent.enqueue(
      { label: "Long-running child" },
      () => childWork,
    );
    const lifecycleReceipt = queues.subagentLifecycle.enqueue(
      { label: "Lifecycle watcher tick" },
      async () => undefined,
    );

    await queues.drain("subagent-lifecycle");

    expect(lifecycleReceipt.status).toBe("completed");
    expect(childReceipt.status).not.toBe("completed");

    releaseChild();
    await queues.drain();
  });

  test("queues provider runtime notification ingestion through the Codex bridge", async () => {
    const queue = createBackgroundWorkerQueue({ queueId: "provider-runtime-ingestion" });
    const events: RuntimeEvent[] = [];
    const bridge = createCodexBridge({
      store: {
        async runtimeEventContext(sessionId: string, providerTurnId?: string | null) {
          expect(sessionId).toBe("session-1");
          expect(providerTurnId).toBe("provider-turn-1");
          return { turnId: "turn-1", appId: "app-1" };
        },
      } as unknown as SqliteStore,
      upsertApproval: async () => undefined,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      providerRuntimeIngestionQueue: queue,
    });

    const receipt = bridge.mapCodexNotification("session-1", {
      method: "item/agentMessage/delta",
      params: { turnId: "provider-turn-1", delta: "Queued hello" },
    } as CodexNotification);

    expect(receipt.queueId).toBe("provider-runtime-ingestion");
    expect(receipt.status).toBe("queued");
    expect(events).toEqual([]);

    await queue.drain();

    expect(receipt.status).toBe("completed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: "session-1",
      turnId: "turn-1",
      appId: "app-1",
      name: "assistant.delta",
      source: "provider",
      output: "Queued hello",
    });
  });

  test("queues workspace diff capture and drains the resulting diff event", async () => {
    const queue = createBackgroundWorkerQueue({ queueId: "checkpoint-diff" });
    const events: RuntimeEvent[] = [];
    const workflows = createWorkspaceSessionWorkflows({
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      checkpointDiffQueue: queue,
      findLocalWorkspace: async () => null,
      findOpenPondApp: async () => {
        throw new Error("app lookup is not needed for queued diff capture");
      },
      storeDir: "/tmp/openpond-store",
      workspaceDiffPayload: async (workspaceId) =>
        diffSummary({
          appId: workspaceId,
          filePath: "src/changed.ts",
          patch: "diff --git a/src/changed.ts b/src/changed.ts",
        }),
    });

    const session = baseSession({
      appId: "app-1",
      workspaceId: null,
      workspaceKind: undefined,
    });
    await workflows.appendWorkspaceDiffEvent(session, "turn-1");

    expect(events).toEqual([]);
    expect(queue.pendingReceipts()).toHaveLength(1);

    await queue.drain();

    expect(queue.receipts()[0]).toMatchObject({
      queueId: "checkpoint-diff",
      label: "Workspace diff event capture",
      status: "completed",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: "session-1",
      turnId: "turn-1",
      name: "workspace.diff",
      source: "server",
      appId: "app-1",
      status: "completed",
    });
    expect((events[0]?.data as WorkspaceDiffSummary).files.map((file) => file.path)).toEqual([
      "src/changed.ts",
    ]);
  });

  test("resolves a cwd-only session as an active local folder workspace", async () => {
    const repoPath = await createTempDir("openpond-cwd-session-workspace-");
    const workflows = createWorkspaceSessionWorkflows({
      appendRuntimeEvent: async () => undefined,
      checkpointDiffQueue: createBackgroundWorkerQueue({ queueId: "unused-checkpoint-diff" }),
      findLocalWorkspace: async () => null,
      findOpenPondApp: async () => {
        throw new Error("app lookup is not needed for cwd-only sessions");
      },
      storeDir: "/tmp/openpond-store",
      workspaceDiffPayload: async () => {
        throw new Error("workspace diff is not needed for cwd-only active workspace resolution");
      },
    });

    const { app, state } = await workflows.activeWorkspace(baseSession({ cwd: repoPath }));

    expect(app.id).toBe(`local_path:${repoPath}`);
    expect(app.name).toBe(path.basename(repoPath));
    expect(state).toMatchObject({
      appId: `local_path:${repoPath}`,
      source: "local_folder",
      workspacePath: repoPath,
      repoPath,
      initialized: true,
    });
  });

  test("queues approved local Create follow-up work and drains persisted failure state", async () => {
    const repoPath = await createTempDir("openpond-local-create-repo-");
    const sourcePath = path.join(repoPath, "profiles", "default");
    await mkdir(sourcePath, { recursive: true });
    const queue = createBackgroundWorkerQueue({ queueId: "turn-follow-up" });
    const events: RuntimeEvent[] = [];
    const approvals: Approval[] = [];
    let session = baseSession({
      provider: "codex",
      appId: "app-1",
      workspaceKind: "local_project",
      workspaceId: "project-1",
      cwd: repoPath,
    });
    const createImproveRun = createImproveRunFixture({
      id: "create_improve_local_queue",
      state: "awaiting_plan_approval",
      adapter: {
        kind: "local",
        sourceAuthority: "local_profile",
        activeProfile: "default",
        repoPath,
        sourcePath,
        localHead: null,
        confirmationPolicy: "always_require_plan_approval",
      },
      scope: {
        profileId: "default",
        conversationId: "session-1",
        originTurnId: "turn-1",
        workItemId: null,
        projectId: null,
        targetProject: null,
      },
      target: {
        kind: "agent",
        id: "support-helper",
        displayName: "Support Helper",
        defaultActionKey: "support-helper.chat",
      },
    });
    const turn = baseTurn({
      createImproveRun,
    });
    const turns = [turn];
    const runner = createTurnRunner({
      attachmentRootDir: path.join(repoPath, ".attachments"),
      store: withTurnRunnerTestStore({
        async snapshot() {
          return { events, turns, approvals };
        },
        async getTurn(turnId) {
          return turns.find((candidate) => candidate.id === turnId) ?? null;
        },
        async insertTurn(nextTurn) {
          turns.push(nextTurn);
        },
        async updateTurn(turnId, updater) {
          const index = turns.findIndex((candidate) => candidate.id === turnId);
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
      getSession: async () => session,
      updateSession: async (_sessionId, patch) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async () => {
        throw new Error("turn completion is not expected in this follow-up test");
      },
      failTurn: async () => {
        throw new Error("turn failure is not expected in this follow-up test");
      },
      interruptTurn: async () => {
        throw new Error("turn interruption is not expected in this follow-up test");
      },
      defaultSessionCwd: () => repoPath,
      findOpenPondApp: async () => {
        throw new Error("app lookup is not expected in this follow-up test");
      },
      resolveSessionWorkspaceCwd: async () => repoPath,
      ensureCodexRuntime: async () => {
        throw new Error("intentional queued local create failure");
      },
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => null,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      executeWorkspaceTool: async () => {
        throw new Error("workspace tools are not expected in this follow-up test");
      },
      loadPersonalizationSoul: async () => "",
      maybeCreateScaffoldForTurn: async (nextSession) => nextSession,
      hostedSystemPrompt: async () => "system",
      appendAssistantText: async () => undefined,
      appendHostedContextUsage: async () => undefined,
      turnFollowUpQueue: queue,
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    await runner.applyCreateImproveAction(createImproveRun.id, {
      runId: createImproveRun.id,
      expectedRevision: createImproveRun.revision,
      actionId: "approve_create_improve_local_queue",
      type: "approve_plan",
    });

    expect(queue.pendingReceipts()).toHaveLength(1);
    expect(turns[0]?.createImproveRun?.state).toBe("applying_source");

    await queue.drain();

    expect(queue.receipts()[0]).toMatchObject({
      queueId: "turn-follow-up",
      label: "Apply approved agent Create/Improve run",
      status: "completed",
    });
    expect(turns[0]?.createImproveRun?.state).toBe("blocked");
    expect(turns[0]?.createImproveRun?.blockedReason).toBe("intentional queued local create failure");
    expect(events.some((event) => event.name === "create_improve.updated" && event.source === "server")).toBe(true);
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function baseSession(patch: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    provider: "openpond",
    modelRef: { providerId: "openpond", modelId: "openpond-chat" },
    title: "Queued work test",
    appId: null,
    appName: null,
    workspaceKind: undefined,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...patch,
  };
}

function baseTurn(patch: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    sessionId: "session-1",
    providerTurnId: null,
    modelRef: { providerId: "codex", modelId: "gpt-5" },
    prompt: "Create a support helper agent",
    startedAt: "2026-07-01T10:00:00.000Z",
    completedAt: "2026-07-01T10:00:01.000Z",
    status: "completed",
    error: null,
    metadata: {},
    createImproveRun: null,
    ...patch,
  };
}

function diffSummary(input: {
  appId: string;
  filePath: string;
  patch: string;
}): WorkspaceDiffSummary {
  return {
    appId: input.appId,
    repoPath: "/tmp/openpond-diff",
    initialized: true,
    dirty: true,
    filesChanged: 1,
    additions: 1,
    deletions: 0,
    repoFiles: [input.filePath],
    files: [
      {
        path: input.filePath,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: input.patch,
        content: "export const changed = true;\n",
      },
    ],
    error: null,
    updatedAt: "2026-07-01T10:00:00.000Z",
  };
}
