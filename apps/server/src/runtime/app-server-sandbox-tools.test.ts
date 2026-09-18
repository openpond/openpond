import { describe, expect, test } from "vitest";
import type { Session, WorkspaceToolRequest } from "@openpond/contracts";

import {
  executeAppServerSandboxTool,
  type AppServerSandboxRequest,
} from "./app-server-sandbox-tools.js";

describe("app-server sandbox tools", () => {
  test("creates and attaches scoped lazy Work compute before remote file actions", async () => {
    const calls: Parameters<AppServerSandboxRequest>[0][] = [];
    const attached: string[] = [];
    const sandboxRequest: AppServerSandboxRequest = async (request) => {
      calls.push(request);
      if (request.type === "sandbox_runtime_create") {
        return { runtime: { id: "runtime_1" } };
      }
      if (request.type === "sandbox_runtime_sandbox_create") {
        return {
          sandbox: {
            id: "sandbox_1",
            name: "Lazy Work",
            state: "creating",
          },
        };
      }
      throw new Error(`Unexpected request: ${request.type}`);
    };

    const result = await executeAppServerSandboxTool({
      session: workSession(),
      request: toolRequest("sandbox_create", {
        command: "mkdir -p inputs work outputs",
        visibility: "private",
        runtime: {
          runtimeProfileId: "openpond-work-v1",
          workflowMode: "attempt",
          promotionPolicy: "none",
        },
        networkPolicy: { internetEgress: "block", allowedHosts: [] },
      }),
      sandboxRequest,
      attachSandbox: async ({ sandboxId }) => {
        attached.push(sandboxId);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      action: "sandbox_create",
      data: { sandbox: { id: "sandbox_1" } },
    });
    expect(attached).toEqual(["sandbox_1"]);
    expect(calls).toEqual([
      expect.objectContaining({
        type: "sandbox_runtime_create",
        payload: expect.objectContaining({
          teamId: "team_1",
          projectId: "project_1",
          runtimeProfileId: "openpond-work-v1",
          workflowMode: "attempt",
          promotionPolicy: "none",
        }),
      }),
      expect.objectContaining({
        type: "sandbox_runtime_sandbox_create",
        runtimeId: "runtime_1",
        payload: expect.objectContaining({
          teamId: "team_1",
          projectId: "project_1",
          command: "mkdir -p inputs work outputs",
          visibility: "private",
          networkPolicy: {
            internetEgress: "block",
            allowedHosts: [],
          },
        }),
      }),
    ]);
  });

  test("keeps attached sandbox actions bound to the session sandbox", async () => {
    await expect(
      executeAppServerSandboxTool({
        session: {
          ...workSession(),
          workspaceKind: "sandbox",
          workspaceId: "sandbox_allowed",
        },
        request: toolRequest("sandbox_status", {
          sandboxId: "sandbox_other",
        }),
        sandboxRequest: async () => ({ sandbox: {} }),
      }),
    ).rejects.toThrow("Hosted Work cannot target a different sandbox.");
  });
});

function toolRequest(
  action: WorkspaceToolRequest["action"],
  args: Record<string, unknown>,
): WorkspaceToolRequest {
  return { action, args, source: "chat_action" };
}

function workSession(): Session {
  return {
    id: "work_task_1",
    experience: "work",
    provider: "openpond",
    modelRef: null,
    openPondCommandAccessMode: "disabled",
    systemKind: null,
    hiddenFromDefaultSidebar: true,
    parentSessionId: null,
    parentTurnId: null,
    subagentRunId: null,
    subagentRoleId: null,
    subagentDelegationMode: null,
    title: "Work",
    archived: false,
    appId: null,
    appName: null,
    cwd: "/workspace",
    cloudProjectId: "project_1",
    cloudTeamId: "team_1",
    currentProfile: null,
    workspaceKind: undefined,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    codexThreadId: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    status: "idle",
    runtimeSeconds: 0,
    runtimeRunningSince: null,
    pinned: false,
    savedForLater: false,
    order: 0,
  };
}
