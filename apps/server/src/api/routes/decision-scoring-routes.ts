import { z, ZodError } from "zod";
import { OpenPondTrainingApiError } from "openpond-sdk/training";
import { HostedDecisionExecutionError } from "../../training/hosted-decision-executions.js";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleDecisionScoringRoutes({deps, request, requestUrl, response}: HttpRouteContext): Promise<boolean> {
  const match = /^\/v1\/training\/saved-models\/([^/]+)\/decisions$/.exec(requestUrl.pathname);
  if (!match) return false;
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "POST") {
    sendJson(response, 405, {code: "method_not_allowed", error: "Use the exact reviewed scoring command."}); return true;
  }
  try {
    const payload = z.record(z.string(), z.unknown()).parse(await readJson(request, {maxBytes: 196_608}));
    sendJson(response, 200, await deps.trainingPayload("hosted_decision_score", {
      ...payload, modelProjectId: decodeURIComponent(match[1]!),
    }, requestUrl));
  } catch (error) {
    if (error instanceof OpenPondTrainingApiError) sendJson(response, error.status, {code: error.code, error: error.message, retryable: error.retryable});
    else if (error instanceof HostedDecisionExecutionError) sendJson(response, error.status, {code: error.code, error: error.message, retryable: false});
    else if (error instanceof ZodError || error instanceof URIError) sendJson(response, 400, {code: "decision_score_invalid", error: "The score does not match its bounded reviewed contract.", retryable: false});
    else throw error;
  }
  return true;
}
