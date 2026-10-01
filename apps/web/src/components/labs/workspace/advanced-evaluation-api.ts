import { apiFetch } from "../../../api/api-client";
import type { WorkspaceApi } from "./workspace-api";
export function evaluationOwnerKey(api: WorkspaceApi) {
  return JSON.stringify([
    api.key,
    api.actorId,
    api.connection.serverUrl,
    api.connection.token,
  ]);
}
export function advancedEvaluationRequest<T>(
  api: WorkspaceApi,
  path: "advanced-refiner-evaluations" | "experiment-evaluation-schedules",
  request: unknown,
  signal?: AbortSignal,
) {
  if (!api.actorId)
    throw new Error("Sign in to use the evaluation owner controls.");
  return apiFetch<T>(api.connection, `/v1/${path}`, {
    method: "POST",
    body: JSON.stringify({
      teamId: api.teamId,
      projectId: api.projectId,
      request,
    }),
    signal,
  });
}
