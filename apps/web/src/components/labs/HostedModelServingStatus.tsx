import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { HostedModelServingStatusSchema } from "openpond-sdk/model-projects";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import type { WorkspaceApi } from "./workspace/workspace-api";

type Scope = { teamId: string; apiOrigin: string };
type Status = { connection: ClientConnection; teamId: string; actorId: string; managingIds: ReadonlySet<string> };
const HostedModelServingStatusContext = createContext<Status | null>(null);

export function HostedModelServingStatusProvider({ connection, scope, actorId, accountHandle, visible, children }: {
  connection: ClientConnection | null;
  scope: Scope | null;
  actorId: string | null;
  accountHandle: string | null;
  visible: boolean;
  children: ReactNode;
}) {
  const teamId = scope?.teamId;
  const apiOrigin = scope?.apiOrigin;
  const status = useQuery({
    queryKey: ["saved-model-serving", "status", connectionQueryScope(connection), apiOrigin, teamId, actorId, accountHandle],
    enabled: Boolean(connection && teamId && apiOrigin && actorId && visible),
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ teamId: teamId!, actorId: actorId!, apiOrigin: apiOrigin! });
      const value = HostedModelServingStatusSchema.parse(await apiFetch(connection!, `/v1/training/model-serving-status?${query}`, { signal }));
      if (value.teamId !== teamId) throw new Error("Serving status belongs to a different workspace.");
      return new Set(value.managingModelProjectIds);
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });
  const value = useMemo(() => connection && teamId && actorId && status.data
    ? { connection, teamId, actorId, managingIds: status.data } : null, [connection, teamId, actorId, status.data]);
  return <HostedModelServingStatusContext.Provider value={value}>{children}</HostedModelServingStatusContext.Provider>;
}

export function useHostedModelManaging(api: WorkspaceApi, modelId: string) {
  const status = useContext(HostedModelServingStatusContext);
  return status?.connection === api.connection && status.teamId === api.teamId && status.actorId === api.actorId
    && status.managingIds.has(modelId);
}
