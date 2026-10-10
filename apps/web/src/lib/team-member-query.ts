import { queryOptions } from "@tanstack/react-query";
import { api, type ClientConnection } from "../api";
import { connectionQueryScope } from "./query-scope";

export function teamMemberQueryOptions(input: {
  connection: ClientConnection | null;
  accountScopeKey: string | null;
  currentUserId: string | null;
  teamId: string | null;
}) {
  const { connection, accountScopeKey, currentUserId, teamId } = input;
  return queryOptions({
    queryKey: ["team-members", connectionQueryScope(connection), accountScopeKey, currentUserId, teamId],
    enabled: Boolean(connection && accountScopeKey && currentUserId && teamId),
    queryFn: async ({ signal }) => {
      if (!connection || !accountScopeKey || !currentUserId || !teamId) return [];
      return (await api.teamChatMembers(connection, teamId, signal)).members;
    },
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
