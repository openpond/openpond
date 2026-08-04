import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleWorkEvidenceRoutes({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  if (request.method === "POST" && requestUrl.pathname === "/v1/work/evidence/capture") {
    sendJson(response, 201, await deps.captureWorkEvidencePayload(await readJson(request)));
    return true;
  }

  const feedback = /^\/v1\/work\/evidence\/([^/]+)\/feedback$/.exec(requestUrl.pathname);
  if (feedback && request.method === "POST") {
    sendJson(response, 201, await deps.recordWorkEvidenceFeedbackPayload(
      decodeURIComponent(feedback[1]!),
      await readJson(request),
    ));
    return true;
  }
  if (feedback && request.method === "GET") {
    sendJson(response, 200, await deps.listWorkEvidenceFeedbackPayload(
      decodeURIComponent(feedback[1]!),
    ));
    return true;
  }

  const eligibility = /^\/v1\/work\/evidence\/([^/]+)\/eligibility$/.exec(requestUrl.pathname);
  if (eligibility && request.method === "POST") {
    sendJson(response, 200, await deps.classifyWorkEvidencePayload(
      decodeURIComponent(eligibility[1]!),
      await readJson(request),
    ));
    return true;
  }

  const evidence = /^\/v1\/work\/evidence\/([^/]+)$/.exec(requestUrl.pathname);
  if (evidence && request.method === "GET") {
    sendJson(response, 200, await deps.getWorkEvidencePayload(
      decodeURIComponent(evidence[1]!),
    ));
    return true;
  }
  return false;
}
