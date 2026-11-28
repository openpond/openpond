import { useHostedExecutionClient } from "./use-hosted-execution-client";
import { ActivationExperimentAccountSchema } from "@openpond/contracts";
import {
  parseAndVerifyDecisionExecutionCapability,
  type ModelModificationCapabilitiesQuery,
  parseAndVerifyManagedDecisionCompilation,
  parseAndVerifyManagedDecisionExecution,
  parseAndVerifyManagedDecisionExecutionPage,
  parseAndVerifyManagedDecisionExecutionReceipt,
  type ManagedDecisionCompile,
  type ManagedDecisionPrepare,
  type ManagedDecisionStart,
  type ManagedDecisionCancel,
  type ManagedDecisionExecutionListQuery,
} from "openpond-sdk/training";
import { apiFetch } from "../../../api/api-client";
import type { WorkspaceApi } from "./workspace-api";

export function managedDecisionApi(api: WorkspaceApi, apiOrigin: string) {
  const account = ActivationExperimentAccountSchema.parse({
    teamId: api.teamId,
    actorId: api.actorId,
    apiOrigin,
  });
  const pins = { ...account, projectId: api.projectId };
  const root = "/v1/training/decision-executions";
  return {
    account,
    async capability(query: ModelModificationCapabilitiesQuery, signal?: AbortSignal) {
      return parseAndVerifyDecisionExecutionCapability(
        await apiFetch(api.connection, `${root}/capability`, {
          method: "POST", signal,
          body: JSON.stringify({ ...pins, capabilityQuery: query }),
        }), query, account.actorId,
      );
    },
    async compile(command: ManagedDecisionCompile) {
      return parseAndVerifyManagedDecisionCompilation(
        await apiFetch(api.connection, `${root}/compile`, {
          method: "POST",
          body: JSON.stringify({ ...pins, command }),
        }),
        command, account.actorId,
      );
    },
    async mutate(
      command: ManagedDecisionPrepare | ManagedDecisionStart | ManagedDecisionCancel,
      intentHash: string,
    ) {
      const path =
        "action" in command
          ? `${root}/${encodeURIComponent(command.id)}/${command.action}`
          : `${root}/prepare`;
      const receipt = await parseAndVerifyManagedDecisionExecutionReceipt(
        await apiFetch(api.connection, path, {
          method: "POST",
          body: JSON.stringify({ ...pins, intentHash, command }),
        }),
        command,
      );
      if (
        receipt.execution.ownerUserId !== account.actorId ||
        receipt.execution.projectId !== api.projectId
      )
        throw new Error("The execution receipt belongs to another account or Project.");
      return receipt;
    },
    async get(id: string, signal?: AbortSignal) {
      const query = new URLSearchParams({
        ...account,
        ...(api.projectId ? { projectId: api.projectId } : {}),
      });
      const value = await parseAndVerifyManagedDecisionExecution(
        await apiFetch(api.connection, `${root}/${encodeURIComponent(id)}?${query}`, { signal }),
        { teamId: api.teamId, id, ownerUserId: account.actorId },
      );
      if (api.projectId !== null && value.projectId !== api.projectId)
        throw new Error("The execution belongs to another Project.");
      return value;
    },
    async list(query: ManagedDecisionExecutionListQuery = {}, signal?: AbortSignal) {
      const filters = { ...query, ...(api.projectId ? { projectId: api.projectId } : {}) };
      const params = new URLSearchParams({
        ...account,
        ...(api.projectId ? { projectId: api.projectId } : {}),
      });
      for (const [key, value] of Object.entries(filters))
        if (value !== undefined) params.set(key, String(value));
      return parseAndVerifyManagedDecisionExecutionPage(
        await apiFetch(api.connection, `${root}?${params}`, { signal }),
        { teamId: api.teamId, ownerUserId: account.actorId, query: filters },
      );
    },
  };
}

export function useManagedDecisionClient(api: WorkspaceApi, enabled = true) {
  return useHostedExecutionClient(api, enabled, managedDecisionApi);
}
