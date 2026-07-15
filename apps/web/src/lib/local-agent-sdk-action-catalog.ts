import {
  CROSS_SYSTEM_TOOL_DEFINITIONS,
  type LocalProject,
  type OpenPondActionCatalogEntry,
} from "@openpond/contracts";

export function actionCatalogForLocalAgentSdkProject(
  project: LocalProject | null | undefined,
): OpenPondActionCatalogEntry[] {
  if (!project?.agentSdk?.detected || !isCrossSystemOperationsProject(project)) return [];
  return CROSS_SYSTEM_TOOL_DEFINITIONS.map((definition) => ({
    id: definition.name,
    sourcePath: project.path,
    sourceActionId: definition.name,
    name: definition.name,
    label: definition.name,
    description: definition.description,
    visibility: "end_user",
    inputSchema: structuredClone(definition.parameters) as Record<string, unknown>,
    implementation: { type: "tool", projectId: project.id },
    invokesModel: false,
  }));
}

function isCrossSystemOperationsProject(
  project: Pick<LocalProject, "name" | "workspacePath">,
): boolean {
  return [project.name, project.workspacePath.split(/[\\/]/).at(-1) ?? ""]
    .some((value) => value.toLowerCase().replace(/[^a-z0-9]/g, "") === "crosssystemoperations");
}
