import { ChatTrainingAttachmentSchema, type ChatTrainingAttachment } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { TrainingActivityAuthoritySchema } from "./training-activity-authority.js";

type Store = Pick<SqliteStore, "getTrainingJob" | "listTrainingJobs" | "getModelRun">;

// Never accept a model-written job summary as authority. Resolve both canonical
// records and the account that admitted the execution before returning any data.
export async function readChatTrainingAttachment(
  store: Store,
  input: { jobId?: string; modelRunId?: string },
  owner: { teamId: string; actorId: string },
): Promise<ChatTrainingAttachment> {
  if (!input.jobId && !input.modelRunId) throw new Error("Provide a training job or Model Run ID.");
  const job = input.jobId ? await store.getTrainingJob(input.jobId)
    : (await store.listTrainingJobs()).find(candidate => candidate.metadata.modelRunId === input.modelRunId);
  const authority = TrainingActivityAuthoritySchema.safeParse(job?.metadata.activityAuthority);
  if (!job || !authority.success || authority.data.teamId !== owner.teamId || authority.data.actorId !== owner.actorId) {
    throw new Error("Training job is unavailable in the selected account and workspace.");
  }
  const modelRunId = job.metadata.modelRunId;
  if (typeof modelRunId !== "string" || input.modelRunId && input.modelRunId !== modelRunId) {
    throw new Error("Training job has no matching canonical Model Run.");
  }
  const run = await store.getModelRun(modelRunId);
  if (!run || run.kind !== "training") throw new Error("Training job has no matching canonical Model Run.");
  return ChatTrainingAttachmentSchema.parse({
    jobId: job.id, modelRunId: run.id, modelId: run.modelId, modelVersionId: run.modelVersionId,
    adapterArtifactLineageId: run.adapterArtifactLineageId,
    owner, taskset: run.taskset, state: run.status, executionState: job.status,
    updatedAt: run.updatedAt > job.updatedAt ? run.updatedAt : job.updatedAt,
  });
}
