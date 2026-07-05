import type { LocalProject, Session, WorkspaceKind } from "@openpond/contracts";

export type WorkspaceLocation = "local" | "cloud";
export type WorkspaceTargetValue = WorkspaceLocation | "hybrid" | "queue_cloud" | "upload_cloud";

export type WorkspaceTargetOptionState = {
  value: WorkspaceTargetValue;
  label: string;
  detail: string;
  stateNote?: string | null;
  disabled: boolean;
  disabledReason?: string | null;
};

export type WorkspaceTargetState = {
  value: WorkspaceTargetValue;
  label: string;
  detail: string;
  options: WorkspaceTargetOptionState[];
  uploadAction?: WorkspaceTargetOptionState | null;
  action: WorkspaceTargetOptionState & {
    label: string;
  };
  busy: boolean;
};

export function isCloudWorkspaceKind(kind: WorkspaceKind | null | undefined): boolean {
  return kind === "sandbox" || kind === "sandbox_template" || kind === "sandbox_app";
}

export function hybridWorkspaceSessionMetadata(
  metadata: Record<string, unknown> | null | undefined = {},
): Record<string, unknown> {
  return {
    ...metadata,
    workspaceTarget: "hybrid",
  };
}

export function isHybridWorkspaceSession(session: Session | null | undefined): boolean {
  return session?.metadata?.workspaceTarget === "hybrid";
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
