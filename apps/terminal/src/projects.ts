import type {
  BootstrapPayload,
  ChatProvider,
  CloudProject,
  CreateSessionRequest,
  LocalProject,
  OpenPondApp,
} from "@openpond/contracts";

export type TerminalProjectTarget = {
  kind: "local_project" | "cloud_project" | "sandbox_app";
  id: string;
  label: string;
  session: Partial<CreateSessionRequest>;
  provider?: ChatProvider;
};

export function resolveTerminalProjectTarget(
  payload: BootstrapPayload,
  query: string | null | undefined,
): TerminalProjectTarget | null {
  const normalized = normalizeProjectQuery(query);
  if (!normalized) return null;

  const localProject = payload.localProjects.find((project) => matchesLocalProject(project, normalized));
  if (localProject) {
    return {
      kind: "local_project",
      id: localProject.id,
      label: localProject.name,
      session: {
        appId: localProject.linkedOpenPondApp?.appId ?? null,
        appName: localProject.linkedOpenPondApp?.appName ?? null,
        workspaceKind: "local_project",
        workspaceId: localProject.id,
        workspaceName: localProject.name,
        localProjectId: localProject.id,
        cloudProjectId: localProject.linkedSandboxProject?.projectId ?? null,
        cloudTeamId: localProject.linkedSandboxProject?.teamId ?? null,
        cwd: localProject.workspacePath,
      },
    };
  }

  const cloudProject = payload.cloudProjects.find((project) => matchesCloudProject(project, normalized));
  if (cloudProject) {
    return {
      kind: "cloud_project",
      id: cloudProject.id,
      label: cloudProject.name,
      provider: "openpond",
      session: {
        appId: null,
        appName: null,
        workspaceKind: "sandbox",
        workspaceId: cloudProject.id,
        workspaceName: cloudProject.name,
        cloudProjectId: cloudProject.id,
        cloudTeamId: cloudProject.teamId,
        cwd: null,
      },
    };
  }

  const app = payload.apps.find((candidate) => matchesApp(candidate, normalized));
  if (app) {
    return {
      kind: "sandbox_app",
      id: app.id,
      label: app.name,
      session: {
        appId: app.id,
        appName: app.name,
        workspaceKind: "sandbox_app",
        workspaceId: app.id,
        workspaceName: app.name,
      },
    };
  }

  return null;
}

export function formatTerminalProjects(payload: BootstrapPayload): string {
  const rows = [
    ...payload.localProjects.map((project) => `local  ${project.id}  ${project.name}  ${project.workspacePath}`),
    ...payload.cloudProjects.map((project) => `cloud  ${project.id}  ${project.name}${project.slug ? ` (${project.slug})` : ""}`),
    ...payload.apps.map((app) => `app    ${app.id}  ${app.name}`),
  ];
  return rows.length ? rows.join("\n") : "No local projects, cloud projects, or OpenPond apps returned.";
}

function normalizeProjectQuery(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function matchesLocalProject(project: LocalProject, query: string): boolean {
  return [project.id, project.name, project.path, project.workspacePath, project.repoPath ?? ""].some((value) =>
    value.trim().toLowerCase() === query
  );
}

function matchesCloudProject(project: CloudProject, query: string): boolean {
  return [project.id, project.name, project.slug ?? ""].some((value) => value.trim().toLowerCase() === query);
}

function matchesApp(app: OpenPondApp, query: string): boolean {
  return [app.id, app.name].some((value) => value.trim().toLowerCase() === query);
}
