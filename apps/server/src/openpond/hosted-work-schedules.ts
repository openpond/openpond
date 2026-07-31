import {
  HostedWorkSchedulesResponseSchema,
  type HostedWorkScheduleMutationRequest,
  type HostedWorkScheduleRunRequest,
  type HostedWorkScheduleToggleRequest,
} from "@openpond/contracts";
import {
  hostedApiAuthHeaders,
  resolveHostedApiAccess,
  type HostedApiAccessDependencies,
} from "./hosted-api-access.js";

type Dependencies = HostedApiAccessDependencies & { fetchImpl?: typeof fetch };

export async function listHostedWorkSchedules(
  teamId: string,
  dependencies: Dependencies = {},
) {
  return HostedWorkSchedulesResponseSchema.parse(
    await request("/v1/saved-work", { method: "GET" }, teamId, dependencies),
  );
}

export async function mutateHostedWorkSchedule(
  action:
    | { type: "toggle"; input: HostedWorkScheduleToggleRequest }
    | { type: "run"; input: HostedWorkScheduleRunRequest }
    | { type: "delete"; input: HostedWorkScheduleMutationRequest },
  dependencies: Dependencies = {},
) {
  const path = `/v1/saved-work/schedules/${encodeURIComponent(action.input.scheduleId)}`;
  if (action.type === "toggle") {
    return request(
      path,
      { method: "PATCH", body: JSON.stringify({ enabled: action.input.enabled }) },
      action.input.teamId,
      dependencies,
    );
  }
  if (action.type === "run") {
    return request(
      `${path}/run`,
      { method: "POST", body: JSON.stringify({ clientRequestId: action.input.clientRequestId }) },
      action.input.teamId,
      dependencies,
    );
  }
  return request(path, { method: "DELETE" }, action.input.teamId, dependencies);
}

async function request(
  path: string,
  init: RequestInit,
  teamId: string,
  dependencies: Dependencies,
): Promise<unknown> {
  const normalizedTeamId = teamId.trim();
  if (!normalizedTeamId) throw new Error("Select a Team to manage Scheduled Work.");
  const access = await resolveHostedApiAccess(dependencies);
  const headers = hostedApiAuthHeaders(access.token);
  headers.set("Content-Type", "application/json");
  headers.set("x-openpond-team-id", normalizedTeamId);
  const response = await (dependencies.fetchImpl ?? fetch)(`${access.apiBaseUrl}${path}`, {
    ...init,
    headers,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.error === "string"
          ? payload.error
          : response.statusText,
    );
  }
  return payload;
}
