import { describe, expect, test } from "bun:test";
import type { CloudProject, LocalProject, WorkspaceState } from "@openpond/contracts";
import {
  cloudWorkspaceStateNote,
  localWorkspaceStateNote,
  projectCapabilityNote,
  uploadSyncStateNote,
} from "../apps/web/src/lib/project-workflow-state";

const NOW = "2026-07-02T12:00:00.000Z";

describe("project workflow state labels", () => {
  test("summarizes local branch, dirty, untracked, and ahead state", () => {
    expect(
      localWorkspaceStateNote(
        workspaceState({
          currentBranch: "feature/invoices",
          ahead: 2,
          changedFilesCount: 3,
          dirty: true,
          untrackedFilesCount: 1,
        }),
      ),
    ).toBe("feature/invoices / ahead by 2 commits / 3 changed / 1 untracked");
  });

  test("shows synced local checkouts when there are no repo deltas", () => {
    expect(localWorkspaceStateNote(workspaceState())).toBe("main / synced");
  });

  test("uses linked cloud setup state and detects manifest drift", () => {
    const project = localProject({
      sandboxTemplate: {
        detected: true,
        rootPath: "/repo",
        manifestPath: "openpond.yaml",
        manifestHash: "local_hash",
        manifest: null,
        normalizedManifest: null,
        valid: true,
        diagnostics: [],
      },
      linkedSandboxProject: sandboxProjectLink({
        manifestPath: "openpond.yaml",
        manifestHash: "old_hash",
      }),
    });

    expect(cloudWorkspaceStateNote(project, null)).toBe("main / needs sync");
  });

  test("summarizes upload work from local git status", () => {
    expect(
      uploadSyncStateNote(
        localProject(),
        workspaceState({
          ahead: 1,
          changedFilesCount: 2,
          dirty: true,
          untrackedFilesCount: 4,
        }),
      ),
    ).toBe("upload required / 1 commit / 2 changed files / 4 untracked skipped");
  });

  test("labels linked local projects as local and cloud capable", () => {
    const project = localProject({
      linkedSandboxProject: sandboxProjectLink(),
    });

    expect(
      projectCapabilityNote({
        kind: "local",
        localProject: project,
        workspaceState: workspaceState({ behind: 1 }),
      }),
    ).toBe("Local + Cloud / main / behind by 1 commit");
    expect(
      projectCapabilityNote({
        kind: "cloud",
        cloudProject: cloudProject({ defaultBranch: "release" }),
      }),
    ).toBe("Cloud / release");
  });

  test("prefers linked cloud source freshness over generic upstream status", () => {
    const state = workspaceState({
      headCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      linkedSourceHeadCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      aheadOfLinkedSource: 2,
      ahead: 0,
      currentBranch: "main",
    });
    const project = localProject({
      linkedSandboxProject: sandboxProjectLink({
        lastUploadedCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    });

    expect(localWorkspaceStateNote(state)).toBe("main / local ahead by 2 commits");
    expect(cloudWorkspaceStateNote(project, null, state)).toBe("main / cloud behind local by 2 commits");
    expect(uploadSyncStateNote(project, state)).toBe("2 commits");
    expect(
      projectCapabilityNote({
        kind: "local",
        localProject: project,
        workspaceState: state,
      }),
    ).toBe("Local + Cloud / main / local ahead by 2 commits");
  });

  test("warns that dirty local files are not in cloud work targets", () => {
    const state = workspaceState({
      dirty: true,
      changedFilesCount: 1,
      headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      linkedSourceHeadCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const project = localProject({
      linkedSandboxProject: sandboxProjectLink({
        lastUploadedCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    });

    expect(cloudWorkspaceStateNote(project, null, state)).toBe("main / local dirty files not in cloud");
  });

  test("requires upload when a linked git project has no recorded cloud source commit", () => {
    const state = workspaceState({
      headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      currentBranch: "main",
    });
    const project = localProject({
      linkedSandboxProject: sandboxProjectLink({
        lastUploadedCommit: null,
      }),
    });

    expect(
      localWorkspaceStateNote(state, {
        branch: "main",
        linkedCloudSourceKnown: false,
      }),
    ).toBe("main / upload required");
    expect(cloudWorkspaceStateNote(project, null, state)).toBe("main / upload required");
    expect(uploadSyncStateNote(project, state)).toBe("upload required");
    expect(
      projectCapabilityNote({
        kind: "local",
        localProject: project,
        workspaceState: state,
      }),
    ).toBe("Local + Cloud / main / upload required");
  });
});

function localProject(overrides: Partial<LocalProject> = {}): LocalProject {
  return {
    id: "local_project_1",
    name: "Local Project",
    path: "/repo",
    workspacePath: "/repo",
    repoPath: "/repo",
    source: "git",
    sandboxTemplate: null,
    agentSdk: null,
    linkedOpenPondApp: null,
    linkedSandboxProject: null,
    preferredSandboxAgentId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function cloudProject(overrides: Partial<CloudProject> = {}): CloudProject {
  return {
    id: "cloud_project_1",
    teamId: "team_1",
    name: "Cloud Repo",
    slug: "cloud-repo",
    sourceType: "internal_repo",
    sourceLabel: "Cloud Repo",
    defaultBranch: "main",
    internalRepoPath: null,
    manifestPath: null,
    manifestHash: null,
    syncedAt: NOW,
    agentSdk: null,
    organizationName: "OpenPond",
    organizationSlug: "openpond",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function workspaceState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    appId: "local_project_1",
    source: "local_git",
    workspacePath: "/repo",
    repoPath: "/repo",
    initialized: true,
    remoteUrl: null,
    expectedRemoteUrl: null,
    currentBranch: "main",
    headCommit: null,
    upstreamBranch: "origin/main",
    ahead: 0,
    behind: 0,
    diverged: false,
    linkedSourceHeadCommit: null,
    aheadOfLinkedSource: 0,
    behindLinkedSource: 0,
    divergedFromLinkedSource: false,
    linkedSourceComparisonError: null,
    lastFetchAt: null,
    defaultBranch: "main",
    branches: ["main"],
    dirty: false,
    changedFilesCount: 0,
    untrackedFilesCount: 0,
    error: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function sandboxProjectLink(
  overrides: Partial<NonNullable<LocalProject["linkedSandboxProject"]>> = {},
): NonNullable<LocalProject["linkedSandboxProject"]> {
  return {
    teamId: "team_1",
    projectId: "cloud_project_1",
    projectSlug: "cloud-repo",
    projectName: "Cloud Repo",
    sourceRepoUrl: null,
    defaultBranch: "main",
    lastUploadedCommit: null,
    lastUploadTransport: null,
    manifestPath: null,
    manifestHash: null,
    syncedAt: NOW,
    linkedAt: NOW,
    ...overrides,
  };
}
