import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleConversationLearningRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  const match = /^\/v1\/conversation-learning\/(options|policies|definitions|serving-targets)$/.exec(requestUrl.pathname);
  if (!match || !deps.conversationLearningRequestPayload || !["GET", "POST"].includes(request.method ?? "")) return false;
  const teamId = requestUrl.searchParams.get("teamId");
  if (!teamId) { sendJson(response, 400, { error: "Select the hosted workspace before configuring continual learning." }); return true; }
  response.setHeader("Cache-Control", "no-store");
  sendJson(response, 200, await deps.conversationLearningRequestPayload({ teamId, resource: match[1], method: request.method,
    ...(request.method === "POST" ? { body: await readJson(request, { maxBytes: 256 * 1024 }) } : {}) }));
  return true;
}
