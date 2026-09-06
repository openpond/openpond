import { ZodError } from "zod";
import { LearningConflictError, LearningDomainError } from "@openpond/evals/learning";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleLearningRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  if (request.method !== "POST" || !["/v1/learning/commands", "/v1/learning/read"].includes(requestUrl.pathname)) return false;
  try {
    const action = requestUrl.pathname === "/v1/learning/commands" ? "learning_command" : "learning_read";
    const result = await deps.trainingPayload(action, await readJson(request, { maxBytes: 16_777_216 }), requestUrl);
    sendJson(response, 200, result);
  } catch (error) {
    if (error instanceof LearningConflictError) sendJson(response, 409, { code: error.code, error: error.message, expectedRevision: error.expectedRevision, currentRevision: error.currentRevision });
    else if (error instanceof LearningDomainError) sendJson(response, error.status, { code: error.code, error: error.message });
    else if (error instanceof ZodError) sendJson(response, 400, { code: "learning_validation_error", error: "Learning request does not match its contract.", issues: error.issues.map(({ path, message }) => ({ path, message })) });
    else throw error;
  }
  return true;
}
