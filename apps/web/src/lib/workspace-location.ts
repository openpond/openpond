import type { LocalProject, Session, WorkspaceKind } from "@openpond/contracts";

export type WorkspaceLocation = "local" | "cloud";

export type WorkspaceTargetOptionState = {
  value: WorkspaceLocation;
  label: string;
  detail: string;
  disabled: boolean;
  disabledReason?: string | null;
};

export type WorkspaceTargetState = {
  value: WorkspaceLocation;
  label: string;
  detail: string;
  options: WorkspaceTargetOptionState[];
  action: WorkspaceTargetOptionState & {
    label: string;
  };
  busy: boolean;
};

export function isCloudWorkspaceKind(kind: WorkspaceKind | null | undefined): boolean {
  return kind === "sandbox" || kind === "sandbox_template" || kind === "sandbox_app";
}

export function isPendingCloudStartSession(session: Session | null | undefined): boolean {
  return Boolean(
    session &&
      session.provider === "openpond" &&
      session.workspaceKind === "local_project" &&
      session.cloudProjectId &&
      session.title.trim().endsWith(" Cloud"),
  );
}

export function sessionWorkspaceLocation(session: Session): WorkspaceLocation | null {
  if (isPendingCloudStartSession(session)) return "cloud";
  if (isCloudWorkspaceKind(session.workspaceKind)) return "cloud";
  if (session.workspaceKind === "local_project" || session.cwd) return "local";
  return null;
}

export function projectHasCloudLink(project: LocalProject): boolean {
  return Boolean(project.linkedSandboxProject?.projectId || project.linkedOpenPondApp?.appId);
}

export function cloudProjectLabel(project: LocalProject | null | undefined): string | null {
  const linked = project?.linkedSandboxProject;
  return linked?.projectName ?? linked?.projectSlug ?? linked?.projectId ?? null;
}
