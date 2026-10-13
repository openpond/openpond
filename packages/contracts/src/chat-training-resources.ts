import { z } from "zod";
import { VersionedReleaseRefSchema } from "./release-core.js";

const Id = z.string().trim().min(1).max(240);
// Training is not a graded evaluation. Keep its canonical identities and input
// release separate from conversational dataset revisions and evaluation scores.
export const ChatTrainingAttachmentSchema = z.object({
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
export type ChatTrainingAttachment = z.infer<typeof ChatTrainingAttachmentSchema>;
