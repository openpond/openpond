import { z } from "zod";

const Id = z.string().trim().min(1).max(240);
const owner = z.object({teamId:Id,actorId:Id}).strict();
// Transport identities only; a queued training action must not depend on the
// selected dropdown, mutable progress, or model-generated display text.
export const ChatTrainingReferenceSchema = z.discriminatedUnion("location",[
  z.object({location:z.literal("local"),jobId:Id,owner,modelRunId:Id,modelId:Id,
    modelVersionId:Id.nullable(),adapterArtifactLineageId:Id.nullable()}).strict(),
  z.object({location:z.literal("cloud"),jobId:Id,owner,apiOrigin:z.url().max(2000),
    modelProjectId:Id,portableProjectId:Id,submissionHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
export type ChatTrainingReference = z.infer<typeof ChatTrainingReferenceSchema>;
