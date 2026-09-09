import { ManagedTrainingRunEvidenceSchema, type TrainingJob } from "@openpond/contracts";
import { createTrainingClient } from "openpond-sdk/training";
import type { SqliteStore } from "../store/store.js";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import { managedTrainingEvidenceFromPublic } from "./openpond-managed-training-evidence.js";

export function createHostedModelRunEvidence(input: {
  store: SqliteStore;
  resolveAccess?: () => Promise<{ apiBaseUrl: string; token: string; teamId: string }>;
}) {
  async function clientFor(job: TrainingJob) {
    if (!input.resolveAccess) throw new Error("Hosted training access is unavailable.");
    const access = await input.resolveAccess();
    const modelId = job.metadata.modelProjectId;
    const project = typeof modelId === "string" ? await input.store.getModelProject(modelId) : null;
    if (!project?.hosted?.apiOrigin || project.hosted.teamId !== access.teamId ||
      job.metadata.hostedTeamId !== access.teamId ||
      job.metadata.hostedModelProjectId !== project.hosted.projectId ||
      new URL(project.hosted.apiOrigin).origin !== new URL(access.apiBaseUrl).origin) {
      throw new Error("Hosted run does not belong to the active workspace and API origin.");
    }
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("x-openpond-team-id", access.teamId);
    return createTrainingClient({ baseUrl: access.apiBaseUrl, headers });
  }

  async function refresh(job: TrainingJob) {
    const client = await clientFor(job);
    const [remoteJob, events, outputs] = await Promise.all([
      client.getJob(job.id), client.events(job.id), client.outputs(job.id),
    ]);
    if (remoteJob.id !== job.id || remoteJob.teamId !== job.metadata.hostedTeamId ||
      remoteJob.modelProjectId !== job.metadata.hostedModelProjectId || remoteJob.portableProjectId !== job.metadata.modelProjectId) {
      throw new Error("Hosted evidence belongs to a different run or workspace.");
    }
    const current = await input.store.getTrainingJob(job.id);
    if (!current) throw new Error("Hosted training job no longer exists locally.");
    await input.store.saveTrainingJob({ ...current, metadata: {
      ...current.metadata,
      managedTrainingEvidence: managedTrainingEvidenceFromPublic({ job: remoteJob, events, outputs }),
    } });
  }

  async function evaluationTasks(job: TrainingJob, evaluationId: string, options: { cursor?: string; limit?: number }) {
    const client = await clientFor(job);
    const evidence = ManagedTrainingRunEvidenceSchema.parse(job.metadata.managedTrainingEvidence);
    const evaluation = evidence.evaluations.find((item) => item.reference?.id === evaluationId);
    if (evidence.providerRunId !== job.id || !evaluation?.reference) {
      throw new Error("The hosted run has no retained reference for this evaluation.");
    }
    const page = await client.evaluationTasks(job.id, evaluation.reference, options);
    if (page.teamId !== job.metadata.hostedTeamId || page.kind !== evaluation.kind || page.policyVersion !== evaluation.policyVersion) {
      throw new Error("The retained evaluation differs from the recorded run policy.");
    }
    return page;
  }
  return { refresh, evaluationTasks };
}
