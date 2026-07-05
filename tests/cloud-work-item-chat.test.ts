import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type {
  CreatePipelineRequest,
  CreatePipelineSnapshot,
  LocalProject,
  UsageRequestAttribution,
} from "@openpond/contracts";
import {
  assertCreatePipelineBackgroundApproved,
  createServerPayloads,
} from "../apps/server/src/api/server-payloads";
import { sandboxRequestPayload } from "../apps/server/src/openpond/sandboxes";
import { SqliteStore } from "../apps/server/src/store/store";
import { runWorkspaceCommand } from "../apps/server/src/workspace/workspaces";

const originalFetch = globalThis.fetch;
const originalSandboxApiKey = process.env.OPENPOND_SANDBOX_API_KEY;
const originalSandboxApiUrl = process.env.OPENPOND_SANDBOX_API_URL;
const tempRoots: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalSandboxApiKey === undefined) {
    delete process.env.OPENPOND_SANDBOX_API_KEY;
  } else {
    process.env.OPENPOND_SANDBOX_API_KEY = originalSandboxApiKey;
  }
  if (originalSandboxApiUrl === undefined) {
    delete process.env.OPENPOND_SANDBOX_API_URL;
  } else {
    process.env.OPENPOND_SANDBOX_API_URL = originalSandboxApiUrl;
  }
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Cloud work item chat", () => {
  test("requires approved create pipeline snapshots before background mutation", () => {
    const request = createPipelineRequest();
    const pending = createPipelineSnapshot(request, {
      state: "awaiting_plan_approval",
      planStatus: "pending_approval",
    });
    const approved = createPipelineSnapshot(request, {
      state: "applying_source",
      planStatus: "approved",
    });

    expect(() =>
      assertCreatePipelineBackgroundApproved({ request, snapshot: null }),
    ).toThrow("approved create plan snapshot");
    expect(() =>
      assertCreatePipelineBackgroundApproved({ request, snapshot: pending }),
    ).toThrow("cannot start before plan approval");
    expect(() =>
      assertCreatePipelineBackgroundApproved({
        request,
        snapshot: {
          ...approved,
          approvalIds: [],
        },
      }),
    ).toThrow("approval id");
    expect(() =>
      assertCreatePipelineBackgroundApproved({
        request: { ...request, id: "create_request_other" },
        snapshot: approved,
      }),
    ).toThrow("submitted request");
    expect(() => assertCreatePipelineBackgroundApproved({ request, snapshot: approved })).not.toThrow();
    expect(() => assertCreatePipelineBackgroundApproved({ request: null, snapshot: null })).not.toThrow();
  });

  test("rejects unapproved create pipeline background payloads before sandbox forwarding", async () => {
    const request = createPipelineRequest();
    const pending = createPipelineSnapshot(request, {
      state: "awaiting_plan_approval",
      planStatus: "pending_approval",
    });
    let forwarded = false;
    globalThis.fetch = async () => {
      forwarded = true;
      return Response.json({});
    };

    const payloads = createServerPayloads({
      store: {} as never,
      storeDir: "",
      providersFilePath: "",
      serverId: "server_test",
      host: "127.0.0.1",
      getActualPort: () => 0,
      startedAt: "2026-06-17T00:00:00.000Z",
      version: "test",
      runtimeVersion: "test",
      getCodexStatus: () => ({
        available: false,
        binaryPath: null,
        version: null,
        authHealth: "unknown",
        account: null,
        appServer: { status: "idle", lastError: null },
      }),
      appendRuntimeEvent: async () => undefined,
      isClosing: () => false,
    });

    await expect(
      payloads.handleCloudWorkItemBackgroundPayload("work_item_1", {
        teamId: "team_1",
        prompt: "Start",
        createPipelineRequest: request,
        createPipeline: pending,
      }),
    ).rejects.toThrow("cannot start before plan approval");
    expect(forwarded).toBe(false);
  });

  test("rejects mismatched create pipeline metadata before Cloud message forwarding", async () => {
    const request = createPipelineRequest();
    const snapshot = createPipelineSnapshot(request, {
      state: "awaiting_plan_approval",
      planStatus: "pending_approval",
    });
    let forwarded = false;
    globalThis.fetch = async () => {
      forwarded = true;
      return Response.json({});
    };
    const payloads = createServerPayloads({
      store: {} as never,
      storeDir: "",
      providersFilePath: "",
      serverId: "server_test",
      host: "127.0.0.1",
      getActualPort: () => 0,
      startedAt: "2026-06-17T00:00:00.000Z",
      version: "test",
      runtimeVersion: "test",
      getCodexStatus: () => ({
        available: false,
        binaryPath: null,
        version: null,
        authHealth: "unknown",
        account: null,
        appServer: { status: "idle", lastError: null },
      }),
      appendRuntimeEvent: async () => undefined,
      isClosing: () => false,
    });

    await expect(
      payloads.sendCloudWorkItemMessagePayload("work_item_1", {
        teamId: "team_1",
        message: "Revise plan: focus on PR summaries",
        createPipelineRequest: { ...request, id: "create_request_other" },
        createPipeline: snapshot,
      }),
    ).rejects.toThrow("snapshot for the submitted request");
    expect(forwarded).toBe(false);
  });

  test("routes Desktop Cloud sends and stops through work-item backend endpoints", async () => {
    process.env.OPENPOND_SANDBOX_API_KEY = "opk_test_desktop";
    process.env.OPENPOND_SANDBOX_API_URL = "https://api.example/v1/sandboxes";

    const requests: Array<{
      body: Record<string, unknown>;
      method: string | undefined;
      pathname: string;
    }> = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        method: init?.method,
        pathname: url.pathname,
      });
      return Response.json({
        assistantMessage: {
          id: "message_assistant",
          workItemId: "work_item_1",
          teamId: "team_1",
          projectId: "project_1",
          conversationId: "conversation_1",
          role: "assistant",
          body: "Checked the coding workspace.",
          createdByUserId: null,
          createdAt: "2026-06-17T00:00:01.000Z",
          metadata: {},
        },
        userMessage: {
          id: "message_user",
          workItemId: "work_item_1",
          teamId: "team_1",
          projectId: "project_1",
          conversationId: "conversation_1",
          role: "user",
          body: "Inspect the workspace",
          createdByUserId: "user_1",
          createdAt: "2026-06-17T00:00:00.000Z",
          metadata: {},
        },
      });
    };

    await sandboxRequestPayload({
      type: "work_item_chat",
      workItemId: "work_item_1",
      payload: {
        teamId: "team_1",
        message: "Inspect the workspace",
        metadata: { source: "openpond_app_cloud_thread" },
      },
    });
    await sandboxRequestPayload({
      type: "work_item_cancel_task",
      workItemId: "work_item_1",
      payload: {
        teamId: "team_1",
      },
    });

    expect(requests).toEqual([
      {
        body: {
          teamId: "team_1",
          message: "Inspect the workspace",
          metadata: { source: "openpond_app_cloud_thread" },
        },
        method: "POST",
        pathname: "/v1/work-items/work_item_1/chat",
      },
      {
        body: {
          teamId: "team_1",
        },
        method: "POST",
        pathname: "/v1/work-items/work_item_1/cancel-task",
      },
    ]);
  });

  test("stores queued local project context as Cloud work item metadata", async () => {
    process.env.OPENPOND_SANDBOX_API_KEY = "opk_test_desktop";
    process.env.OPENPOND_SANDBOX_API_URL = "https://api.example/v1/sandboxes";

    const requests: Array<{
      body: Record<string, unknown>;
      method: string | undefined;
      pathname: string;
    }> = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({
        body,
        method: init?.method,
        pathname: url.pathname,
      });
      return Response.json({
        workItem: {
          id: "work_item_queued",
          teamId: "team_1",
          projectId: "cloud_project_1",
          conversationId: "conversation_1",
          title: String(body.title),
          status: "queued",
          sourceRef: body.sourceRef ?? null,
          baseSha: body.baseSha ?? null,
          latestRuntimeId: null,
          latestSandboxId: null,
          latestTaskRunId: null,
          assignedAgentId: null,
          createdAt: "2026-06-17T00:00:00.000Z",
          updatedAt: "2026-06-17T00:00:00.000Z",
          archivedAt: null,
          metadata: body.metadata ?? {},
        },
      });
    };

    const payloads = createServerPayloads({
      store: {} as never,
      storeDir: "",
      providersFilePath: "",
      serverId: "server_test",
      host: "127.0.0.1",
      getActualPort: () => 0,
      startedAt: "2026-06-17T00:00:00.000Z",
      version: "test",
      runtimeVersion: "test",
      getCodexStatus: () => ({
        available: false,
        binaryPath: null,
        version: null,
        authHealth: "unknown",
        account: null,
        appServer: { status: "idle", lastError: null },
      }),
      appendRuntimeEvent: async () => undefined,
      isClosing: () => false,
    });

    const detail = await payloads.createCloudWorkItemPayload({
      teamId: "team_1",
      projectId: "cloud_project_1",
      title: "Queue proof",
      initialMessage: "Run this in Cloud",
      sourceRef: "main",
      baseSha: "abc123",
      localProjectId: "local_project_1",
      localProjectName: "Local Repo",
      localWorkspacePath: "/workspace/local-repo",
      requestedExecutionTarget: "queue_cloud",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      pathname: "/v1/projects/cloud_project_1/work-items",
      body: {
        teamId: "team_1",
        title: "Queue proof",
        initialMessage: "Run this in Cloud",
        sourceRef: "main",
        baseSha: "abc123",
        metadata: {
          source: "openpond_app_cloud",
          requestedExecutionTarget: "queue_cloud",
          localProjectId: "local_project_1",
          localProjectName: "Local Repo",
          localWorkspacePath: "/workspace/local-repo",
        },
      },
    });
    expect(Object.hasOwn(requests[0].body, "localProjectId")).toBe(false);
    expect(Object.hasOwn(requests[0].body, "requestedExecutionTarget")).toBe(false);
    expect(detail.workItem.metadata).toMatchObject({
      requestedExecutionTarget: "queue_cloud",
      localProjectId: "local_project_1",
      localProjectName: "Local Repo",
      localWorkspacePath: "/workspace/local-repo",
    });
  });

  test("preserves Cloud command usage attribution without creating local usage rows", async () => {
    process.env.OPENPOND_SANDBOX_API_KEY = "opk_test_desktop";
    process.env.OPENPOND_SANDBOX_API_URL = "https://api.example/v1/sandboxes";

    const storeDir = await mkdtemp(join(tmpdir(), "openpond-cloud-usage-linkage-store-"));
    tempRoots.push(storeDir);
    const store = new SqliteStore(storeDir);
    const request = createPipelineRequest();
    const approved = createPipelineSnapshot(request, {
      state: "applying_source",
      planStatus: "approved",
    });
    const slashAttribution: UsageRequestAttribution = {
      surface: "chat",
      workflowKind: "slash_command",
      commandName: "/create",
      commandSource: "prompt_parse",
    };
    const backgroundAttribution: UsageRequestAttribution = {
      surface: "create_pipeline",
      workflowKind: "planner",
      createPipelineRequestId: request.id,
      commandName: "/create",
      commandSource: "api",
    };
    const requests: Array<{
      body: Record<string, unknown>;
      method: string | undefined;
      pathname: string;
    }> = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({
        body,
        method: init?.method,
        pathname: url.pathname,
      });
      if (url.pathname === "/v1/projects/cloud_project_1/work-items") {
        return Response.json({
          workItem: {
            id: "work_item_attributed",
            teamId: "team_1",
            projectId: "cloud_project_1",
            conversationId: "conversation_1",
            title: String(body.title),
            status: "queued",
            sourceRef: body.sourceRef ?? null,
            baseSha: body.baseSha ?? null,
            latestRuntimeId: null,
            latestSandboxId: null,
            latestTaskRunId: null,
            assignedAgentId: null,
            createdAt: "2026-06-17T00:00:00.000Z",
            updatedAt: "2026-06-17T00:00:00.000Z",
            archivedAt: null,
            metadata: body.metadata ?? {},
          },
        });
      }
      if (url.pathname === "/v1/work-items/work_item_attributed/messages") {
        return Response.json({
          message: {
            id: "message_system_link",
            workItemId: "work_item_attributed",
            teamId: "team_1",
            projectId: "cloud_project_1",
            conversationId: "conversation_1",
            role: body.role ?? "system",
            body: body.body ?? "Cloud message",
            createdByUserId: null,
            createdAt: "2026-06-17T00:00:00.000Z",
            metadata: body.metadata ?? {},
          },
          userMessage: {
            id: "message_user",
            workItemId: "work_item_attributed",
            teamId: "team_1",
            projectId: "cloud_project_1",
            conversationId: "conversation_1",
            role: "user",
            body: body.message ?? "Cloud message",
            createdByUserId: "user_1",
            createdAt: "2026-06-17T00:00:00.000Z",
            metadata: body.metadata ?? {},
          },
          assistantMessage: {
            id: "message_assistant",
            workItemId: "work_item_attributed",
            teamId: "team_1",
            projectId: "cloud_project_1",
            conversationId: "conversation_1",
            role: "assistant",
            body: "Cloud accepted the message.",
            createdByUserId: null,
            createdAt: "2026-06-17T00:00:01.000Z",
            metadata: body.metadata ?? {},
          },
        });
      }
      if (url.pathname === "/v1/work-items/work_item_attributed/chat") {
        return Response.json({
          userMessage: {
            id: "message_user_chat",
            workItemId: "work_item_attributed",
            teamId: "team_1",
            projectId: "cloud_project_1",
            conversationId: "conversation_1",
            role: "user",
            body: body.message,
            createdByUserId: "user_1",
            createdAt: "2026-06-17T00:00:00.000Z",
            metadata: body.metadata ?? {},
          },
          assistantMessage: {
            id: "message_assistant_chat",
            workItemId: "work_item_attributed",
            teamId: "team_1",
            projectId: "cloud_project_1",
            conversationId: "conversation_1",
            role: "assistant",
            body: "Cloud accepted the revision.",
            createdByUserId: null,
            createdAt: "2026-06-17T00:00:01.000Z",
            metadata: body.metadata ?? {},
          },
        });
      }
      if (url.pathname === "/v1/work-items/work_item_attributed/handle-background") {
        return Response.json({ ok: true });
      }
      return Response.json({ error: `Unexpected request: ${url.pathname}` }, { status: 500 });
    };

    try {
      const payloads = createServerPayloads({
        store,
        storeDir,
        providersFilePath: join(storeDir, "providers.json"),
        serverId: "server_test",
        host: "127.0.0.1",
        getActualPort: () => 0,
        startedAt: "2026-06-17T00:00:00.000Z",
        version: "test",
        runtimeVersion: "test",
        getCodexStatus: () => ({
          available: false,
          binaryPath: null,
          version: null,
          authHealth: "unknown",
          account: null,
          appServer: { status: "idle", lastError: null },
        }),
        appendRuntimeEvent: async () => undefined,
        isClosing: () => false,
      });

      await payloads.createCloudWorkItemPayload({
        teamId: "team_1",
        projectId: "cloud_project_1",
        title: "Cloud create usage linkage",
        initialMessage: "/create Cloud support agent",
        sourceRef: "main",
        baseSha: "abc123",
        createPipelineRequest: request,
        createPipeline: approved,
        usageAttribution: slashAttribution,
      });
      await payloads.sendCloudWorkItemMessagePayload("work_item_attributed", {
        teamId: "team_1",
        message: "Revise plan: narrow the workflow",
        createPipelineRequest: request,
        createPipeline: approved,
        usageAttribution: backgroundAttribution,
      });
      await payloads.handleCloudWorkItemBackgroundPayload("work_item_attributed", {
        teamId: "team_1",
        prompt: "Apply approved create plan",
        createPipelineRequest: request,
        createPipeline: approved,
        usageAttribution: backgroundAttribution,
        payload: { createPipelineDecision: "approved" },
      });

      const createRequest = requests.find((candidate) => candidate.pathname === "/v1/projects/cloud_project_1/work-items");
      expect((createRequest?.body.metadata as any)?.usageAttribution).toMatchObject(slashAttribution);
      const hiddenLinkRequest = requests.find(
        (candidate) =>
          candidate.pathname === "/v1/work-items/work_item_attributed/messages" &&
          (candidate.body.metadata as any)?.source === "openpond_app_cloud_create_pipeline_link",
      );
      expect((hiddenLinkRequest?.body.metadata as any)?.usageAttribution).toMatchObject(slashAttribution);
      const chatRequest = requests.find((candidate) => candidate.pathname === "/v1/work-items/work_item_attributed/chat");
      expect((chatRequest?.body.metadata as any)?.usageAttribution).toMatchObject(backgroundAttribution);
      const backgroundRequest = requests.find((candidate) => candidate.pathname === "/v1/work-items/work_item_attributed/handle-background");
      expect(backgroundRequest?.body.usageAttribution).toMatchObject(backgroundAttribution);
      expect((backgroundRequest?.body.payload as any)?.usageAttribution).toMatchObject(backgroundAttribution);
      expect((backgroundRequest?.body.payload as any)?.createPipelineRequest).toMatchObject({
        id: request.id,
        command: request.command,
      });
      await expect(store.listModelUsageRecords({})).resolves.toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  test("applies reviewed Cloud patches only through an explicitly linked clean local checkout", async () => {
    process.env.OPENPOND_SANDBOX_API_KEY = "opk_test_desktop";
    process.env.OPENPOND_SANDBOX_API_URL = "https://api.example/v1/sandboxes";

    const repoPath = await mkdtemp(join(tmpdir(), "openpond-cloud-apply-local-repo-"));
    const storeDir = await mkdtemp(join(tmpdir(), "openpond-cloud-apply-local-store-"));
    tempRoots.push(repoPath, storeDir);
    await writeFile(join(repoPath, "README.md"), "# Local repo\n", "utf8");
    await git(repoPath, ["init"]);
    await git(repoPath, ["branch", "-M", "main"]);
    await git(repoPath, ["config", "user.email", "openpond-app@example.local"]);
    await git(repoPath, ["config", "user.name", "OpenPond App"]);
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["commit", "-m", "Initial local state"]);
    const head = (await git(repoPath, ["rev-parse", "HEAD"])).stdout.trim();
    const patchText = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      " # Local repo",
      "+Cloud patch applied",
      "",
    ].join("\n");
    const requests: Array<{ body: Record<string, unknown>; method: string | undefined; pathname: string }> = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        method: init?.method,
        pathname: url.pathname,
      });
      if (url.pathname === "/v1/work-items/work_item_1") {
        return Response.json({
          workItem: cloudWorkItem({
            latestSandboxId: "sandbox_1",
            sourceRef: "main",
            baseSha: head,
          }),
        });
      }
      if (url.pathname === "/v1/work-items/work_item_1/messages") {
        return Response.json({ messages: [] });
      }
      if (url.pathname === "/v1/work-items/work_item_1/activity") {
        return Response.json({ activity: [] });
      }
      if (url.pathname === "/v1/sandboxes/sandbox_1/git/export-patch") {
        return Response.json({
          patch: {
            patch: patchText,
            empty: false,
            isRepo: true,
            filename: "cloud-work-item.patch",
            bytes: Buffer.byteLength(patchText, "utf8"),
          },
        });
      }
      return Response.json({ error: `Unexpected sandbox request: ${url.pathname}` }, { status: 500 });
    };

    const store = new SqliteStore(storeDir);
    try {
      await store.setCacheEntry("local.projects", "v1", [localProject(repoPath, head)]);
      const payloads = createServerPayloads({
        store,
        storeDir,
        providersFilePath: join(storeDir, "providers.json"),
        serverId: "server_test",
        host: "127.0.0.1",
        getActualPort: () => 0,
        startedAt: "2026-06-17T00:00:00.000Z",
        version: "test",
        runtimeVersion: "test",
        getCodexStatus: () => ({
          available: false,
          binaryPath: null,
          version: null,
          authHealth: "unknown",
          account: null,
          appServer: { status: "idle", lastError: null },
        }),
        appendRuntimeEvent: async () => undefined,
        isClosing: () => false,
      });

      const response = await payloads.applyCloudWorkItemLocalPatchPayload("work_item_1", {
        teamId: "team_1",
        localProjectId: "local_project_1",
        sandboxId: "sandbox_1",
      });

      expect(await readFile(join(repoPath, "README.md"), "utf8")).toBe(
        "# Local repo\nCloud patch applied\n",
      );
      expect(response.localProject.id).toBe("local_project_1");
      expect(response.patch).toMatchObject({
        sandboxId: "sandbox_1",
        filename: "cloud-work-item.patch",
        applied: true,
        fileCount: 1,
      });
      expect(response.workspaceState.dirty).toBe(true);
      expect(response.workspaceState.changedFilesCount).toBe(1);
      expect(new Set(requests.slice(0, 3).map((request) => request.pathname))).toEqual(
        new Set([
          "/v1/work-items/work_item_1",
          "/v1/work-items/work_item_1/messages",
          "/v1/work-items/work_item_1/activity",
        ]),
      );
      expect(requests.at(-1)?.pathname).toBe("/v1/sandboxes/sandbox_1/git/export-patch");
    } finally {
      await store.close();
    }
  });
});

