import { z } from "zod";
import { ActivationExperimentAccountSchema, WeightSpaceCancelIntentSchema } from "@openpond/contracts";
import { ManagedModificationCancelSchema, createTrainingClient, canonicalJson } from "openpond-sdk/training";
import { contentHash } from "@openpond/harness";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import { validateReviewedEvaluationCommand } from "./reviewed-evaluation-operation.js";
import type { SqliteStore } from "../store/store.js";
const Envelope=ActivationExperimentAccountSchema.extend({id:z.string().min(1),projectId:z.string().min(1).nullable(),
  intentHash:z.string().regex(/^[a-f0-9]{64}$/),command:ManagedModificationCancelSchema}).strict();
type Access={apiBaseUrl:string;token:string;teamId:string;actorId:string};
export async function cancelHostedWeightSpace(raw:unknown,store:SqliteStore,resolve:()=>Promise<Access>){
  const body=Envelope.parse(raw),access=await resolve(),apiOrigin=new URL(access.apiBaseUrl).origin;
  const fence=async()=>{const current=await resolve();if(current.teamId!==body.teamId||current.actorId!==body.actorId
    ||new URL(current.apiBaseUrl).origin!==body.apiOrigin||current.teamId!==access.teamId||current.actorId!==access.actorId||current.apiBaseUrl!==access.apiBaseUrl)
    throw new Error("Recover cancellation in this editing session's original account.");};
  await fence();
  const retained=await store.readPendingEvaluationOperation({scopeHash:contentHash({actorId:access.actorId,apiOrigin,teamId:access.teamId,projectId:body.projectId}),
    action:"training-weight-space-cancel",intentHash:body.intentHash,id:body.command.operationId});
  const intent=WeightSpaceCancelIntentSchema.parse(retained.reviewedIntent);
  if(retained.phase!=="dispatching"||body.id!==body.command.id||canonicalJson(intent.account)!==canonicalJson({teamId:body.teamId,actorId:body.actorId,apiOrigin:body.apiOrigin}))
    throw new Error("Recover the original retained editing-session cancellation.");
  validateReviewedEvaluationCommand({action:"training-weight-space-cancel",id:body.command.operationId,actorId:body.actorId,teamId:body.teamId,projectId:body.projectId,intent:retained.reviewedIntent,command:body.command});
  const headers=hostedApiAuthHeaders(access.token);headers.set("x-openpond-team-id",access.teamId);
  const client=createTrainingClient({baseUrl:access.apiBaseUrl,headers,fetch:async(url,init)=>{await fence();const response=await fetch(url,{...init,redirect:"error"});await fence();return response;}});
  const result=await client.cancelWeightSpaceSession(body.command);
  await fence();
  if(result.execution.ownerUserId!==body.actorId||result.execution.projectId!==body.projectId)throw new Error("Cancellation returned another editing session owner.");
  return result;
}
