import { z } from "zod";
import { OpenPondTrainingApiError } from "openpond-sdk/training";
import { OpenPondExperimentError } from "openpond-sdk/experiments";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleWeightSpaceReadRoutes({deps,request,requestUrl,response}:HttpRouteContext):Promise<boolean>{
  const match=/^\/v1\/training\/weight-space-sessions(?:\/([^/]+)(?:\/(commands|cancel))?)?$/.exec(requestUrl.pathname);
  const grading=/^\/v1\/training\/weight-space-sessions\/([^/]+)\/scoring-passes(?:\/([^/]+)(?:\/(result|cancel))?)?$/.exec(requestUrl.pathname);
  if(!match&&!grading)return false;
  const cancelling=grading?grading[3]==="cancel":match![2]==="cancel";
  response.setHeader("Cache-Control","no-store");
  if(request.method!==(cancelling?"POST":"GET")){
    sendJson(response,405,{code:"method_not_allowed",error:"Use the canonical editing operation."});return true;
  }
  try{
    if(grading){
      if(new Set(requestUrl.searchParams.keys()).size!==requestUrl.searchParams.size)
        throw new z.ZodError([{code:"custom",path:[],message:"Duplicate grading query fields are not permitted."}]);
      if(cancelling)z.object({}).strict().parse(await readJson(request,{maxBytes:65_536}));
      const {afterId,projectId,...account}=Object.fromEntries(requestUrl.searchParams);
      if(grading[2]&&afterId)throw new z.ZodError([{code:"custom",path:["afterId"],message:"Only a grading list accepts a cursor."}]);
      sendJson(response,200,await deps.trainingPayload("hosted_weight_space_read",{...account,projectId:projectId??null,
        id:decodeURIComponent(grading[1]!),action:!grading[2]?"passes":grading[3]==="result"?"passResult":cancelling?"cancelPass":"pass",
        ...(grading[2]?{passId:decodeURIComponent(grading[2])}:{query:{...(afterId?{afterId}:{})}})},requestUrl));
      return true;
    }
    const id=match![1]?decodeURIComponent(match![1]):undefined;
    if(cancelling){
      const body=z.record(z.string(),z.unknown()).parse(await readJson(request,{maxBytes:65_536}));
      sendJson(response,200,await deps.trainingPayload("hosted_weight_space_cancel",{...body,id},requestUrl));
    }else{
      if(new Set(requestUrl.searchParams.keys()).size!==requestUrl.searchParams.size)
        throw new z.ZodError([{code:"custom",path:[],message:"Duplicate editing query fields are not permitted."}]);
      const {afterRevision,limit,cursor,phase,method,projectId,id:filterId,...account}=Object.fromEntries(requestUrl.searchParams);
      sendJson(response,200,await deps.trainingPayload("hosted_weight_space_read",{...account,projectId:projectId??null,action:!id?"list":match![2]?"history":"get",...(id?{id}:{}),...(!id?{query:{...(filterId?{id:filterId}:{}),...(method?{method}:{}),...(phase?{phase}:{}),...(cursor?{cursor}:{}),...(limit?{limit:Number(limit)}:{})}}:match![2]?{query:{...(afterRevision?{afterRevision:Number(afterRevision)}:{}),...(limit?{limit:Number(limit)}:{})}}:{})},requestUrl));
    }
  }catch(error){
    if(error instanceof OpenPondTrainingApiError)sendJson(response,error.status,{code:error.code,error:error.message,retryable:error.retryable});
    else if(error instanceof OpenPondExperimentError)sendJson(response,error.status,{code:error.code,error:error.message});
    else if(error instanceof z.ZodError||error instanceof URIError)sendJson(response,400,{code:"weight_space_request_invalid",error:"The editing request does not match its bounded contract."});
    else throw error;
  }
  return true;
}
