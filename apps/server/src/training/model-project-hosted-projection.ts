import { ModelProjectSchema, type ModelProject } from "@openpond/contracts";
import {
  createModelProjectsClient,
  HostedModelProjectTrainingSetupSchema,
} from "openpond-sdk/model-projects";

import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";

type HostedSubmissionAccess = {
  apiBaseUrl: string;
  token: string;
  teamId: string;
};

export function hostedModelProjectTrainingSetup(
  trainingSetup: ModelProject["trainingSetup"],
) {
  const {
    managedGpuRequirement: _managedGpuRequirement,
    ...hostedTrainingSetup
  } = trainingSetup;
  return HostedModelProjectTrainingSetupSchema.parse(hostedTrainingSetup);
}

export async function syncHostedModelProjectForSubmission(input: {
  project: ModelProject;
  access: HostedSubmissionAccess;
  fetchImpl: typeof fetch;
  saveModelProject: (project: ModelProject) => Promise<ModelProject>;
}) {
  const headers = hostedApiAuthHeaders(input.access.token);
  headers.set("x-openpond-team-id", input.access.teamId);
  const client = createModelProjectsClient({
    baseUrl: input.access.apiBaseUrl,
    fetch: input.fetchImpl,
    headers,
  });
  const hosted = await client.upsert({
    schemaVersion: "openpond.hostedModelProjectSync.v2",
    portableProjectId: input.project.id,
    name: input.project.name,
    objective: input.project.objective,
    defaultBaseModel: input.project.defaultBaseModel,
    defaultDestinationId: input.project.defaultDestinationId,
    trainingSetup: hostedModelProjectTrainingSetup(input.project.trainingSetup),
    sourceRevision: input.project.revision,
    sourceUpdatedAt: input.project.updatedAt,
    expectedEtag:
      input.project.hosted?.teamId === input.access.teamId
        ? input.project.hosted.etag
        : null,
  });
  const saved = ModelProjectSchema.parse({
    ...input.project,
    hosted: {
      schemaVersion: "openpond.hostedModelProjectLink.v1",
      teamId: input.access.teamId,
      projectId: hosted.id,
      portableProjectId: hosted.portableProjectId,
      revision: hosted.revision,
      etag: hosted.etag,
      syncedSourceRevision: input.project.revision,
      syncedAt: new Date().toISOString(),
      tasksets:
        input.project.hosted?.teamId === input.access.teamId
          ? input.project.hosted.tasksets
          : [],
    },
  });
  return input.saveModelProject(saved);
}
