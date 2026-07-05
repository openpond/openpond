import { PatchLocalAgentScheduleRequestSchema } from "@openpond/contracts";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleLocalAgentScheduleRoutes({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  if (request.method === "GET" && requestUrl.pathname === "/v1/local-agent-schedules") {
    sendJson(
      response,
      200,
      await deps.listLocalAgentSchedulesPayload({
        localProjectId: requestUrl.searchParams.get("localProjectId"),
      }),
    );
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/local-agent-schedules/sync") {
    sendJson(response, 202, await deps.syncLocalAgentSchedulesPayload());
    return true;
  }

  const runMatch = /^\/v1\/local-agent-schedules\/([^/]+)\/run$/.exec(requestUrl.pathname);
  if (request.method === "POST" && runMatch) {
    sendJson(
      response,
      202,
      await deps.runLocalAgentSchedulePayload(
        decodeURIComponent(runMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }

  const runsMatch = /^\/v1\/local-agent-schedules\/([^/]+)\/runs$/.exec(requestUrl.pathname);
  if (request.method === "GET" && runsMatch) {
    const rawLimit = Number.parseInt(requestUrl.searchParams.get("limit") ?? "", 10);
    sendJson(
      response,
      200,
      await deps.listLocalAgentScheduleRunsPayload(decodeURIComponent(runsMatch[1]!), {
        limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
      }),
    );
    return true;
  }

  const scheduleMatch = /^\/v1\/local-agent-schedules\/([^/]+)$/.exec(requestUrl.pathname);
  if (request.method === "PATCH" && scheduleMatch) {
    sendJson(
      response,
      200,
      await deps.patchLocalAgentSchedulePayload(
        decodeURIComponent(scheduleMatch[1]!),
        PatchLocalAgentScheduleRequestSchema.parse(await readJson(request)),
      ),
    );
    return true;
  }

  return false;
}
