import { ChatTrainingAttachmentSchema, type ChatTrainingAttachment } from "@openpond/contracts";
import { createTrainingClient } from "openpond-sdk/training";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";

type Access = {apiBaseUrl:string;token:string;teamId:string;actorId:string};
export async function readChatHostedTrainingAttachment(
  access: Access,
  reference: {jobId:string;apiOrigin:string;teamId:string;actorId?:string},
  request: typeof fetch = fetch,
): Promise<ChatTrainingAttachment> {
  const apiOrigin = new URL(access.apiBaseUrl).origin;
  if (apiOrigin !== new URL(reference.apiOrigin).origin || reference.teamId !== access.teamId
    || reference.actorId !== undefined && reference.actorId !== access.actorId) {
    throw new Error("Select the account, API origin and workspace that own this training job.");
  }
  const headers = hostedApiAuthHeaders(access.token);
  headers.set("x-openpond-team-id",access.teamId);
  const client = createTrainingClient({baseUrl:access.apiBaseUrl,headers,fetch:(url,init)=>request(url,{
    ...init,redirect:"error",signal:AbortSignal.any([AbortSignal.timeout(10_000),...init?.signal ? [init.signal] : []]),
  })});
  const job = await client.getJob(reference.jobId);
  if (job.id !== reference.jobId || job.teamId !== access.teamId) throw new Error("Hosted training returned another job or workspace.");
  return ChatTrainingAttachmentSchema.parse({location:"cloud",jobId:job.id,apiOrigin,
    owner:{teamId:access.teamId,actorId:access.actorId},job,updatedAt:job.updatedAt});
}
