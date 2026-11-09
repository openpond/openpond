import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { ActivationExperimentAccountSchema } from "@openpond/contracts";
import { parseAndVerifyWeightSpaceExecution, parseAndVerifyWeightSpaceCommandPage, WeightSpaceCommandListQuerySchema, WeightSpaceExecutionListQuerySchema, parseAndVerifyWeightSpaceExecutionPage } from "openpond-sdk/training";
import { verifyExperimentScoringPass, type ExperimentScoringPass } from "openpond-sdk/experiments";
import { verifyExperimentEvidence } from "@openpond/evals/experiments";
import { apiFetch } from "../../../api/api-client";
import type { WorkspaceApi, Inventory } from "./workspace-api";
export function managedWeightSpaceApi(api:WorkspaceApi,apiOrigin:string){
  const account=ActivationExperimentAccountSchema.parse({teamId:api.teamId,actorId:api.actorId,apiOrigin});
  const params=new URLSearchParams({...account,...(api.projectId?{projectId:api.projectId}:{})});
  const root="/v1/training/weight-space-sessions";
  const gradingPath=(id:string,passId?:string,action?:"result"|"cancel")=>`${root}/${encodeURIComponent(id)}/scoring-passes${passId?`/${encodeURIComponent(passId)}`:""}${action?`/${action}`:""}?${params}`;
  function ownedPass(raw:unknown,id:string){
    const pass=verifyExperimentScoringPass(raw);
    if(pass.teamId!==api.teamId||pass.request.executionKind!=="weight_space"||pass.request.execution.id!==id)
      throw new Error("The grading pass belongs to another editing session.");return pass;
  }
  return {account,cacheKey:JSON.stringify([api.key,account.apiOrigin]),
    async scoringPasses(id:string,afterId?:string,signal?:AbortSignal){
      const path=gradingPath(id)+(afterId?`&${new URLSearchParams({afterId})}`:"");
      const page=z.object({items:z.array(z.unknown()).max(30),nextCursor:z.string().min(1).max(200).nullable()}).strict().parse(await apiFetch(api.connection,path,{signal}));
      const items=page.items.map(raw=>ownedPass(raw,id));
      if(new Set(items.map(pass=>pass.id)).size!==items.length)throw new Error("Grading history contains duplicate identities.");
      return {items,nextCursor:page.nextCursor};
    },
    async cancelScoringPass(id:string,passId:string){return ownedPass(await apiFetch(api.connection,gradingPath(id,passId,"cancel"),{method:"POST",body:"{}"}),id);},
    async scoringResult(id:string,pass:ExperimentScoringPass,signal?:AbortSignal){
      ownedPass(pass,id);
      const raw=z.object({executionId:z.string(),passId:z.string(),manifest:z.unknown(),result:z.unknown()}).strict().parse(
        await apiFetch(api.connection,gradingPath(id,pass.id,"result"),{signal}));
      const value=verifyExperimentEvidence(raw);
      if(raw.executionId!==id||raw.passId!==pass.id||value.manifest.id!==pass.id||value.manifest.teamId!==api.teamId
        ||value.manifest.lineage?.execution.id!==id||value.manifest.lineage.execution.contentHash!==pass.request.execution.contentHash)
        throw new Error("The grading result differs from its selected candidate receipt.");
      return value;
    },
    async get(id:string,signal?:AbortSignal){
      const value=await parseAndVerifyWeightSpaceExecution(await apiFetch(api.connection,`${root}/${encodeURIComponent(id)}?${params}`,{signal}),{teamId:api.teamId,id,ownerUserId:account.actorId});
      if(api.projectId!==null&&value.projectId!==api.projectId)throw new Error("This editing session belongs to another Project.");return value;
    },
    async list(raw:z.input<typeof WeightSpaceExecutionListQuerySchema>={},signal?:AbortSignal){
      const query=WeightSpaceExecutionListQuerySchema.parse({...raw,...(api.projectId?{projectId:api.projectId}:{})}),filters=new URLSearchParams(params);
      for(const [key,value] of Object.entries(query))filters.set(key,String(value));
      return parseAndVerifyWeightSpaceExecutionPage(await apiFetch(api.connection,`${root}?${filters}`,{signal}),{teamId:api.teamId,ownerUserId:account.actorId,query});
    },
    async history(id:string,afterRevision=0,signal?:AbortSignal){
      const query=WeightSpaceCommandListQuerySchema.parse({afterRevision}),filters=new URLSearchParams(params);
      filters.set("afterRevision",String(query.afterRevision));filters.set("limit",String(query.limit));
      const page=await parseAndVerifyWeightSpaceCommandPage(await apiFetch(api.connection,`${root}/${encodeURIComponent(id)}/commands?${filters}`,{signal}),{teamId:api.teamId,sessionId:id,query});
      if(page.ownerUserId!==account.actorId)throw new Error("The editing history belongs to another creator.");return page;
    },
  };
}
export function useManagedWeightSpaceClient(api:WorkspaceApi,enabled=true){
  return useQuery({queryKey:["weight-space-account",api.key,api.actorId],enabled:enabled&&api.location==="hosted"&&Boolean(api.actorId),retry:false,
    queryFn:async({signal})=>{const value=await api.request<Inventory>("inventory",{},signal);if(value.teamId!==api.teamId)throw new Error("The workspace account changed.");return managedWeightSpaceApi(api,value.apiOrigin);}});
}
