import {EvaluationOperationRecoverySchema,EvaluationOperationRecoveryPageSchema,type EvaluationOperationRecovery} from "@openpond/contracts";
import type { HumanInboxContext } from "../../human-review/api";
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
    actorId?: string | null;
    executionLocation?: "local" | "hosted";
  },
) {
  const key = JSON.stringify([
    scope.accountKey,
    scope.actorId ?? null,
    scope.teamId,
    scope.projectId,
    scope.executionLocation ?? "hosted",
  ]);
  return {
    key,
    connection,
    actorId: scope.actorId ?? null,
    teamId: scope.teamId,
    projectId: scope.projectId,
    location: scope.executionLocation ?? "hosted",
    humanContext: scope.actorId ? { connection, scope: scope.teamId, actorId: scope.actorId, location: scope.executionLocation ?? "hosted" } satisfies HumanInboxContext : null,
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
    async pendingOperations(action:string,cursor?:string,signal?:AbortSignal){
      return EvaluationOperationRecoveryPageSchema.parse(await apiFetch(connection,"/v1/training/evaluation-workspace",{method:"POST",body:JSON.stringify({teamId:scope.teamId,projectId:scope.projectId,operation:"pendingOperations",value:{action,...(cursor?{cursor}:{})}}),signal}));
    },
    recoverOperation(raw:EvaluationOperationRecovery){
      const row=EvaluationOperationRecoverySchema.parse(raw);
      return retainedOperation(row.action,row.intentHash,{id:row.id,createdAt:row.createdAt});
    },
    operation(action: string, value: unknown) {
      return prepareOperation(action, value);
    },
    localOperation(action: string, value: unknown) {
      return prepareOperation(`local:${action}`, value);
    },
  };
  async function prepareOperation(action: string, value: unknown) {
    const retainsReview=action==="advanced-refiner-start"||action==="experiment-evaluation-schedule";
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
          value: { action, intentHash,...(retainsReview?{reviewedIntent:value}:{}) },
        }),
      },
    );
    return retainedOperation(action,intentHash,prepared);
  }
  function retainedOperation(action:string,intentHash:string,prepared:{id:string;createdAt:string}){
    const retainsReview=action==="advanced-refiner-start"||action==="experiment-evaluation-schedule",operationScope={teamId:scope.teamId,projectId:scope.projectId};
    return {
      ...prepared,
      async retainCommand(command:unknown,phase:"reviewed"|"dispatching"="reviewed"){
        if(!retainsReview)throw new Error("This evaluation operation has no reviewed command catalog.");
        return apiFetch(connection,"/v1/training/evaluation-workspace",{method:"POST",body:JSON.stringify({...operationScope,operation:"retainOperation",value:{action,intentHash,id:prepared.id,command,phase}})});
      },
      async acknowledge(expectedPhase?:"reviewed") {
        await apiFetch(connection, "/v1/training/evaluation-workspace", {
          method: "POST",
          body: JSON.stringify({
            ...operationScope,
            operation: "acknowledgeOperation",
            value: { action, intentHash, id: prepared.id,...(expectedPhase?{expectedPhase}:{}) },
          }),
        });
      },
    };
  }
}
