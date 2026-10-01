import { apiFetch, type ClientConnection } from "../../../api/api-client";
import { contentHash } from "@openpond/harness";
import type { OpenPondExperimentsClient } from "openpond-sdk/experiments";
import type { TasksetCatalogPage } from "openpond-sdk/taskset-catalog";
import type { TrainingProject } from "openpond-sdk/training-projects";
import type { DatasetWorkspaceListSchema } from "openpond-sdk/dataset-workspaces";
import type { z } from "zod";
export type ExperimentEvidence = Awaited<ReturnType<OpenPondExperimentsClient["result"]>>;
export type Inventory = {
  teamId: string;
  apiOrigin: string;
  projects: { projects: TrainingProject[]; nextCursor: string | null };
  datasets: z.infer<typeof DatasetWorkspaceListSchema>;
  releasedDatasets: TasksetCatalogPage;
  experiments: Awaited<ReturnType<OpenPondExperimentsClient["list"]>>;
};
export type WorkspaceApi = ReturnType<typeof createWorkspaceApi>;
export function createWorkspaceApi(
  connection: ClientConnection,
  scope: {
    teamId: string;
    projectId: string | null;
    accountKey: string;
    executionLocation?: "local" | "hosted";
  },
) {
  const key = JSON.stringify([
    scope.accountKey,
    scope.teamId,
    scope.projectId,
    scope.executionLocation ?? "hosted",
  ]);
  return {
    key,
    teamId: scope.teamId,
    projectId: scope.projectId,
    location: scope.executionLocation ?? "hosted",
    local<T>(action: string, payload: unknown = {}, signal?: AbortSignal) {
      return apiFetch<T>(connection, "/v1/local-experiments", {
        method: "POST",
        body: JSON.stringify({ teamId: scope.teamId, projectId: scope.projectId, action, payload }),
        signal,
      });
    },
    request<T>(operation: string, value?: unknown, signal?: AbortSignal) {
      return apiFetch<T>(connection, "/v1/training/evaluation-workspace", {
        method: "POST",
        body: JSON.stringify({
          teamId: scope.teamId,
          projectId: scope.projectId,
          operation,
          ...(value === undefined ? {} : { value }),
        }),
        signal,
      });
    },
    operation(action: string, value: unknown) {
      return prepareOperation(action, value);
    },
    localOperation(action: string, value: unknown) {
      return prepareOperation(`local:${action}`, value);
    },
  };
  async function prepareOperation(action: string, value: unknown) {
    const intentHash = contentHash(value),
      operationScope = { teamId: scope.teamId, projectId: scope.projectId };
    const prepared = await apiFetch<{ id: string; createdAt: string }>(
      connection,
      "/v1/training/evaluation-workspace",
      {
        method: "POST",
        body: JSON.stringify({
          ...operationScope,
          operation: "prepareOperation",
          value: { action, intentHash },
        }),
      },
    );
    return {
      ...prepared,
      async acknowledge() {
        await apiFetch(connection, "/v1/training/evaluation-workspace", {
          method: "POST",
          body: JSON.stringify({
            ...operationScope,
            operation: "acknowledgeOperation",
            value: { action, intentHash, id: prepared.id },
          }),
        });
      },
    };
  }
}
