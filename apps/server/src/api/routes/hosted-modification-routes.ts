import { z, ZodError } from "zod";
import { OpenPondTrainingApiError } from "openpond-sdk/training";
import { HostedModificationExecutionError } from "../../training/hosted-modification-executions.js";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

/** Desktop relay only: the authenticated hosted owner compiles, admits and
 * executes the exact existing modification DTOs. GET retains the 10 MiB SDK
 * capture bound and never turns metadata into a local execution. */
export async function handleHostedModificationRoutes({deps, request, requestUrl, response}: HttpRouteContext): Promise<boolean> {
  const match = /^\/v1\/training\/modification-executions(?:\/(compile|prepare)|\/([^/]+)(?:\/(start|cancel))?)?$/.exec(requestUrl.pathname);
  if (!match) return false;
  const action = match[1] ?? match[3] ?? (match[2] ? "get" : "list");
  if (request.method !== (action === "get" || action === "list" ? "GET" : "POST")) {
    sendJson(response, 405, {code: "method_not_allowed", error: "This experiment operation requires its canonical HTTP method."}); return true;
  }
  response.setHeader("Cache-Control", "no-store");
  try {
    let payload: unknown;
    if (request.method === "POST") {
      const body = z.record(z.string(), z.unknown()).parse(await readJson(request, {maxBytes: 1_064_960}));
      payload = {...body, action, ...(match[2] ? {id: decodeURIComponent(match[2])} : {})};
    } else {
      if (new Set(requestUrl.searchParams.keys()).size !== requestUrl.searchParams.size)
        throw new ZodError([{code: "custom", path: [], message: "Duplicate experiment query fields are not permitted."}]);
      const {teamId, actorId, apiOrigin, projectId, limit, ...filters} = Object.fromEntries(requestUrl.searchParams);
      payload = {teamId, actorId, apiOrigin, projectId: projectId ?? null, action,
        ...(match[2] ? {id: decodeURIComponent(match[2])} : {query: {...filters,
          ...(projectId ? {projectId} : {}), ...(limit === undefined ? {} : {limit: Number(limit)})}})};
    }
    sendJson(response, 200, await deps.trainingPayload("hosted_modification_execution", payload, requestUrl));
  } catch (error) {
    if (error instanceof OpenPondTrainingApiError) sendJson(response, error.status, {code: error.code, error: error.message, retryable: error.retryable, details: error.details});
    else if (error instanceof HostedModificationExecutionError) sendJson(response, error.status, {code: error.code, error: error.message, retryable: false});
    else if (error instanceof ZodError || error instanceof URIError) sendJson(response, 400, {code: "modification_request_invalid", error: "The experiment request does not match its bounded contract.", retryable: false});
    else throw error;
  }
  return true;
}
