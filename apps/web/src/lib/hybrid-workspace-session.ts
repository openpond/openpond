import type {
  ChatModelRef,
  ChatProvider,
  CloudProject,
  CreateSessionRequest,
  LocalProject,
} from "@openpond/contracts";
import { confirmedLinkedCloudProject } from "./cloud-link-trust";
import { hybridWorkspaceSessionMetadata } from "./workspace-location";

export type HybridWorkspaceTarget =
  | {
      kind: "ready";
      cloudProjectId: string;
      cloudTeamId: string;
      cwd: string | null;
      localProjectId: string | null;
      workspaceName: string;
    }
  | {
      kind: "missing_cloud_project";
      message: string;
    };

export function resolveHybridWorkspaceTarget({
  cloudProjects,
  selectedCloudProject,
  selectedProject,
}: {
  cloudProjects?: CloudProject[] | null;
  selectedCloudProject: CloudProject | null;
  selectedProject: LocalProject | null;
}): HybridWorkspaceTarget {
  const linkedSandboxProject = selectedProject?.linkedSandboxProject ?? null;
  const confirmedCloudProject = cloudProjects
    ? confirmedLinkedCloudProject(selectedProject, cloudProjects)
    : null;
  const cloudProjectId =
    selectedCloudProject?.id ??
    confirmedCloudProject?.id ??
    (cloudProjects ? null : linkedSandboxProject?.projectId ?? null);
  const cloudTeamId =
    selectedCloudProject?.teamId ??
    confirmedCloudProject?.teamId ??
    (cloudProjects ? null : linkedSandboxProject?.teamId ?? null);
  if (!cloudProjectId || !cloudTeamId) {
    return {
      kind: "missing_cloud_project",
      message: "Upload/sync this Project to Cloud before using Hybrid.",
    };
  }
  return {
    kind: "ready",
    cloudProjectId,
    cloudTeamId,
    cwd: selectedProject?.workspacePath ?? null,
    localProjectId: selectedProject?.id ?? null,
    workspaceName:
      selectedCloudProject?.name ??
      confirmedCloudProject?.name ??
      linkedSandboxProject?.projectName ??
      selectedProject?.name ??
      "Hybrid workspace",
  };
}

export function buildHybridWorkspaceSessionRequest({
  modelRef,
  provider,
  target,
  title,
}: {
  modelRef: ChatModelRef | undefined;
  provider: ChatProvider;
  target: Extract<HybridWorkspaceTarget, { kind: "ready" }>;
  title: string;
}): CreateSessionRequest {
  return {
    provider,
    ...(modelRef ? { modelRef } : {}),
    appId: null,
    appName: null,
    workspaceKind: "sandbox",
    workspaceId: null,
    workspaceName: target.workspaceName,
    localProjectId: target.localProjectId,
    cloudProjectId: target.cloudProjectId,
    cloudTeamId: target.cloudTeamId,
    metadata: hybridWorkspaceSessionMetadata(),
    cwd: target.cwd,
    title,
  };
}
