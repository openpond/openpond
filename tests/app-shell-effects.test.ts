import { describe, expect, test } from "bun:test";
import type { Session } from "@openpond/contracts";
import { shouldForceCloudWorkspaceProviderOpenPond } from "../apps/web/src/hooks/useAppShellEffects";
import { hybridWorkspaceSessionMetadata } from "../apps/web/src/lib/workspace-location";

describe("app shell effects", () => {
  test("does not force Hybrid sandbox sessions back to OpenPond", () => {
    expect(
      shouldForceCloudWorkspaceProviderOpenPond(
        session({
          provider: "codex",
          metadata: hybridWorkspaceSessionMetadata(),
        }),
      ),
    ).toBe(false);
  });

  test("still forces non-Hybrid cloud workspaces to OpenPond", () => {
    expect(shouldForceCloudWorkspaceProviderOpenPond(session({ provider: "codex" }))).toBe(true);
    expect(shouldForceCloudWorkspaceProviderOpenPond(session({ provider: "openpond" }))).toBe(false);
    expect(
      shouldForceCloudWorkspaceProviderOpenPond(
        session({
          provider: "codex",
          workspaceKind: "local_project",
          metadata: null,
        }),
      ),
    ).toBe(false);
  });
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openpond",
    modelRef: null,
    title: "Test session",
    appId: null,
    appName: null,
    workspaceKind: "sandbox",
    workspaceId: "cloud_project_1",
    workspaceName: "Cloud Project",
    localProjectId: null,
    cloudProjectId: "cloud_project_1",
    cloudTeamId: "team_1",
    metadata: null,
    cwd: null,
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
