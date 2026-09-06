import { ZodError } from "zod";
import { LearningConflictError, LearningDomainError } from "@openpond/evals/learning";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";
import { LearningCredentialAuthenticationError } from "../../training/learning-credentials.js";

export async function handleLearningRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  const actions: Record<string, string> = { "/v1/learning/commands": "learning_command", "/v1/learning/read": "learning_read", "/v1/learning/credentials": "learning_credentials", "/v1/learning/source-config": "learning_source_config" };
  const action = actions[requestUrl.pathname];
  if (request.method !== "POST" || !action) return false;
  try {
    const result = await deps.trainingPayload(action, await readJson(request, { maxBytes: 16_777_216 }), requestUrl);
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, 200, result);
  } catch (error) {
    sendLearningError(response, error);
  }
  return true;
}

/** An intake credential never enters the owner's general authenticated routes. */
export async function handleLearningProducerRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  const endpoint = requestUrl.pathname === "/v1/learning/commands" ? "commands" : requestUrl.pathname === "/v1/learning/source-config" ? "source-config" : null;
  if (request.method !== "POST" || !endpoint || !deps.learningProducerPayload) return false;
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  try {
    const result = await deps.learningProducerPayload(endpoint, header.slice(7), await readJson(request, { maxBytes: 16_777_216 }));
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, 200, result);
  } catch (error) { sendLearningError(response, error); }
  return true;
}

function sendLearningError(response: HttpRouteContext["response"], error: unknown) {
  if (error instanceof LearningConflictError) sendJson(response, 409, { code: error.code, error: error.message, expectedRevision: error.expectedRevision, currentRevision: error.currentRevision });
  else if (error instanceof LearningDomainError || error instanceof LearningCredentialAuthenticationError) sendJson(response, error.status, { code: error.code, error: error.message });
  else if (error instanceof ZodError) sendJson(response, 400, { code: "learning_validation_error", error: "Learning request does not match its contract.", issues: error.issues.map(({ path, message }) => ({ path, message })) });
  else throw error;
}
