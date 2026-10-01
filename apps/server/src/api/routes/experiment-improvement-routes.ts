import {ZodError} from "zod";
import {readJson,sendJson} from "../http.js";
import type {HttpRouteContext} from "../http-route-types.js";
/** The ordinary local bearer capability authenticates this route. Model/tool
 * authority is admitted separately by the private stored-turn callback. */
export async function handleExperimentImprovementRoutes({deps,request,requestUrl,response}:HttpRouteContext):Promise<boolean>{
  if(request.method!=="POST")return false;
  const handler=requestUrl.pathname==="/v1/experiment-improvements"?deps.experimentImprovementPayload
    :requestUrl.pathname==="/v1/experiment-evaluation-schedules"?deps.experimentEvaluationSchedulePayload
    :requestUrl.pathname==="/v1/advanced-refiner-evaluations"?deps.advancedRefinerEvaluationPayload:undefined;
  if(!["/v1/experiment-improvements","/v1/experiment-evaluation-schedules","/v1/advanced-refiner-evaluations"].includes(requestUrl.pathname))return false;
  response.setHeader("Cache-Control","no-store");if(!handler){sendJson(response,503,{code:"evaluation_owner_unavailable",error:"The current evaluation owner is unavailable."});return true;}
  try{sendJson(response,200,await handler(await readJson(request,{maxBytes:1_048_576})));}
  catch(error){if(error instanceof ZodError)sendJson(response,400,{code:"improve_request_invalid",error:"The Improve request does not match its immutable contract."});else if(error instanceof Error)sendJson(response,409,{code:"improve_owner_boundary",error:error.message});else throw error;}return true;
}
