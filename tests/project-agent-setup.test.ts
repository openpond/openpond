import { describe, expect, test } from "bun:test";
import type { LocalProject } from "@openpond/contracts";
import { implicitOrganization, resolveProjectAgentSetup } from "../apps/web/src/lib/project-agent-setup";
import type { OpenPondOrganization } from "../apps/web/src/lib/organization-types";
import type { SandboxAgent, SandboxProject } from "../apps/web/src/lib/sandbox-types";

const ownerOrg: OpenPondOrganization = {
  teamId: "team_owner",
  name: "owner",
  displayName: "Owner Team",
  slug: "owner",
  role: "owner",
  status: "active",
  primaryContactEmail: null,
  customDomain: null,
  createdAt: "2026-05-29T00:00:00.000Z",
  updatedAt: "2026-05-29T00:00:00.000Z",
};

const memberOrg: OpenPondOrganization = {
  ...ownerOrg,
  role: "member",
};

function localProject(input: Partial<LocalProject> = {}): LocalProject {
  return {
    id: "local_project",
    name: "Local Project",
    path: "/repo",
    workspacePath: "/repo",
    repoPath: "/repo",
    source: "git",
    sandboxTemplate: null,
    linkedOpenPondApp: null,
    linkedSandboxProject: null,
    preferredSandboxAgentId: null,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...input,
  };
}

function sandboxProject(input: Partial<SandboxProject> = {}): SandboxProject {
  return {
    id: "project_1",
    teamId: "team_owner",
    createdByUserId: "user_1",
    name: "Sandbox Project",
    slug: "sandbox-project",
    description: null,
    status: "active",
    sourceType: "github_repo",
    sourceConfig: {},
    normalizedSourceIdentity: "github:owner/repo",
    externalId: null,
    gitProvider: "github",
    gitHost: "github.com",
    gitOwner: "owner",
    gitRepo: "repo",
    gitBranch: null,
    defaultBranch: "main",
    internalRepoPath: null,
    templateSourceProjectId: null,
    templateRepoUrl: null,
    templateBranch: null,
    templateRemoteSha: null,
    sandboxManifest: {},
    sandboxActionRegistry: {},
    sandboxManifestHash: "hash_1",
    sandboxManifestPath: "openpond.yaml",
    sandboxManifestSyncedAt: "2026-05-29T00:00:00.000Z",
    sandboxManifestError: null,
    metadata: {},
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    archivedAt: null,
    ...input,
  };
}

function sandboxAgent(input: Partial<SandboxAgent> = {}): SandboxAgent {
  return {
    id: "agent_1",
    teamId: "team_owner",
    createdByUserId: "user_1",
    name: "Agent",
    slug: "agent",
    description: null,
    status: "active",
    projectId: "project_1",
    workflowIntent: null,
    selectedEntrypoint: { scope: "entire_manifest", name: null },
    triggerType: "manual",
    endpointPolicy: {},
    backgroundTaskPolicy: {},
    defaultWorkflowMode: "attempt",
    defaultBranch: null,
    sourceRefOverride: null,
    defaultPromotionPolicy: "manual",
    defaultResourcePolicy: {},
    defaultLifecyclePolicy: {},
    defaultCheckpointPolicy: {},
    requiredIntegrationRefs: [],
    requiredEnvironmentVariableRefs: [],
    schedulePolicy: {},
    externalId: null,
    metadata: {},
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    archivedAt: null,
    ...input,
  };
}

