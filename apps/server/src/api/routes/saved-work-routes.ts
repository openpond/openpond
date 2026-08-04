import {
  CreateHostedSavedWorkRequestSchema,
  UpdateHostedSavedWorkRequestSchema,
} from "@openpond/contracts";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleSavedWorkRoutes({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  if (requestUrl.pathname === "/v1/saved-work") {
    if (request.method === "GET") {
      sendJson(response, 200, await deps.listHostedSavedWorkPayload());
      return true;
    }
    if (request.method === "POST") {
      sendJson(
        response,
        201,
        await deps.createHostedSavedWorkPayload(
          CreateHostedSavedWorkRequestSchema.parse(await readJson(request))
        )
      );
      return true;
    }
  }

  const runMatch = /^\/v1\/saved-work\/schedules\/([^/]+)\/run$/.exec(
    requestUrl.pathname
  );
  if (request.method === "POST" && runMatch) {
    const input = (await readJson(request)) as { clientRequestId?: unknown };
    sendJson(
      response,
      201,
      await deps.runHostedSavedWorkPayload(
        decodeURIComponent(runMatch[1]!),
        typeof input.clientRequestId === "string" ? input.clientRequestId : ""
      )
    );
    return true;
  }

  const scheduleMatch = /^\/v1\/saved-work\/schedules\/([^/]+)$/.exec(
    requestUrl.pathname
  );
  if (scheduleMatch && request.method === "PATCH") {
    sendJson(
      response,
      200,
      await deps.updateHostedSavedWorkPayload(
        decodeURIComponent(scheduleMatch[1]!),
        UpdateHostedSavedWorkRequestSchema.parse(await readJson(request))
      )
    );
    return true;
  }
  if (scheduleMatch && request.method === "DELETE") {
    sendJson(
      response,
      200,
      await deps.deleteHostedSavedWorkPayload(
        decodeURIComponent(scheduleMatch[1]!)
      )
    );
    return true;
  }

  return false;
}
