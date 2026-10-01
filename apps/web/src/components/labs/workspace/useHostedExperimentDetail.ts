import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { ExperimentRunDetails, ExperimentScoringPass } from "openpond-sdk/experiments";
import type { ModelsRoute } from "../models-route";
import type { ExperimentEvidence, WorkspaceApi } from "./workspace-api";
const active = (status: string) => ["queued", "running", "cancelling"].includes(status);
type Passes = { items: ExperimentScoringPass[]; nextCursor: string | null };
/** A resource pathname identifies one immutable Experiment, never a mutable parent. */
export function useHostedExperimentDetail(api: WorkspaceApi, route: ModelsRoute) {
  const executionId = route.resourceId;
  const execution = useQuery({
    queryKey: ["evaluation-workspace", api.key, "experiment", executionId], enabled: Boolean(executionId),
    queryFn: ({ signal }) => api.request<ExperimentRunDetails>("experiment", { id: executionId }, signal),
    refetchInterval: query => query.state.data && active(query.state.data.summary.status) ? 2_000 : false,
  });
  const passes = useInfiniteQuery({
    queryKey: ["evaluation-workspace", api.key, "scoringPassPages", executionId], enabled: Boolean(execution.data),
    initialPageParam: undefined as string | undefined, getNextPageParam: (page: Passes) => page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }) => api.request<Passes>("passes", { id: executionId, ...(pageParam ? { afterId: pageParam } : {}) }, signal),
    refetchInterval: query => query.state.data?.pages.some(page => page.items.some(pass => active(pass.status))) ? 2_000 : false,
  });
  const selectedPass = useQuery({
    queryKey: ["evaluation-workspace", api.key, "selectedPass", executionId, route.passId], enabled: Boolean(execution.data && route.passId),
    queryFn: async ({ signal }) => {
      const pass = await api.request<ExperimentScoringPass>("pass", { id: route.passId }, signal);
      if (pass.request.execution.id !== executionId || pass.request.execution.contentHash !== execution.data?.summary.manifestHash) throw new Error("This scoring pass does not belong to the selected Experiment.");
      return pass;
    }, refetchInterval: query => query.state.data && active(query.state.data.status) ? 2_000 : false,
  });
  const passItems = [...new Map([...(passes.data?.pages.flatMap(page => page.items) ?? []), ...(selectedPass.data ? [selectedPass.data] : [])].map(pass => [pass.id, pass])).values()];
  const evidence = useQuery({
    queryKey: ["evaluation-workspace", api.key, "result", executionId, route.passId],
    enabled: Boolean(execution.data && (route.passId ? selectedPass.data?.resultAvailable : execution.data.summary.resultAvailable)),
    queryFn: ({ signal }) => api.request<ExperimentEvidence>(route.passId ? "passResult" : "result", { id: route.passId ?? executionId }, signal),
  });
  async function refresh() { await Promise.all([execution.refetch(), passes.refetch(), ...(route.passId ? [selectedPass.refetch()] : [])]); }
  return { execution, executionId, passes, passItems, selectedPass, evidence, refresh };
}
