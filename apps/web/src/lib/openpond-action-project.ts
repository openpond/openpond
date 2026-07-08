import type { CloudProject, LocalProject } from "@openpond/contracts";
import { projectSelectionKey } from "./app-models";
import { confirmedLinkedCloudProject } from "./cloud-link-trust";

export type OpenPondActionProjectTarget = {
  id: string;
  teamId: string;
  name: string;
  selectionKey: string;
  localProjectId: string | null;
};

export function openPondActionProjectTarget(input: {
  cloudProjects?: CloudProject[] | null;
  selectedCloudProject: CloudProject | null | undefined;
  selectedProject: LocalProject | null | undefined;
}): OpenPondActionProjectTarget | null {
  if (input.selectedCloudProject) {
    return {
      id: input.selectedCloudProject.id,
      teamId: input.selectedCloudProject.teamId,
      name: input.selectedCloudProject.name,
      selectionKey: projectSelectionKey("cloud", input.selectedCloudProject.id),
      localProjectId: null,
    };
  }

  const linked = input.selectedProject?.linkedSandboxProject ?? null;
  if (!linked?.projectId || !linked.teamId) return null;
  const checkedCloudProject = input.cloudProjects
    ? confirmedLinkedCloudProject(input.selectedProject, input.cloudProjects)
    : null;
  if (input.cloudProjects && !checkedCloudProject) return null;
  return {
    id: checkedCloudProject?.id ?? linked.projectId,
    teamId: checkedCloudProject?.teamId ?? linked.teamId,
    name: checkedCloudProject?.name ?? linked.projectName ?? input.selectedProject?.name ?? "Cloud Project",
    selectionKey: projectSelectionKey("cloud", checkedCloudProject?.id ?? linked.projectId),
    localProjectId: input.selectedProject?.id ?? null,
  };
}
