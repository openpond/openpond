import { useHostedExecutionClient } from "./use-hosted-execution-client";
import { ActivationExperimentAccountSchema } from "@openpond/contracts";
import {
  parseAndVerifyManagedModificationCompilation,
  parseAndVerifyManagedModificationExecution,
  parseAndVerifyManagedModificationExecutionPage,
  parseAndVerifyManagedModificationExecutionReceipt,
  type ManagedModificationCompile,
  type ManagedModificationPrepare,
  type ManagedModificationStart,
  type ManagedModificationCancel,
  type ManagedModificationExecutionListQuery,
} from "openpond-sdk/training";
import { apiFetch } from "../../../api/api-client";
import type { WorkspaceApi } from "./workspace-api";

export function managedModificationApi(api: WorkspaceApi, apiOrigin: string) {
  const account = ActivationExperimentAccountSchema.parse({
    teamId: api.teamId,
    actorId: api.actorId,
    apiOrigin,
  });
  const pins = { ...account, projectId: api.projectId };
  const root = "/v1/training/modification-executions";
  return {
    account,
    async compile(command: ManagedModificationCompile) {
      return parseAndVerifyManagedModificationCompilation(
        await apiFetch(api.connection, `${root}/compile`, {
          method: "POST",
          body: JSON.stringify({ ...pins, command }),
        }),
        command,
      );
    },
    async mutate(
      command: ManagedModificationPrepare | ManagedModificationStart | ManagedModificationCancel,
      intentHash: string,
    ) {
      const path =
        "action" in command
          ? `${root}/${encodeURIComponent(command.id)}/${command.action}`
          : `${root}/prepare`;
      const receipt = await parseAndVerifyManagedModificationExecutionReceipt(
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
      const value = await parseAndVerifyManagedModificationExecution(
        await apiFetch(api.connection, `${root}/${encodeURIComponent(id)}?${query}`, { signal }),
        { teamId: api.teamId, id, ownerUserId: account.actorId },
      );
      if (value.projectId !== api.projectId)
        throw new Error("The execution belongs to another Project.");
      return value;
    },
    async list(query: ManagedModificationExecutionListQuery = {}, signal?: AbortSignal) {
      const filters = { ...query, ...(api.projectId ? { projectId: api.projectId } : {}) };
      const params = new URLSearchParams({
        ...account,
        ...(api.projectId ? { projectId: api.projectId } : {}),
      });
      for (const [key, value] of Object.entries(filters))
        if (value !== undefined) params.set(key, String(value));
      return parseAndVerifyManagedModificationExecutionPage(
        await apiFetch(api.connection, `${root}?${params}`, { signal }),
        { teamId: api.teamId, ownerUserId: account.actorId, query: filters },
      );
    },
  };
}

export function useManagedModificationClient(api: WorkspaceApi, enabled = true) {
  return useHostedExecutionClient(api, enabled, managedModificationApi);
}
