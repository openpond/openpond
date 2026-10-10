import { useQuery } from "@tanstack/react-query";
import { PonderDesktopHandoffPresentationSchema } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import type { PonderLinkedLocalWork } from "./ponder-local-work";
import type { PonderLinkedWork } from "./PonderResultAttention";

/** The panel and sidebar share one scoped poll and never retain another connection's projection. */
export function usePonderWork(
  connection: ClientConnection | null,
  enabled: boolean,
  accountScopeKey: string,
  poll = true,
) {
  return useQuery({
    queryKey: ["ponder-work", connectionQueryScope(connection), accountScopeKey],
    enabled: Boolean(connection && enabled),
    staleTime: 2_000,
    refetchInterval: poll ? 3_000 : false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    queryFn: async () => {
      const [work, desktop] = await Promise.all([
        apiFetch<{
          items: PonderLinkedWork[];
          localItems: PonderLinkedLocalWork[];
          localHandoffs: unknown;
        }>(connection!, "/v1/ponder/work"),
        apiFetch<{
          ownerScope: {
            installationId: string;
            profileId: string;
            ownerUserId: string;
            teamId: string;
          } | null;
        }>(connection!, "/v1/ponder/desktop"),
      ]);
      return {
        ...work,
        localHandoffs: PonderDesktopHandoffPresentationSchema.array().parse(work.localHandoffs),
        ownerScope: desktop.ownerScope,
      };
    },
  });
}
