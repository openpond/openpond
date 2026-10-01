import { ZodError } from "zod";
import { LocalExperimentError } from "../../evaluations/local-experiment-contract.js";
import { readJson,sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

/** The existing bearer capability boundary authenticates this route. Provider
 * keys and private package assets remain inside the local server. */
export async function handleLocalExperimentRoutes({deps,request,requestUrl,response}:HttpRouteContext):Promise<boolean> {
  if(request.method!=="POST"||requestUrl.pathname!=="/v1/local-experiments")return false;
  response.setHeader("Cache-Control","no-store");
  if(!deps.localExperimentPayload) {sendJson(response,503,{code:"local_experiments_unavailable",error:"Local Experiment execution is unavailable in this server."});return true;}
  try {sendJson(response,200,await deps.localExperimentPayload(await readJson(request,{maxBytes:67_108_864})));}
  catch(error) {
    if(error instanceof ZodError)sendJson(response,400,{code:"local_experiment_request_invalid",error:"The local Experiment request does not match its contract."});
    else if(error instanceof LocalExperimentError)sendJson(response,error.status,{code:error.code,error:error.message});
    else throw error;
  }
  return true;
}