describe("project agent setup resolver", () => {
  test("uses a manageable organization for implicit multi-team setup", () => {
    const member = { ...memberOrg, teamId: "team_member", displayName: "Member Team" };
    const admin = { ...ownerOrg, role: "admin" as const, teamId: "team_admin", displayName: "Admin Team" };

    expect(implicitOrganization([member, admin])?.teamId).toBe("team_admin");
  });

  test("asks admins to add config when openpond.yaml is missing", () => {
    const resolved = resolveProjectAgentSetup({
      localProject: localProject(),
      organizations: [ownerOrg],
      projects: [],
      agents: [],
    });
    expect(resolved.state).toBe("missing_config");
    expect(resolved.actionLabel).toBe("Add Agent config");
    expect(resolved.canAct).toBe(true);
  });

  test("asks to connect a project after openpond.yaml exists", () => {
    const resolved = resolveProjectAgentSetup({
      localProject: localProject({
        sandboxTemplate: {
          detected: true,
          rootPath: "/repo",
          manifestPath: "/repo/openpond.yaml",
          manifestHash: "hash_1",
          valid: true,
          diagnostics: [],
        },
      }),
      organizations: [ownerOrg],
      projects: [],
      agents: [],
    });
    expect(resolved.state).toBe("needs_project");
    expect(resolved.actionLabel).toBe("Connect Project");
  });

  test("asks to create an Agent after the linked Project is synced", () => {
    const project = sandboxProject();
    const resolved = resolveProjectAgentSetup({
      localProject: localProject({
        sandboxTemplate: {
          detected: true,
          rootPath: "/repo",
          manifestPath: "openpond.yaml",
          manifestHash: "hash_1",
          valid: true,
          diagnostics: [],
        },
        linkedSandboxProject: {
          teamId: "team_owner",
          projectId: project.id,
          projectSlug: project.slug,
          projectName: project.name,
          sourceRepoUrl: "https://github.com/owner/repo.git",
          defaultBranch: "main",
          manifestPath: "openpond.yaml",
          manifestHash: "hash_1",
          syncedAt: "2026-05-29T00:00:00.000Z",
          linkedAt: "2026-05-29T00:00:00.000Z",
        },
      }),
      organizations: [ownerOrg],
      projects: [project],
      agents: [],
    });
    expect(resolved.state).toBe("needs_agent");
    expect(resolved.actionLabel).toBe("Create Agent");
  });

  test("asks to sync when the linked Project has not synced cleanly", () => {
    const project = sandboxProject({ sandboxManifestSyncedAt: null });
    const resolved = resolveProjectAgentSetup({
      localProject: localProject({
        sandboxTemplate: {
          detected: true,
          rootPath: "/repo",
          manifestPath: "openpond.yaml",
          manifestHash: "hash_1",
          valid: true,
          diagnostics: [],
        },
        linkedSandboxProject: {
          teamId: "team_owner",
          projectId: project.id,
          manifestHash: "hash_1",
          linkedAt: "2026-05-29T00:00:00.000Z",
        },
      }),
      organizations: [ownerOrg],
      projects: [project],
      agents: [],
    });
    expect(resolved.state).toBe("needs_sync");
    expect(resolved.actionLabel).toBe("Sync Project");
  });

  test("asks to sync when the local manifest hash differs from the synced Project", () => {
    const project = sandboxProject({ sandboxManifestHash: "hash_1" });
    const resolved = resolveProjectAgentSetup({
      localProject: localProject({
        sandboxTemplate: {
          detected: true,
          rootPath: "/repo",
          manifestPath: "openpond.yaml",
          manifestHash: "hash_2",
          valid: true,
          diagnostics: [],
        },
        linkedSandboxProject: {
          teamId: "team_owner",
          projectId: project.id,
          manifestHash: "hash_1",
          linkedAt: "2026-05-29T00:00:00.000Z",
        },
      }),
      organizations: [ownerOrg],
      projects: [project],
      agents: [],
    });
    expect(resolved.state).toBe("needs_sync");
    expect(resolved.actionLabel).toBe("Sync Project");
  });

  test("returns ready when a matching Agent exists", () => {
    const project = sandboxProject();
    const agent = sandboxAgent();
    const resolved = resolveProjectAgentSetup({
      localProject: localProject({
        sandboxTemplate: {
          detected: true,
          rootPath: "/repo",
          manifestPath: "openpond.yaml",
          manifestHash: "hash_1",
          valid: true,
          diagnostics: [],
        },
        linkedSandboxProject: {
          teamId: "team_owner",
          projectId: project.id,
          manifestHash: "hash_1",
          linkedAt: "2026-05-29T00:00:00.000Z",
        },
        preferredSandboxAgentId: agent.id,
      }),
      organizations: [ownerOrg],
      projects: [project],
      agents: [agent],
    });
    expect(resolved.state).toBe("ready");
    expect(resolved.actionLabel).toBe("Run Agent");
    expect(resolved.agent?.id).toBe(agent.id);
  });

  test("blocks member setup actions with Ask admin", () => {
    const resolved = resolveProjectAgentSetup({
      localProject: localProject(),
      organizations: [memberOrg],
      projects: [],
      agents: [],
    });
    expect(resolved.state).toBe("blocked");
    expect(resolved.actionLabel).toBe("Ask admin");
    expect(resolved.canAct).toBe(false);
  });
});
