import { HumanReviewBridgeError } from "../../human-review/hosted-bridge.js";
import { ZodError } from "zod";
import { LearningDomainError } from "@openpond/evals/learning";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";
export async function handleHumanReviewRoutes({deps,request,requestUrl,response}:HttpRouteContext):Promise<boolean>{
  if(request.method!=="POST"||requestUrl.pathname!=="/v1/human-review")return false;
  try{const result=await deps.trainingPayload("human_review",await readJson(request,{maxBytes:1_048_576}),requestUrl);response.setHeader("Cache-Control","no-store");sendJson(response,200,result);}
  catch(error){if(error instanceof LearningDomainError || error instanceof HumanReviewBridgeError)sendJson(response,error.status,{code:error.code,error:error.message});else if(error instanceof ZodError)sendJson(response,400,{code:"human_request_invalid",error:"Invalid review request."});else throw error;}
  return true;
}
