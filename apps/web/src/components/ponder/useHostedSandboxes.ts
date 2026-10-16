import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PonderHostedSandboxState } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { useErrorToast } from "../../app/AppToastContext";

/** One account-scoped consent snapshot is shared by settings and execution controls. */
export function useHostedSandboxes(connection: ClientConnection, accountScopeKey: string, enabled = true) {
  const queries = useQueryClient();
  const queryKey = ["ponder-hosted-sandboxes", connectionQueryScope(connection), accountScopeKey] as const;
  const state = useQuery({ queryKey, enabled, staleTime: 5000, refetchInterval: enabled ? 30000 : false,
    queryFn: ({signal}) => apiFetch<PonderHostedSandboxState>(connection, "/v1/ponder/local/hosted-sandboxes", { signal }),
  });
  const update = useMutation({
    mutationFn: async (nextEnabled: boolean) => {
      if (!state.data) throw new Error("Wait for hosted sandbox availability to load.");
      return apiFetch<PonderHostedSandboxState>(connection, "/v1/ponder/local/hosted-sandboxes", {
        method: "POST", body: JSON.stringify({ enabled: nextEnabled, revision: state.data.revision, ...(nextEnabled ? { teamId: state.data.account?.teamId ?? null, accountId: state.data.account?.id, apiBaseUrl: state.data.account?.apiBaseUrl } : {}) }),
      });
    },
    onSuccess: value => queries.setQueryData(queryKey, value),
    onError: () => { void queries.invalidateQueries({ queryKey }); },
  });
  useErrorToast(state.error);
  useErrorToast(update.error);
  return { state: state.data, loading: state.isPending, saving: update.isPending,
    setEnabled: (value: boolean) => update.mutate(value), refetch: state.refetch };
}
