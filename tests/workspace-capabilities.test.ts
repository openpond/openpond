import { describe, expect, test } from "bun:test";
import type { LocalProject, Session } from "@openpond/contracts";
import { resolveWorkspaceCapabilities, workspaceToolBlockedMessage } from "../apps/server/src/workspace/workspace-capabilities";

const baseSession: Session = {
  id: "session_1",
  provider: "openpond",
  title: "Workspace",
  appId: null,
  appName: null,
  workspaceKind: "local_project",
  workspaceId: "project_1",
  workspaceName: "Project",
  cwd: "/tmp/project",
  codexThreadId: null,
  createdAt: "2026-05-21T00:00:00.000Z",
  updatedAt: "2026-05-21T00:00:00.000Z",
  status: "idle",
  pinned: false,
  archived: false,
  order: 0,
};

function project(overrides: Partial<LocalProject>): LocalProject {
  return {
    id: "project_1",
    name: "Project",
    path: "/tmp/project",
    workspacePath: "/tmp/project",
    repoPath: "/tmp/project",
    source: "git",
    sandboxTemplate: null,
    linkedOpenPondApp: null,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("workspace capabilities", () => {
  test("routes openpond.yaml projects to sandbox template actions", () => {
    const localProject = project({
      sandboxTemplate: {
        detected: true,
        rootPath: "/tmp/project",
        manifestPath: "/tmp/project/openpond.yaml",
        manifest: {},
        normalizedManifest: null,
        valid: false,
        diagnostics: [],
      },
    });

    const capabilities = resolveWorkspaceCapabilities({ session: baseSession, localProject });

    expect(capabilities.productKind).toBe("sandbox_template");
    expect(capabilities.checks.validate).toBe("validate_sandbox_template");
    expect(capabilities.checks.build).toBe("build_sandbox_template");
    expect(workspaceToolBlockedMessage({ action: "validate_sandbox_template", session: baseSession, localProject })).toBeNull();
  });

  test("limits sandbox workspace sessions to sandbox actions", () => {
    const session: Session = {
      ...baseSession,
      workspaceKind: "sandbox",
      workspaceId: "sandbox_1",
      workspaceName: "Sandbox",
    };

    expect(workspaceToolBlockedMessage({ action: "sandbox_status", session })).toBeNull();
    expect(workspaceToolBlockedMessage({ action: "read_files", session })).toBe(
      "Use sandbox_* workspace actions for sandbox workspaces."
    );
  });
});
