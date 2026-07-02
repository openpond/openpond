import { afterEach, describe, expect, test } from "bun:test";

import type { CreatePipelineRequest, CreatePipelineSnapshot } from "@openpond/contracts";
import {
  assertCreatePipelineBackgroundApproved,
  createServerPayloads,
} from "../apps/server/src/api/server-payloads";
import { sandboxRequestPayload } from "../apps/server/src/openpond/sandboxes";

const originalFetch = globalThis.fetch;
const originalSandboxApiKey = process.env.OPENPOND_SANDBOX_API_KEY;
const originalSandboxApiUrl = process.env.OPENPOND_SANDBOX_API_URL;

afterEach(() => {
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
