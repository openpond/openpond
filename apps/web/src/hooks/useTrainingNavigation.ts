import { useQuery } from "@tanstack/react-query";
import type { TrainingNavigationResponse } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../api/api-client";
import { connectionQueryScope } from "../lib/query-scope";

export function useTrainingNavigation(connection: ClientConnection | null, profileId: string) {
  return useQuery({
    queryKey: ["training-navigation", connectionQueryScope(connection), profileId],
    queryFn: ({ signal }) =>
      apiFetch<TrainingNavigationResponse>(
        connection!,
        `/v1/training/navigation?profileId=${encodeURIComponent(profileId)}`,
        { signal },
      ),
    enabled: Boolean(connection),
    staleTime: 30_000,
    gcTime: 300_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}
