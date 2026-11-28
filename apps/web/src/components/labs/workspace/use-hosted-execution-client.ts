import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { connectionQueryScope } from "../../../lib/query-scope";
import { createWorkspaceApi, type WorkspaceApi } from "./workspace-api";

const WorkspaceIdentitySchema = z.object({ teamId: z.string(), apiOrigin: z.url() });
type WorkspaceIdentity = z.infer<typeof WorkspaceIdentitySchema>;

export function useHostedExecutionClient<T>(api: WorkspaceApi, enabled: boolean, create: (api: WorkspaceApi, origin: string) => T) {
  const select = useCallback((identity: WorkspaceIdentity) => create(api, identity.apiOrigin), [api, create]);
  return useQuery({
    queryKey: ["evaluation-workspace", "identity", connectionQueryScope(api.connection), api.accountKey, api.actorId, api.teamId],
    enabled: enabled && api.location === "hosted" && Boolean(api.actorId),
    retry: false,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const workspace = createWorkspaceApi(api.connection, { ...api, projectId: null });
      const identity = WorkspaceIdentitySchema.parse(await workspace.request("workspaceIdentity", undefined, signal));
      if (identity.teamId !== api.teamId) throw new Error("The workspace account changed.");
      return identity;
    },
    select,
  });
}
