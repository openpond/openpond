import { describe, expect, test } from "bun:test";
import type { Session } from "@openpond/contracts";
import {
  cloudSessionBelongsToAccount,
  cloudWorkspaceReadyMessage,
  cloudWorkspaceStartingMessage,
} from "../apps/web/src/hooks/useCloudSessionReady";
import { hybridWorkspaceSessionMetadata } from "../apps/web/src/lib/workspace-location";

describe("cloud session readiness copy", () => {
  test("uses transient Hybrid sandbox progress copy for Hybrid sessions", () => {
    const session = baseSession({
      provider: "codex",
      metadata: hybridWorkspaceSessionMetadata(),
    });

    expect(cloudWorkspaceStartingMessage(session)).toBe("Preparing Hybrid sandbox...");
    expect(cloudWorkspaceReadyMessage("waited_for_creating", session)).toBe(
      "Hybrid sandbox is ready.",
    );
    expect(cloudWorkspaceReadyMessage("started", session)).toBe("Started Hybrid sandbox.");
    expect(cloudWorkspaceReadyMessage("already_running", session)).toBeNull();
  });

  test("keeps existing Cloud workspace copy for normal cloud sessions", () => {
    const session = baseSession({ provider: "openpond" });

    expect(cloudWorkspaceStartingMessage(session)).toBe("Starting Cloud workspace...");
    expect(cloudWorkspaceReadyMessage("resumed", session)).toBe("Resumed Cloud workspace.");
    expect(cloudWorkspaceReadyMessage("restored", session)).toBe("Restored Cloud workspace.");
    expect(cloudWorkspaceReadyMessage("recreated", session)).toBe("Recreated Cloud workspace.");
  });

  test("detects Cloud sessions from a different account", () => {
    const session = baseSession({
      cloudProjectId: "old_account_project",
      cloudTeamId: "team_1",
    });

    expect(
      cloudSessionBelongsToAccount(session, [
        {
          id: "current_account_project",
          teamId: "team_1",
          name: "Current Project",
          slug: "current-project",
          sourceType: "internal_repo",
          sourceLabel: "Current Project",
          defaultBranch: "main",
          internalRepoPath: null,
          manifestPath: null,
          manifestHash: null,
          syncedAt: "2026-07-04T00:00:00.000Z",
          agentSdk: null,
          organizationName: "OpenPond",
          organizationSlug: "openpond",
          createdAt: "2026-07-04T00:00:00.000Z",
          updatedAt: "2026-07-04T00:00:00.000Z",
        },
      ]),
    ).toBe(false);
  });
});

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openpond",
    modelRef: null,
    title: "Workspace",
    appId: null,
    appName: null,
    workspaceKind: "sandbox",
    workspaceId: null,
    workspaceName: "Workspace",
    localProjectId: "local_project_1",
    cloudProjectId: "cloud_project_1",
    cloudTeamId: "team_1",
    cwd: "/workspace/project",
    codexThreadId: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}
