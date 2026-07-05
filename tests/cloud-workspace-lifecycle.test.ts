import { afterEach, describe, expect, test } from "bun:test";
import type { LocalProject, Session } from "@openpond/contracts";
import type { ClientConnection } from "../apps/web/src/api";
import { ensureCloudWorkspaceRunning } from "../apps/web/src/lib/cloud-workspace-lifecycle";
import { hybridWorkspaceSessionMetadata } from "../apps/web/src/lib/workspace-location";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("cloud workspace lifecycle", () => {
  test("materializes Hybrid sessions through sandbox_create runtime args", async () => {
    const session = baseHybridSession();
    const requests: Array<{
      authorization: string | null;
      body: unknown;
      method: string;
      path: string;
    }> = [];

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({
        authorization: headers.get("Authorization"),
        body,
        method: init?.method ?? "GET",
        path: url.pathname + url.search,
      });

      if (url.pathname === "/v1/sessions/session_hybrid/workspace-tools") {
        return jsonResponse({
          ok: true,
          action: "sandbox_create",
          output: "Started Hybrid sandbox.",
          data: {
            sandbox: {
              id: "sandbox_hybrid",
              name: "Hybrid Repo",
              state: "running",
              runtimeId: "runtime_hybrid",
              projectId: "cloud_project_1",
              teamId: "team_1",
            },
          },
        });
      }

      if (url.pathname === "/v1/bootstrap") {
        return jsonResponse({
          sessions: [
            {
              ...session,
              workspaceId: "sandbox_hybrid",
              workspaceName: "Hybrid Repo",
            },
          ],
        });
      }

      return jsonResponse({ error: `unexpected ${url.pathname}` }, 404);
    }) as typeof fetch;

    const result = await ensureCloudWorkspaceRunning({
      branch: "main",
      connection: connection(),
      localProject: localProject(),
      session,
      source: "openpond-app-hybrid-chat-preflight",
    });

    expect(result.status).toBe("started");
    expect(result.sandbox?.id).toBe("sandbox_hybrid");
    expect(result.session.workspaceId).toBe("sandbox_hybrid");
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /v1/sessions/session_hybrid/workspace-tools",
      "GET /v1/bootstrap?refreshCodex=1",
    ]);
    expect(requests[0]).toMatchObject({
      authorization: "Bearer test-token",
      body: {
        action: "sandbox_create",
        source: "ui_button",
        args: {
          teamId: "team_1",
          projectId: "cloud_project_1",
          workflowMode: "feature",
          runtimeBaseBranch: "main",
          runtimePromotionPolicy: "manual",
          runtime: {
            runtimeProfileId: "openpond-coding-core-v1",
            metadata: {
              source: "openpond-app-hybrid-chat-preflight",
              localProjectId: "local_project_1",
              localProjectName: "Local Repo",
            },
          },
          visibility: "team",
          budget: { maxUsd: "0.05" },
          quotas: {
            idleTimeoutSeconds: 900,
            maxSpendUsd: "0.05",
          },
          metadata: {
            source: "openpond-app-hybrid-chat-preflight",
            localProjectId: "local_project_1",
            localProjectName: "Local Repo",
          },
        },
      },
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain("runtimeAgent");
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function connection(): ClientConnection {
  return {
    serverUrl: "https://app-server.test",
    token: "test-token",
    platform: "test",
  };
}

function baseHybridSession(): Session {
  return {
    id: "session_hybrid",
    provider: "openai",
    modelRef: { providerId: "openai", modelId: "gpt-4.1-mini" },
    title: "Hybrid edit",
    appId: null,
    appName: null,
    workspaceKind: "sandbox",
    workspaceId: null,
    workspaceName: "Hybrid Repo",
    localProjectId: "local_project_1",
    cloudProjectId: "cloud_project_1",
    cloudTeamId: "team_1",
    metadata: hybridWorkspaceSessionMetadata(),
    cwd: "/workspace/local-repo",
    codexThreadId: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  };
}

function localProject(): LocalProject {
  return {
    id: "local_project_1",
    name: "Local Repo",
    path: "/workspace/local-repo",
    workspacePath: "/workspace/local-repo",
    repoPath: "/workspace/local-repo",
    source: "git",
    sandboxTemplate: null,
    linkedOpenPondApp: null,
    linkedSandboxProject: {
      projectId: "cloud_project_1",
      projectName: "Hybrid Repo",
      teamId: "team_1",
      defaultBranch: "main",
      projectSlug: "hybrid-repo",
      lastUploadedCommit: "abc123",
    },
    preferredSandboxAgentId: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
  };
}
