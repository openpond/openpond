import { useQuery } from "@tanstack/react-query";
import { ActivationExperimentAccountSchema } from "@openpond/contracts";
import {
  parseAndVerifyNeuronTrainingExecutionCapability,
  type ModelModificationCapabilitiesQuery,
  parseAndVerifyManagedNeuronTrainingCompilation,
  parseAndVerifyManagedNeuronTrainingExecution,
  parseAndVerifyManagedNeuronTrainingExecutionPage,
  parseAndVerifyManagedNeuronTrainingExecutionReceipt,
  type ManagedNeuronTrainingCompile,
  type ManagedNeuronTrainingPrepare,
  type ManagedNeuronTrainingStart,
  type ManagedNeuronTrainingCancel,
  type ManagedNeuronTrainingExecutionListQuery,
} from "openpond-sdk/training";
import { apiFetch } from "../../../api/api-client";
import type { WorkspaceApi, Inventory } from "./workspace-api";

export function managedNeuronTrainingApi(api: WorkspaceApi, apiOrigin: string) {
  const account = ActivationExperimentAccountSchema.parse({
    teamId: api.teamId,
    actorId: api.actorId,
    apiOrigin,
  });
  const pins = { ...account, projectId: api.projectId };
  const root = "/v1/training/neuron-training-executions";
  return {
    account,
    async capability(query: ModelModificationCapabilitiesQuery, signal?: AbortSignal) {
      return parseAndVerifyNeuronTrainingExecutionCapability(
        await apiFetch(api.connection, `${root}/capability`, {
          method: "POST",
          signal,
          body: JSON.stringify({ ...pins, capabilityQuery: query }),
        }),
        query,
        account.actorId,
      );
    },
    async compile(command: ManagedNeuronTrainingCompile) {
      return parseAndVerifyManagedNeuronTrainingCompilation(
        await apiFetch(api.connection, `${root}/compile`, {
          method: "POST",
          body: JSON.stringify({ ...pins, command }),
        }),
        command,
      );
    },
    async mutate(
      command:
        | ManagedNeuronTrainingPrepare
        | ManagedNeuronTrainingStart
        | ManagedNeuronTrainingCancel,
      intentHash: string,
    ) {
      const path =
        "action" in command
          ? `${root}/${encodeURIComponent(command.id)}/${command.action}`
          : `${root}/prepare`;
      const receipt = await parseAndVerifyManagedNeuronTrainingExecutionReceipt(
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
      const value = await parseAndVerifyManagedNeuronTrainingExecution(
        await apiFetch(api.connection, `${root}/${encodeURIComponent(id)}?${query}`, { signal }),
        { teamId: api.teamId, id, ownerUserId: account.actorId },
      );
      if (api.projectId !== null && value.projectId !== api.projectId)
        throw new Error("The execution belongs to another Project.");
      return value;
    },
    async list(query: ManagedNeuronTrainingExecutionListQuery = {}, signal?: AbortSignal) {
      const filters = { ...query, ...(api.projectId ? { projectId: api.projectId } : {}) };
      const params = new URLSearchParams({
        ...account,
        ...(api.projectId ? { projectId: api.projectId } : {}),
      });
      for (const [key, value] of Object.entries(filters))
        if (value !== undefined) params.set(key, String(value));
      return parseAndVerifyManagedNeuronTrainingExecutionPage(
        await apiFetch(api.connection, `${root}?${params}`, { signal }),
        { teamId: api.teamId, ownerUserId: account.actorId, query: filters },
      );
    },
  };
}

export function useManagedNeuronTrainingClient(api: WorkspaceApi, enabled = true) {
  return useQuery({
    queryKey: ["neuron-training-experiment-account", api.key, api.actorId],
    enabled: enabled && api.location === "hosted" && Boolean(api.actorId),
    retry: false,
    queryFn: async ({ signal }) => {
      const value = await api.request<Inventory>("inventory", {}, signal);
      if (value.teamId !== api.teamId) throw new Error("The workspace account changed.");
      return managedNeuronTrainingApi(api, value.apiOrigin);
    },
  });
}
