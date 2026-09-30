import { apiFetch, type ClientConnection } from "../../../api/api-client";
import { contentHash } from "@openpond/harness";
import type { OpenPondExperimentsClient } from "openpond-sdk/experiments";
import type { TrainingProject } from "openpond-sdk/training-projects";
import type { DatasetWorkspaceListSchema } from "openpond-sdk/dataset-workspaces";
import type { z } from "zod";
export type ExperimentEvidence = Awaited<ReturnType<OpenPondExperimentsClient["result"]>>;
export type Inventory = { teamId: string; apiOrigin: string; projects: { projects: TrainingProject[]; nextCursor: string | null }; datasets: z.infer<typeof DatasetWorkspaceListSchema>; experiments: Awaited<ReturnType<OpenPondExperimentsClient["list"]>> };
export type WorkspaceApi = ReturnType<typeof createWorkspaceApi>;
export function createWorkspaceApi(connection: ClientConnection, scope: { teamId: string; projectId: string | null; accountKey: string }) {
  const key = JSON.stringify([scope.accountKey, scope.teamId, scope.projectId]);
  return { key, teamId: scope.teamId, projectId: scope.projectId,
    request<T>(operation: string, value?: unknown, signal?: AbortSignal) { return apiFetch<T>(connection, "/v1/training/evaluation-workspace", { method: "POST", body: JSON.stringify({ teamId: scope.teamId, projectId: scope.projectId, operation, ...(value === undefined ? {} : { value }) }), signal }); },
    operation(action: string, value: unknown) {
      const storageKey = `openpond:evaluation-operation:${key}:${action}:${contentHash(value)}`;
      let id = localStorage.getItem(storageKey);
      if (!id) { id = crypto.randomUUID(); localStorage.setItem(storageKey, id); }
      return { id, acknowledge() { localStorage.removeItem(storageKey); } };
    },
  };
}
