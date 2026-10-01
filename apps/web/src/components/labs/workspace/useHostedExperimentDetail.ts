import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { ExperimentRunDetails, ExperimentScoringPass } from "openpond-sdk/experiments";
import type { ConnectedRecordedExecution } from "openpond-sdk/connected-evidence";
import type { ModelsRoute } from "../models-route";
import type { ExperimentEvidence, WorkspaceApi } from "./workspace-api";
const active = (status: string) => ["queued", "running", "cancelling"].includes(status);
type Passes = { items: ExperimentScoringPass[]; nextCursor: string | null };
/** Resolve the selected pass's exact owner kind before requesting its source. */
export function useHostedExperimentDetail(api: WorkspaceApi, route: ModelsRoute) {
  const executionId = route.resourceId;
  const selectedPass = useQuery({
    queryKey: ["evaluation-workspace", api.key, "selectedPass", executionId, route.passId, route.executionKind],
    enabled: Boolean(executionId && route.passId),
    queryFn: async ({ signal }) => {
      const pass = await api.request<ExperimentScoringPass>("pass", { id: route.passId }, signal);
      if (pass.request.execution.id !== executionId) throw new Error("This scoring pass belongs to another execution.");
      if (route.executionKind && pass.request.executionKind !== route.executionKind) throw new Error("This scoring pass belongs to a different execution kind.");
      return pass;
    },
    refetchInterval: query => query.state.data && active(query.state.data.status) ? 2_000 : false,
  });
  const recordedKind = route.executionKind === "recorded_evidence" || selectedPass.data?.request.executionKind === "recorded_evidence";
  const execution = useQuery({
    queryKey: ["evaluation-workspace", api.key, "experiment", executionId, selectedPass.data?.request.execution.contentHash],
    enabled: Boolean(executionId && !recordedKind && (!route.passId || selectedPass.isSuccess)),
    queryFn: async ({ signal }) => {
      const run = await api.request<ExperimentRunDetails>("experiment", { id: executionId }, signal);
      if (selectedPass.data && selectedPass.data.request.execution.contentHash !== run.summary.manifestHash) throw new Error("The selected pass's execution pin differs from its retained source.");
      return run;
    },
    refetchInterval: query => query.state.data && active(query.state.data.summary.status) ? 2_000 : false,
  });
  const recorded = useQuery({
    queryKey:["evaluation-workspace",api.key,"recordedExecution",executionId,selectedPass.data?.request.execution.contentHash],
    enabled:Boolean(executionId && recordedKind),
    queryFn:async({signal})=>{
      const source=await api.request<ConnectedRecordedExecution>("recordedExecution",{id:executionId},signal);
      if(selectedPass.data && source.manifest.contentHash!==selectedPass.data.request.execution.contentHash)throw new Error("The recorded source differs from this scoring pass's exact manifest.");
      return source;
    },
  });
  const passes = useInfiniteQuery({
    queryKey: ["evaluation-workspace", api.key, "scoringPassPages", executionId, recordedKind], enabled: Boolean(recordedKind ? recorded.data : execution.data),
    initialPageParam: undefined as string | undefined, getNextPageParam: (page: Passes) => page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }) => api.request<Passes>("passes", { id: executionId, ...(recordedKind ? {executionKind:"recorded_evidence"} : {}), ...(pageParam ? { afterId: pageParam } : {}) }, signal),
    refetchInterval: query => query.state.data?.pages.some(page => page.items.some(pass => active(pass.status))) ? 2_000 : false,
  });
  const passItems = [...new Map([...(passes.data?.pages.flatMap(page => page.items) ?? []), ...(selectedPass.data ? [selectedPass.data] : [])].map(pass => [pass.id, pass])).values()];
  const evidence = useQuery({
    queryKey: ["evaluation-workspace", api.key, "result", executionId, route.passId],
    enabled: Boolean(route.passId ? selectedPass.data?.resultAvailable && (recordedKind ? recorded.data : execution.data) : execution.data?.summary.resultAvailable),
    queryFn: ({ signal }) => api.request<ExperimentEvidence>(route.passId ? "passResult" : "result", { id: route.passId ?? executionId }, signal),
  });
  async function refresh() {
    if(route.passId)await selectedPass.refetch();
    if(recordedKind)await recorded.refetch();else if(!route.passId||selectedPass.isSuccess)await execution.refetch();
    if(recordedKind?recorded.data:execution.data)await passes.refetch();
    if(route.passId?selectedPass.data?.resultAvailable:execution.data?.summary.resultAvailable)await evidence.refetch();
  }
  return { execution, recorded, executionId, passes, passItems, selectedPass, evidence, refresh };
}