function createPipelineRequest(): CreatePipelineRequest {
  const now = "2026-06-17T00:00:00.000Z";
  return {
    schemaVersion: "openpond.createPipeline.request.v1",
    id: "create_request_guard",
    operation: "create",
    surface: "hosted_create",
    command: "/create",
    objective: "Create a release notes agent",
    adapter: {
      kind: "hosted",
      sourceAuthority: "hosted_profile",
      teamId: "team_1",
      projectId: "project_1",
      activeProfile: "default",
      sourceRef: "main",
      baseSha: null,
      workItemId: "work_item_1",
      confirmationPolicy: "always_require_plan_approval",
    },
    actor: { id: "user_1", kind: "user", label: "User" },
    scope: {
      conversationId: "conversation_1",
      workItemId: "work_item_1",
      projectId: "project_1",
      targetProject: null,
    },
    context: {
      messageIds: [],
      conversationExcerpts: [],
      attachments: [],
      apps: [],
      tools: [],
      targetRepoAssumptions: [],
    },
    targetAgent: {
      agentId: null,
      displayName: null,
      defaultActionKey: "chat",
    },
    metadata: {},
    createdAt: now,
  };
}

function cloudWorkItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "work_item_1",
    teamId: "team_1",
    projectId: "cloud_project_1",
    conversationId: "conversation_1",
    title: "Review Cloud patch",
    status: "needs_review",
    sourceRef: "main",
    baseSha: null,
    latestRuntimeId: "runtime_1",
    latestSandboxId: "sandbox_1",
    latestTaskRunId: "task_1",
    assignedAgentId: null,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:01.000Z",
    archivedAt: null,
    metadata: {},
    ...overrides,
  };
}

