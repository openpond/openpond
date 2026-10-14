import { ChatTrainingReferenceSchema, type ChatTrainingReference } from "./chat-training-reference.js";
import { z } from "zod";
import { TrainingJobSchema as HostedTrainingJobSchema } from "openpond-sdk/training";
import { VersionedReleaseRefSchema } from "./release-core.js";

const Id = z.string().trim().min(1).max(240);
// Training is not a graded evaluation. Keep its canonical identities and input
// release separate from conversational dataset revisions and evaluation scores.
const LocalTrainingAttachmentSchema = z.object({
  location: z.literal("local").default("local"),
  jobId: Id,
  modelRunId: Id,
  modelId: Id,
  modelVersionId: Id.nullable(),
  adapterArtifactLineageId: Id.nullable(),
  owner: z.object({ teamId: Id, actorId: Id }).strict(),
  taskset: VersionedReleaseRefSchema,
  state: z.enum(["prepared", "running", "succeeded", "failed", "cancelled"]),
  executionState: z.enum(["queued", "starting", "running", "cancelling", "cancelled", "succeeded", "failed", "reconciling"]),
  updatedAt: z.iso.datetime(),
}).strict();
const HostedTrainingAttachmentSchema = z.object({
  location: z.literal("cloud"),
  jobId: Id,
  owner: z.object({ teamId: Id, actorId: Id }).strict(),
  apiOrigin: z.url(),
  job: HostedTrainingJobSchema,
  updatedAt: z.iso.datetime(),
}).strict().refine(value=>value.jobId===value.job.id && value.owner.teamId===value.job.teamId && value.updatedAt===value.job.updatedAt,
  "Hosted training attachment must match its canonical job.");
export const ChatTrainingAttachmentSchema = z.union([LocalTrainingAttachmentSchema,HostedTrainingAttachmentSchema]);
export type ChatTrainingAttachment = z.infer<typeof ChatTrainingAttachmentSchema>;

export function chatTrainingAttachmentKey(training: ChatTrainingAttachment): string {
  return JSON.stringify([training.location,training.location === "cloud" ? training.apiOrigin : null,
    training.owner.teamId,training.owner.actorId,training.jobId]);
}

export function chatTrainingReference(training: ChatTrainingAttachment): ChatTrainingReference {
  const common = {location:training.location,jobId:training.jobId,owner:training.owner};
  return ChatTrainingReferenceSchema.parse(training.location === "cloud"
    ? {...common,apiOrigin:training.apiOrigin,modelProjectId:training.job.modelProjectId,
      portableProjectId:training.job.portableProjectId,submissionHash:training.job.submissionHash}
    : {...common,modelRunId:training.modelRunId,modelId:training.modelId,
      modelVersionId:training.modelVersionId,adapterArtifactLineageId:training.adapterArtifactLineageId});
}
