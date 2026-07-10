import { describe, expect, test } from "bun:test";
import type { Session, WorkspaceToolResult } from "@openpond/contracts";
import { createCloudSessionReadinessService } from "../apps/server/src/workspace/cloud-session-readiness";

describe("server-owned Cloud session readiness", () => {
  test("creates and attaches a bounded coding runtime using server policy", async () => {
    let session = baseSession();
    let toolPayload: Record<string, unknown> | null = null;
    const service = createCloudSessionReadinessService({
      getSession: async () => session,
      sandboxRequest: async (payload) => {
        expect(payload).toMatchObject({ type: "project_get", projectId: "cloud-project" });
        return { project: { id: "cloud-project" } };
      },
      executeWorkspaceTool: async (_sessionId, payload) => {
        toolPayload = payload as Record<string, unknown>;
        session = { ...session, workspaceId: "sandbox-new" };
        return toolResult({ id: "sandbox-new", state: "running", runtimeId: "runtime-new" });
      },
    });

    const result = await service.ensureReady("session-cloud", {
      branch: "feature/readiness",
      surface: "terminal",
    });

    expect(result).toMatchObject({ status: "started", session: { workspaceId: "sandbox-new" } });
    expect(toolPayload).toMatchObject({
      action: "sandbox_create",
      source: "ui_button",
      args: {
        teamId: "team-1",
        projectId: "cloud-project",
        runtimeBaseBranch: "feature/readiness",
        runtime: {
          runtimeProfileId: "openpond-coding-core-v1",
          metadata: { source: "openpond-terminal-cloud-chat-preflight" },
        },
        budget: { maxUsd: "0.05" },
        quotas: { idleTimeoutSeconds: 900, maxSpendUsd: "0.05" },
      },
    });
  });

  test("deduplicates concurrent waiters and polls an attached creating sandbox once", async () => {
    const session = baseSession({ workspaceId: "sandbox-creating" });
    let sandboxReads = 0;
    let projectReads = 0;
    const service = createCloudSessionReadinessService({
      getSession: async () => session,
      executeWorkspaceTool: async () => {
        throw new Error("attached sandbox must not be recreated");
      },
      sandboxRequest: async (payload) => {
        const request = payload as { type: string };
        if (request.type === "project_get") {
          projectReads += 1;
          return { project: { id: "cloud-project" } };
        }
        sandboxReads += 1;
        return {
          sandbox: {
            id: "sandbox-creating",
            state: sandboxReads === 1 ? "creating" : "running",
            createdAt: "2026-07-10T00:00:00.000Z",
          },
        };
      },
      delay: async () => undefined,
      now: () => Date.parse("2026-07-10T00:00:01.000Z"),
    });

    const first = service.ensureReady("session-cloud", { surface: "desktop" });
    const second = service.ensureReady("session-cloud", { surface: "desktop" });
    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ status: "waited_for_creating" });
    expect(projectReads).toBe(1);
    expect(sandboxReads).toBe(2);
  });

  test("rejects a Cloud Project that is unavailable in the active account", async () => {
    const service = createCloudSessionReadinessService({
      getSession: async () => baseSession(),
      executeWorkspaceTool: async () => toolResult(null),
      sandboxRequest: async () => {
        throw new Error("not found");
      },
    });
    await expect(service.ensureReady("session-cloud", { surface: "terminal" })).rejects.toThrow(
      "different OpenPond account",
    );
  });
});

function toolResult(sandbox: Record<string, unknown> | null): WorkspaceToolResult {
  return {
    ok: true,
    action: "sandbox_create",
    output: "ready",
    data: sandbox ? { sandbox } : undefined,
  };
}

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-cloud",
    provider: "openpond",
    modelRef: null,
    title: "Cloud",
    appId: null,
    appName: null,
    workspaceKind: "sandbox",
    workspaceId: null,
    workspaceName: "Cloud project",
    localProjectId: "local-project",
    cloudProjectId: "cloud-project",
    cloudTeamId: "team-1",
    cwd: "/workspace/project",
    codexThreadId: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}