function localProject(repoPath: string, head: string): LocalProject {
  const now = "2026-06-17T00:00:00.000Z";
  return {
    id: "local_project_1",
    name: "Local Project",
    path: repoPath,
    workspacePath: repoPath,
    repoPath,
    source: "git",
    systemKind: null,
    hiddenFromDefaultSidebar: false,
    sandboxTemplate: null,
    agentSdk: null,
    linkedOpenPondApp: null,
    linkedSandboxProject: {
      teamId: "team_1",
      projectId: "cloud_project_1",
      projectSlug: "cloud-project",
      projectName: "Cloud Project",
      sourceRepoUrl: null,
      defaultBranch: "main",
      lastUploadedCommit: head,
      lastUploadTransport: "api_source_upload",
      manifestPath: null,
      manifestHash: null,
      syncedAt: now,
      linkedAt: now,
    },
    preferredSandboxAgentId: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function git(cwd: string, args: string[]) {
  const result = await runWorkspaceCommand("git", args, cwd);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return result;
}

function createPipelineSnapshot(
  request: CreatePipelineRequest,
  input: {
    state: CreatePipelineSnapshot["state"];
    planStatus: NonNullable<CreatePipelineSnapshot["plan"]>["status"];
  },
): CreatePipelineSnapshot {
  const now = "2026-06-17T00:00:00.000Z";
  const approvalId = "approval_create_plan";
  return {
    schemaVersion: "openpond.createPipeline.snapshot.v1",
    id: "create_pipeline_guard",
    goalId: "work_item_1",
    state: input.state,
    request,
    plan: {
      schemaVersion: "openpond.createPipeline.plan.v1",
      id: "create_plan_guard",
      goalId: "work_item_1",
      requestId: request.id,
      status: input.planStatus,
      objective: request.objective,
      summary: "Create a source-backed profile agent.",
      capturedContextSummary: "Direct prompt create.",
      defaultChatAction: {
        key: "chat",
        label: "Chat",
        required: true,
      },
      sourcePlan: [],
      requirements: [],
      checks: [],
      approvalId,
      approvedAt: input.planStatus === "approved" ? now : null,
      editedFromPlanId: null,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    },
    workflowCapture: null,
    approvalIds: [approvalId],
    questionIds: [],
    checkRefs: [],
    sourceRefs: [],
    localGoalId: null,
    localProfileCommit: null,
    hostedGoalId: null,
    hostedSourceCommit: null,
    hostedSourceRef: "main",
    blockedReason: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}
