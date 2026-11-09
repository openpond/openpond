import { z } from "zod";
import { ActivationExperimentAccountSchema } from "@openpond/contracts";
import { createTrainingClient, WeightSpaceCommandListQuerySchema, WeightSpaceExecutionListQuerySchema } from "openpond-sdk/training";
import { OpenPondExperimentsClient } from "openpond-sdk/experiments";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";

const Envelope = ActivationExperimentAccountSchema.extend({id:z.string().min(1).max(240).optional(),projectId:z.string().min(1).max(240).nullable(),
  action:z.enum(["get","history","list","passes","pass","passResult","cancelPass"]),
  passId:z.string().min(1).max(200).optional(),query:z.unknown().optional()}).strict();
type Access = {apiBaseUrl:string;token:string;teamId:string;actorId:string};
/** Account-fenced observations only. Mutations keep their reviewed operation owners. */
export async function readHostedWeightSpace(raw:unknown, resolve:()=>Promise<Access>,requestFetch:typeof fetch=fetch){
  const input=Envelope.parse(raw),access=await resolve();
  const fence=async()=>{
    const active=await resolve();
    if(input.teamId!==active.teamId||input.actorId!==active.actorId||input.apiOrigin!==new URL(active.apiBaseUrl).origin
      ||access.teamId!==active.teamId||access.actorId!==active.actorId||access.apiBaseUrl!==active.apiBaseUrl)
      throw new Error("Open the editing session in its original account and workspace.");
  };
  await fence();
  const headers=hostedApiAuthHeaders(access.token);headers.set("x-openpond-team-id",input.teamId);
  const scopedFetch:typeof fetch=async(url,init)=>{
    await fence();const response=await requestFetch(url,{...init,redirect:"error",signal:AbortSignal.any([AbortSignal.timeout(15_000),...(init?.signal?[init.signal]:[])])});await fence();return response;
  };
  const client=createTrainingClient({baseUrl:access.apiBaseUrl,headers,fetch:scopedFetch});
  if(input.action==="list"){
    if(input.id)throw new Error("List editing sessions through bounded filters.");
    const query=WeightSpaceExecutionListQuerySchema.parse(input.query??{});
    if(input.projectId!==null)query.projectId=input.projectId;
    const page=await client.listWeightSpaceSessions(input.teamId,query);
    await fence();if(page.ownerUserId!==input.actorId)throw new Error("Editing history belongs to another creator.");return page;
  }
  const id=z.string().min(1).max(240).parse(input.id);
  const execution=await client.getWeightSpaceSession(input.teamId,id,{ownerUserId:input.actorId});
  if(input.projectId!==null&&execution.projectId!==input.projectId)throw new Error("This editing session belongs to another Project.");
  if(input.action==="get")return execution;
  if(["passes","pass","passResult","cancelPass"].includes(input.action)){
    const experiments=new OpenPondExperimentsClient({baseUrl:access.apiBaseUrl,apiKey:access.token,teamId:input.teamId,fetch:scopedFetch});
    if(input.action==="passes"){
      const query=z.object({afterId:z.string().min(1).max(200).optional()}).strict().parse(input.query??{});
      return experiments.scoringPasses(id,{executionKind:"weight_space",...query});
    }
    const passId=z.string().min(1).max(200).parse(input.passId),pass=await experiments.scoringPass(passId);
    if(pass.request.executionKind!=="weight_space"||pass.request.execution.id!==id)throw new Error("This grading pass belongs to another editing session.");
    if(input.action==="pass")return pass;
    if(input.action==="cancelPass")return experiments.cancelScoringPass(passId);
    const evidence=await experiments.scoringResult(passId);
    if(evidence.executionId!==id||evidence.manifest.lineage?.execution.contentHash!==pass.request.execution.contentHash)
      throw new Error("The grading result differs from its original candidate evaluation.");
    return evidence;
  }
  const page=await client.listWeightSpaceCommands(input.teamId,id,WeightSpaceCommandListQuerySchema.parse(input.query??{}));
  await fence();
  if(page.ownerUserId!==input.actorId)throw new Error("The editing history belongs to another creator.");
  return page;
}
