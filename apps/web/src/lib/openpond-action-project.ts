import type { CloudProject, LocalProject } from "@openpond/contracts";
import { projectSelectionKey } from "./app-models";

export type OpenPondActionProjectTarget = {
  id: string;
  teamId: string;
  name: string;
  selectionKey: string;
  localProjectId: string | null;
};

export function openPondActionProjectTarget(input: {
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
  return {
    id: linked.projectId,
    teamId: linked.teamId,
    name: linked.projectName ?? input.selectedProject?.name ?? "Cloud Project",
    selectionKey: projectSelectionKey("cloud", linked.projectId),
    localProjectId: input.selectedProject?.id ?? null,
  };
}
