import type { CloudProject, LocalProject, PatchSessionRequest, Session } from "@openpond/contracts";
import { confirmedLinkedCloudProject } from "./cloud-link-trust";
import { localWorkspaceSessionMetadata } from "./workspace-location";

export function sessionProjectAssignment(session: Session, project: LocalProject | CloudProject, kind: "local" | "cloud", cloudProjects: CloudProject[]): PatchSessionRequest {
  if (kind === "cloud") {
    const cloud = project as CloudProject;
    return { appId: null, appName: null, workspaceKind: "sandbox", workspaceId: cloud.id,
      workspaceName: cloud.name, localProjectId: null, cloudProjectId: cloud.id, cloudTeamId: cloud.teamId,
      cwd: null, metadata: { ...session.metadata, workspaceTarget: "cloud" } };
  }
  const local = project as LocalProject;
  const linkedCloud = confirmedLinkedCloudProject(local, cloudProjects);
  return { appId: local.linkedOpenPondApp?.appId ?? null, appName: local.linkedOpenPondApp?.appName ?? null,
    workspaceKind: "local_project", workspaceId: local.id, workspaceName: local.name, localProjectId: local.id,
    cloudProjectId: linkedCloud?.id ?? null, cloudTeamId: linkedCloud?.teamId ?? null,
    cwd: local.workspacePath, metadata: localWorkspaceSessionMetadata(session.metadata) };
}
