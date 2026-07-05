import type { LocalProject, Session, WorkspaceState } from "@openpond/contracts";

export type WorkspaceExecutionTarget =
  | {
    target: "sandbox";
    ready: boolean;
    workspaceKind: string;
    workspaceId: string | null;
    workspaceName: string | null;
    sandboxId: string | null;
    cloudProjectId: string | null;
    cloudTeamId: string | null;
    localProjectId: string | null;
    hybrid: boolean;
    reason: "sandbox_session" | "sandbox_template_session" | "sandbox_app_session";
  }
  | {
    target: "local";
    ready: boolean;
    workspaceKind: string | null;
    workspaceId: string | null;
    workspaceName: string | null;
    localProjectId: string | null;
    cwd: string | null;
    projectPath: string | null;
    reason: "local_project_session" | "cwd_session" | "local_project_context";
  }
  | {
    target: "none";
    ready: false;
    workspaceKind: string | null;
    workspaceId: string | null;
    workspaceName: string | null;
    reason: "no_workspace" | "unsupported_workspace";
  };

export function resolveWorkspaceExecutionTarget(input: {
  session: Session;
  localProject?: LocalProject | null;
  state?: WorkspaceState | null;
}): WorkspaceExecutionTarget {
  const workspaceKind = input.session.workspaceKind ?? null;
  if (
    workspaceKind === "sandbox" ||
    workspaceKind === "sandbox_template" ||
    workspaceKind === "sandbox_app"
  ) {
    return {
      target: "sandbox",
      ready: Boolean(input.session.workspaceId),
      workspaceKind,
      workspaceId: input.session.workspaceId ?? null,
      workspaceName: input.session.workspaceName ?? null,
      sandboxId: input.session.workspaceId ?? null,
      cloudProjectId: input.session.cloudProjectId ?? null,
      cloudTeamId: input.session.cloudTeamId ?? null,
      localProjectId: input.session.localProjectId ?? null,
      hybrid: input.session.metadata?.workspaceTarget === "hybrid",
      reason:
        workspaceKind === "sandbox_template"
          ? "sandbox_template_session"
          : workspaceKind === "sandbox_app"
            ? "sandbox_app_session"
            : "sandbox_session",
    };
  }

  if (workspaceKind === "local_project") {
    const projectId = input.session.workspaceId ?? input.localProject?.id ?? input.session.localProjectId ?? null;
    const projectPath =
      input.localProject?.workspacePath ??
      input.localProject?.repoPath ??
      input.localProject?.path ??
      input.session.cwd ??
      input.state?.repoPath ??
      null;
    return {
      target: "local",
      ready: Boolean(projectId || projectPath),
      workspaceKind,
      workspaceId: projectId,
      workspaceName: input.session.workspaceName ?? input.localProject?.name ?? null,
      localProjectId: projectId,
      cwd: input.session.cwd ?? projectPath,
      projectPath,
      reason: "local_project_session",
    };
  }

  const projectPath =
    input.localProject?.workspacePath ??
    input.localProject?.repoPath ??
    input.localProject?.path ??
    input.session.cwd ??
    input.state?.repoPath ??
    null;
  if (projectPath || input.localProject) {
    return {
      target: "local",
      ready: true,
      workspaceKind,
      workspaceId: input.localProject?.id ?? input.session.workspaceId ?? input.session.localProjectId ?? null,
      workspaceName: input.session.workspaceName ?? input.localProject?.name ?? null,
      localProjectId: input.localProject?.id ?? input.session.localProjectId ?? null,
      cwd: input.session.cwd ?? projectPath,
      projectPath,
      reason: input.localProject ? "local_project_context" : "cwd_session",
    };
  }

  if (input.session.localProjectId) {
    return {
      target: "local",
      ready: true,
      workspaceKind,
      workspaceId: input.session.workspaceId ?? input.session.localProjectId,
      workspaceName: input.session.workspaceName ?? null,
      localProjectId: input.session.localProjectId,
      cwd: input.session.cwd ?? null,
      projectPath: null,
      reason: "local_project_context",
    };
  }

  return {
    target: "none",
    ready: false,
    workspaceKind,
    workspaceId: input.session.workspaceId ?? null,
    workspaceName: input.session.workspaceName ?? null,
    reason: workspaceKind ? "unsupported_workspace" : "no_workspace",
  };
}

export function isSandboxExecutionTarget(target: WorkspaceExecutionTarget): target is Extract<
  WorkspaceExecutionTarget,
  { target: "sandbox" }
> {
  return target.target === "sandbox";
}
