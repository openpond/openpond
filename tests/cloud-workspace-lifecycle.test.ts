import { afterEach, describe, expect, test } from "vitest";
import type { BootstrapPayload, Session } from "@openpond/contracts";
import type { ClientConnection } from "../apps/web/src/api";
import { ensureCloudWorkspaceRunning } from "../apps/web/src/lib/cloud-workspace-lifecycle";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("cloud workspace lifecycle client", () => {
  test("delegates Cloud readiness to the server-owned operation", async () => {
    const session = baseSession();
    const readySession = { ...session, workspaceId: "sandbox-ready" };
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        path: url.pathname + url.search,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (url.pathname.endsWith("/workspace/ensure-ready")) {
        return json({ session: readySession, status: "started", output: "ready" });
      }
      if (url.pathname === "/v1/bootstrap") {
        return json({ sessions: [readySession] });
      }
      return json({ error: "unexpected route" }, 404);
    }) as typeof fetch;

    const result = await ensureCloudWorkspaceRunning({
      branch: "feature/server-owned",
      connection: connection(),
      session,
      source: "openpond-app-cloud-chat-preflight",
    });

    expect(result).toMatchObject({ status: "started", session: { workspaceId: "sandbox-ready" } });
    expect(requests).toEqual([
      {
        path: "/v1/sessions/session-cloud/workspace/ensure-ready",
        method: "POST",
        body: { branch: "feature/server-owned", surface: "desktop" },
      },
      { path: "/v1/bootstrap?refreshCodex=1", method: "GET", body: null },
    ]);
  });

  test("does not call readiness for local sessions", async () => {
    const session = baseSession({ workspaceKind: "local_project" });
    globalThis.fetch = (async () => {
      throw new Error("local readiness must not call the server");
    }) as typeof fetch;
    await expect(ensureCloudWorkspaceRunning({
      connection: connection(),
      session,
      source: "openpond-app-cloud-chat-preflight",
    })).resolves.toMatchObject({ status: "already_running", session });
  });
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function connection(): ClientConnection {
  return { serverUrl: "https://app-server.test", token: "test-token", platform: "test" };
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
