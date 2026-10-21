import { useQuery } from "@tanstack/react-query";
import { api, type ClientConnection } from "../../api";
import { connectionQueryScope } from "../../lib/query-scope";

const ACTIVE_STATUSES = new Set(["queued", "starting", "running", "cancelling", "reconciling"]);

/** Render retained evidence immediately; a slow hosted read only refreshes it.
 * Query scope prevents an old account/run response from becoming another run's data. */
export function useTrainingRunDetail(
  connection: ClientConnection | null,
  jobId: string | null,
  jobStatus: string | null,
  includeEvaluation = false,
) {
  const scope = connectionQueryScope(connection);
  const key = ["training-run-detail", scope, jobId, includeEvaluation] as const;
  const enabled = Boolean(connection && jobId);
  const retained = useQuery({
    queryKey: [...key, "retained"],
    queryFn: ({ signal }) => api.trainingRunDetail(connection!, jobId!, { includeEvaluation, refresh: false, signal }),
    enabled,
    staleTime: 30_000,
    gcTime: 60_000,
  });
  const live = useQuery({
    queryKey: [...key, "hosted"],
    queryFn: ({ signal }) => api.trainingRunDetail(connection!, jobId!, { includeEvaluation, signal }),
    enabled,
    staleTime: 30_000,
    gcTime: 60_000,
    refetchInterval: jobStatus && ACTIVE_STATUSES.has(jobStatus) ? 3_000 : false,
    refetchIntervalInBackground: false,
  });
  const detail = live.data ?? retained.data ?? null;
  return {
    detail,
    loading: enabled && !detail && (retained.isPending || live.isPending),
    error: live.error?.message ?? retained.error?.message ?? null,
    refresh: async () => (await live.refetch()).data ?? null,
  };
}
