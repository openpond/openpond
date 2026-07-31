import {
  HostedWorkScheduleMutationRequestSchema,
  HostedWorkScheduleRunRequestSchema,
  HostedWorkScheduleToggleRequestSchema,
} from "@openpond/contracts";
import { listHostedWorkSchedules, mutateHostedWorkSchedule } from "../../openpond/hosted-work-schedules.js";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleHostedWorkScheduleRoutes({
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  if (request.method === "GET" && requestUrl.pathname === "/v1/hosted-work-schedules") {
    sendJson(response, 200, await listHostedWorkSchedules(requestUrl.searchParams.get("teamId") ?? ""));
    return true;
  }
  const runMatch = /^\/v1\/hosted-work-schedules\/([^/]+)\/run$/.exec(requestUrl.pathname);
  if (request.method === "POST" && runMatch) {
    const body = HostedWorkScheduleRunRequestSchema.parse({
      ...recordPayload(await readJson(request)),
      scheduleId: decodeURIComponent(runMatch[1]!),
    });
    sendJson(response, 201, await mutateHostedWorkSchedule({ type: "run", input: body }));
    return true;
  }
  const scheduleMatch = /^\/v1\/hosted-work-schedules\/([^/]+)$/.exec(requestUrl.pathname);
  if (request.method === "PATCH" && scheduleMatch) {
    const body = HostedWorkScheduleToggleRequestSchema.parse({
      ...recordPayload(await readJson(request)),
      scheduleId: decodeURIComponent(scheduleMatch[1]!),
    });
    sendJson(response, 200, await mutateHostedWorkSchedule({ type: "toggle", input: body }));
    return true;
  }
  if (request.method === "DELETE" && scheduleMatch) {
    const body = HostedWorkScheduleMutationRequestSchema.parse({
      ...recordPayload(await readJson(request)),
      scheduleId: decodeURIComponent(scheduleMatch[1]!),
    });
    sendJson(response, 200, await mutateHostedWorkSchedule({ type: "delete", input: body }));
    return true;
  }
  return false;
}

function recordPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
