import type { ModelProject } from "@openpond/contracts";
import { createModelProjectSaveRequest, ModelProjectConfigurationCheckSchema } from "openpond-sdk/model-projects";
import { api, type ClientConnection } from "../api";

export function modelConfigurationRequest(project: ModelProject, expectedRevision: number) {
  return createModelProjectSaveRequest({
    id: project.id, profileId: project.profileId, name: project.name,
    objective: project.objective, defaultBaseModel: project.defaultBaseModel,
    defaultDestinationId: project.defaultDestinationId, trainingSetup: project.trainingSetup,
  }, expectedRevision);
}

export async function checkModelConfiguration(connection: ClientConnection | null, project: ModelProject, expectedRevision: number) {
  if (!connection) throw new Error("Connect to the execution owner to check this configuration.");
  const request = await modelConfigurationRequest(project, expectedRevision);
  return ModelProjectConfigurationCheckSchema.parse(await api.trainingRequest(connection, "/models/check", request, "POST"));
}
