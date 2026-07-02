import type { LocalProject } from "@openpond/contracts";
import { canManageOpenPondOrganization, type OpenPondOrganization } from "./organization-types";
import type { SandboxAgent, SandboxProject } from "./sandbox-types";

export type ProjectAgentSetupState =
  | "missing_config"
  | "needs_project"
  | "needs_sync"
  | "needs_agent"
  | "ready"
  | "blocked";

export type ProjectAgentSetupResolution = {
  state: ProjectAgentSetupState;
  actionLabel: string;
  canAct: boolean;
  reason: string | null;
  project: SandboxProject | null;
  agent: SandboxAgent | null;
};

export function resolveProjectAgentSetup(input: {
  localProject: LocalProject | null | undefined;
  organizations: OpenPondOrganization[];
  projects: SandboxProject[];
  agents: SandboxAgent[];
  defaultTeamId?: string | null;
}): ProjectAgentSetupResolution {
  const organization = implicitOrganization(input.organizations, input.defaultTeamId);
  const canManage = canManageOpenPondOrganization(organization);
  const localProject = input.localProject ?? null;
  if (!localProject) {
    return blocked("Open a local project to set up an Agent.");
  }

  const linkedProject = linkedSandboxProject(localProject, input.projects);
  const preferredAgent = preferredSandboxAgent(localProject, linkedProject, input.agents);
  const manifestDetected = Boolean(localProject.sandboxTemplate?.detected);
  const actionBlockedReason =
    organization && !canManage ? "Ask an owner or admin to connect this project." : null;

  if (!manifestDetected) {
    return withRole({
      state: "missing_config",
      actionLabel: "Add Agent config",
      project: linkedProject,
      agent: preferredAgent,
      canManage,
      actionBlockedReason,
    });
  }

  if (!linkedProject) {
    return withRole({
      state: "needs_project",
      actionLabel: "Connect Project",
      project: null,
      agent: null,
      canManage,
      actionBlockedReason,
    });
  }

  if (projectNeedsSync(localProject, linkedProject)) {
    return withRole({
      state: "needs_sync",
      actionLabel: "Sync Project",
      project: linkedProject,
      agent: preferredAgent,
      canManage,
      actionBlockedReason,
    });
  }

  if (!preferredAgent) {
    return withRole({
      state: "needs_agent",
      actionLabel: "Create Agent",
      project: linkedProject,
      agent: null,
      canManage,
      actionBlockedReason,
    });
  }

  return {
    state: "ready",
    actionLabel: "Run Agent",
    canAct: true,
    reason: null,
    project: linkedProject,
    agent: preferredAgent,
  };
}

function withRole(input: {
  state: Exclude<ProjectAgentSetupState, "ready" | "blocked">;
  actionLabel: string;
  project: SandboxProject | null;
  agent: SandboxAgent | null;
  canManage: boolean;
  actionBlockedReason: string | null;
}): ProjectAgentSetupResolution {
  if (!input.canManage) {
    return {
      state: "blocked",
      actionLabel: "Ask admin",
      canAct: false,
      reason: input.actionBlockedReason,
      project: input.project,
      agent: input.agent,
    };
  }
  return {
    state: input.state,
    actionLabel: input.actionLabel,
    canAct: true,
    reason: null,
    project: input.project,
    agent: input.agent,
  };
}

function blocked(reason: string): ProjectAgentSetupResolution {
  return {
    state: "blocked",
    actionLabel: "Ask admin",
    canAct: false,
    reason,
    project: null,
    agent: null,
  };
}

export function implicitOrganization(
  organizations: OpenPondOrganization[],
  defaultTeamId?: string | null,
): OpenPondOrganization | null {
  if (organizations.length === 0) return null;
  const normalizedDefaultTeamId = defaultTeamId?.trim() ?? "";
  if (normalizedDefaultTeamId) {
    const defaultOrganization = organizations.find(
      (organization) => organization.teamId === normalizedDefaultTeamId,
    );
    if (defaultOrganization) return defaultOrganization;
  }
  if (organizations.length === 1) return organizations[0] ?? null;
  return (
    organizations.find((organization) => organization.role === "owner") ??
    organizations.find((organization) => organization.role === "admin") ??
    organizations[0] ??
    null
  );
}

function linkedSandboxProject(
  localProject: LocalProject,
  projects: SandboxProject[],
): SandboxProject | null {
  const linked = localProject.linkedSandboxProject;
  if (!linked?.projectId) return null;
  return projects.find((project) => project.id === linked.projectId) ?? null;
}

function preferredSandboxAgent(
  localProject: LocalProject,
  project: SandboxProject | null,
  agents: SandboxAgent[],
): SandboxAgent | null {
  if (!project) return null;
  const preferredId = localProject.preferredSandboxAgentId;
  if (preferredId) {
    const preferred = agents.find((agent) => agent.id === preferredId && agent.projectId === project.id);
    if (preferred) return preferred;
  }
  return agents.find((agent) => agent.projectId === project.id) ?? null;
}

function projectNeedsSync(localProject: LocalProject, project: SandboxProject): boolean {
  if (project.sandboxManifestError) return true;
  if (!project.sandboxManifestSyncedAt) return true;
  if (!project.sandboxManifestHash) return true;
  if (localProject.sandboxTemplate?.manifestHash && project.sandboxManifestHash) {
    return localProject.sandboxTemplate.manifestHash !== project.sandboxManifestHash;
  }
  if (localProject.linkedSandboxProject?.manifestHash && project.sandboxManifestHash) {
    return localProject.linkedSandboxProject.manifestHash !== project.sandboxManifestHash;
  }
  const localManifestPath = localProject.sandboxTemplate?.manifestPath;
  if (localManifestPath && project.sandboxManifestPath) {
    return !localManifestPath.endsWith(project.sandboxManifestPath);
  }
  return false;
}
