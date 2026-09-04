import {
  CreateChatWorkflowRequestSchema,
  UpdateChatWorkflowRequestSchema,
} from "@openpond/contracts";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleChatWorkflowRoutes({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  if (requestUrl.pathname === "/v1/chat-workflows") {
    if (request.method === "GET") {
      sendJson(
        response,
        200,
        await deps.listChatWorkflowsPayload(requestUrl.searchParams.get("sessionId")),
      );
      return true;
    }
    if (request.method === "POST") {
      sendJson(
        response,
        201,
        await deps.createChatWorkflowPayload(
          CreateChatWorkflowRequestSchema.parse(await readJson(request)),
        ),
      );
      return true;
    }
  }

  const runMatch = /^\/v1\/chat-workflows\/([^/]+)\/run$/.exec(requestUrl.pathname);
  if (request.method === "POST" && runMatch) {
    sendJson(
      response,
      202,
      await deps.runChatWorkflowPayload(decodeURIComponent(runMatch[1]!)),
    );
    return true;
  }

  const workflowMatch = /^\/v1\/chat-workflows\/([^/]+)$/.exec(requestUrl.pathname);
  if (request.method === "PATCH" && workflowMatch) {
    sendJson(
      response,
      200,
      await deps.patchChatWorkflowPayload(
        decodeURIComponent(workflowMatch[1]!),
        UpdateChatWorkflowRequestSchema.parse(await readJson(request)),
      ),
    );
    return true;
  }
  if (request.method === "DELETE" && workflowMatch) {
    sendJson(
      response,
      200,
      await deps.deleteChatWorkflowPayload(decodeURIComponent(workflowMatch[1]!)),
    );
    return true;
  }
  return false;
}
