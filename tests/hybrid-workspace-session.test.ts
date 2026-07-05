import { describe, expect, test } from "bun:test";
import type { CloudProject, LocalProject } from "@openpond/contracts";
import {
  buildHybridWorkspaceSessionRequest,
  resolveHybridWorkspaceTarget,
} from "../apps/web/src/lib/hybrid-workspace-session";

describe("hybrid workspace session request", () => {
  test("builds a lazy sandbox session while preserving a selected local BYOK provider and model", () => {
    const target = resolveHybridWorkspaceTarget({
      selectedCloudProject: null,
      selectedProject: localProject({
        linkedSandboxProject: {
          projectId: "cloud_project_1",
          projectName: "Cloud Repo",
          teamId: "team_1",
          defaultBranch: "main",
          projectSlug: "cloud-repo",
          lastUploadedCommit: "abc123",
        },
      }),
    });

    expect(target).toMatchObject({ kind: "ready" });
    if (target.kind !== "ready") throw new Error("expected ready target");

    const request = buildHybridWorkspaceSessionRequest({
      provider: "openai",
      modelRef: { providerId: "openai", modelId: "gpt-4.1-mini" },
      target,
      title: "Hybrid edit",
    });

    expect(request).toMatchObject({
      provider: "openai",
      modelRef: { providerId: "openai", modelId: "gpt-4.1-mini" },
      appId: null,
      appName: null,
      workspaceKind: "sandbox",
      workspaceId: null,
      workspaceName: "Cloud Repo",
      localProjectId: "local_project_1",
      cloudProjectId: "cloud_project_1",
      cloudTeamId: "team_1",
      metadata: { workspaceTarget: "hybrid" },
      cwd: "/workspace/local-project",
      title: "Hybrid edit",
    });
  });

  test("keeps OpenPond Chat selected when Hybrid uses a cloud project directly", () => {
    const target = resolveHybridWorkspaceTarget({
      selectedCloudProject: cloudProject(),
      selectedProject: null,
    });

    expect(target).toMatchObject({ kind: "ready" });
    if (target.kind !== "ready") throw new Error("expected ready target");

    expect(
      buildHybridWorkspaceSessionRequest({
        provider: "openpond",
        modelRef: { providerId: "openpond", modelId: "openpond-chat" },
        target,
        title: "Cloud Hybrid",
      }),
    ).toMatchObject({
      provider: "openpond",
      modelRef: { providerId: "openpond", modelId: "openpond-chat" },
      workspaceKind: "sandbox",
      workspaceId: null,
      workspaceName: "Cloud Repo",
      cloudProjectId: "cloud_project_1",
      cloudTeamId: "team_1",
      metadata: { workspaceTarget: "hybrid" },
    });
  });

  test("requires a linked hosted project before Hybrid can create a sandbox session", () => {
    expect(
      resolveHybridWorkspaceTarget({
        selectedCloudProject: null,
        selectedProject: localProject({ linkedSandboxProject: null }),
      }),
    ).toEqual({
      kind: "missing_cloud_project",
      message: "Upload/sync this Project to Cloud before using Hybrid.",
    });
  });
});

function cloudProject(overrides: Partial<CloudProject> = {}): CloudProject {
  return {
    id: "cloud_project_1",
    teamId: "team_1",
    name: "Cloud Repo",
    slug: "cloud-repo",
    sourceType: "github_repo",
    sourceLabel: "openpond/cloud-repo",
    defaultBranch: "main",
    internalRepoPath: null,
    manifestPath: null,
    manifestHash: null,
    syncedAt: "2026-07-04T00:00:00.000Z",
    organizationName: "OpenPond",
    organizationSlug: "openpond",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    ...overrides,
  };
}

function localProject(overrides: Partial<LocalProject> = {}): LocalProject {
  return {
    id: "local_project_1",
    name: "Local Project",
    path: "/workspace/local-project",
    workspacePath: "/workspace/local-project",
    repoPath: "/workspace/local-project",
    source: "git",
    sandboxTemplate: null,
    linkedOpenPondApp: null,
    linkedSandboxProject: null,
    preferredSandboxAgentId: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    ...overrides,
  };
}
