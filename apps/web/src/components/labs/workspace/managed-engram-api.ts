import { useHostedExecutionClient } from "./use-hosted-execution-client";
import { ActivationExperimentAccountSchema } from "@openpond/contracts";
import {
  parseAndVerifyEngramExecutionCapability,
  type ModelModificationCapabilitiesQuery,
  parseAndVerifyManagedEngramCompilation,
  parseAndVerifyManagedEngramExecution,
  parseAndVerifyManagedEngramExecutionPage,
  parseAndVerifyManagedEngramExecutionReceipt,
  type ManagedEngramCompile,
  type ManagedEngramPrepare,
  type ManagedEngramStart,
  type ManagedEngramCancel,
  type ManagedEngramExecutionListQuery,
} from "openpond-sdk/training";
import { apiFetch } from "../../../api/api-client";
import type { WorkspaceApi } from "./workspace-api";

export function managedEngramApi(api: WorkspaceApi, apiOrigin: string) {
  const account = ActivationExperimentAccountSchema.parse({
    teamId: api.teamId,
    actorId: api.actorId,
    apiOrigin,
  });
  const pins = { ...account, projectId: api.projectId };
  const root = "/v1/training/engram-executions";
  return {
    account,
    async capability(query: ModelModificationCapabilitiesQuery, signal?: AbortSignal) {
      return parseAndVerifyEngramExecutionCapability(
        await apiFetch(api.connection, `${root}/capability`, {
          method: "POST", signal,
          body: JSON.stringify({ ...pins, capabilityQuery: query }),
        }), query, account.actorId,
      );
    },
    async compile(command: ManagedEngramCompile) {
      return parseAndVerifyManagedEngramCompilation(
        await apiFetch(api.connection, `${root}/compile`, {
          method: "POST",
          body: JSON.stringify({ ...pins, command }),
        }),
        command,
      );
    },
    async mutate(
      command: ManagedEngramPrepare | ManagedEngramStart | ManagedEngramCancel,
      intentHash: string,
    ) {
      const path =
        "action" in command
          ? `${root}/${encodeURIComponent(command.id)}/${command.action}`
          : `${root}/prepare`;
      const receipt = await parseAndVerifyManagedEngramExecutionReceipt(
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
      const value = await parseAndVerifyManagedEngramExecution(
        await apiFetch(api.connection, `${root}/${encodeURIComponent(id)}?${query}`, { signal }),
        { teamId: api.teamId, id, ownerUserId: account.actorId },
      );
      if (value.projectId !== api.projectId)
        throw new Error("The execution belongs to another Project.");
      return value;
    },
    async list(query: ManagedEngramExecutionListQuery = {}, signal?: AbortSignal) {
      const filters = { ...query, ...(api.projectId ? { projectId: api.projectId } : {}) };
      const params = new URLSearchParams({
        ...account,
        ...(api.projectId ? { projectId: api.projectId } : {}),
      });
      for (const [key, value] of Object.entries(filters))
        if (value !== undefined) params.set(key, String(value));
      return parseAndVerifyManagedEngramExecutionPage(
        await apiFetch(api.connection, `${root}?${params}`, { signal }),
        { teamId: api.teamId, ownerUserId: account.actorId, query: filters },
      );
    },
  };
}

export function useManagedEngramClient(api: WorkspaceApi, enabled = true) {
  return useHostedExecutionClient(api, enabled, managedEngramApi);
}
