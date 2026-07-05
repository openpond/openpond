import { describe, expect, test } from "bun:test";
import type { Session } from "@openpond/contracts";
import {
  hybridWorkspaceSessionMetadata,
  isHybridWorkspaceSession,
  sessionWorkspaceLocation,
} from "../apps/web/src/lib/workspace-location";

describe("workspace location metadata", () => {
  test("marks hybrid sessions as sandbox-backed cloud sessions", () => {
    const session: Session = {
      id: "session_1",
      provider: "codex",
      modelRef: null,
      title: "Hybrid",
      appId: null,
      appName: null,
      workspaceKind: "sandbox",
      workspaceId: null,
      workspaceName: "Hybrid workspace",
      localProjectId: "local_project_1",
      cloudProjectId: "cloud_project_1",
      cloudTeamId: "team_1",
      metadata: hybridWorkspaceSessionMetadata({ source: "test" }),
      cwd: "/workspace/project",
      codexThreadId: null,
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z",
      status: "idle",
      pinned: false,
      archived: false,
      order: 0,
    };

    expect(session.metadata).toEqual({ source: "test", workspaceTarget: "hybrid" });
    expect(isHybridWorkspaceSession(session)).toBe(true);
    expect(sessionWorkspaceLocation(session)).toBe("cloud");
  });
});
