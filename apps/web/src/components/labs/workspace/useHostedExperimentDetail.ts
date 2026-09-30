import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ExperimentDefinitionRefSchema, type ExperimentDefinition, type ExperimentScoringPass } from "openpond-sdk/experiments";
import type { ModelTasksetRunDetails } from "openpond-sdk/model-taskset-runs";
import type { ModelsRoute } from "../models-route";
import type { ExperimentEvidence, WorkspaceApi } from "./workspace-api";

const active = (status: string) => ["queued", "running", "cancelling"].includes(status);
type Executions = { items: ModelTasksetRunDetails[]; nextCursor: string | null };
type Passes = { items: ExperimentScoringPass[]; nextCursor: string | null };

/** Collection paging and exact direct links share their authorized SDK reads.
 * Latest editable setup never substitutes for an older execution's pins. */
export function useHostedExperimentDetail(api: WorkspaceApi, route: ModelsRoute) {
  const definition = useQuery({
    queryKey: ["evaluation-workspace", api.key, "definition", route.resourceId], enabled: Boolean(route.resourceId),
    queryFn: ({ signal }) => api.request<ExperimentDefinition>("definition", { id: route.resourceId }, signal),
  });
  const history = useInfiniteQuery({
    queryKey: ["evaluation-workspace", api.key, "executionPages", route.resourceId], enabled: Boolean(route.resourceId),
    initialPageParam: undefined as string | undefined, getNextPageParam: (page: Executions) => page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }) => api.request<Executions>("executions", { id: route.resourceId, ...(pageParam ? { afterId: pageParam } : {}) }, signal),
    refetchInterval: query => query.state.data?.pages.some(page => page.items.some(run => active(run.summary.status))) ? 2_000 : false,
  });
  const historyItems = history.data?.pages.flatMap(page => page.items) ?? [];
  const executionId = route.executionId ?? historyItems[0]?.summary.id ?? null;
  const execution = useQuery({
    queryKey: ["evaluation-workspace", api.key, "execution", executionId, route.resourceId], enabled: Boolean(executionId && route.resourceId),
    queryFn: async ({ signal }) => {
      const run = await api.request<ModelTasksetRunDetails>("execution", { id: executionId }, signal);
      const reference = ExperimentDefinitionRefSchema.safeParse(run.manifest.metadata.experimentDefinition);
      if (!reference.success || reference.data.id !== route.resourceId) throw new Error("This execution does not belong to the selected Experiment.");
      return run;
    }, refetchInterval: query => query.state.data && active(query.state.data.summary.status) ? 2_000 : false,
  });
  const reference = ExperimentDefinitionRefSchema.safeParse(execution.data?.manifest.metadata.experimentDefinition);
  const executedRef = reference.success ? reference.data : null;
  const sameDefinition = Boolean(executedRef && definition.data?.contentHash === executedRef.contentHash && definition.data.revision === executedRef.revision);
  const executedDefinition = useQuery({
    queryKey: ["evaluation-workspace", api.key, "executedDefinition", executedRef], enabled: Boolean(executedRef && !definition.isPending && !sameDefinition),
    queryFn: ({ signal }) => api.request<ExperimentDefinition>("definition", { id: executedRef!.id, reference: executedRef }, signal),
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
      if (pass.request.execution.id !== executionId || pass.request.execution.contentHash !== execution.data?.summary.manifestHash) throw new Error("This scoring pass does not belong to the selected execution.");
      return pass;
    }, refetchInterval: query => query.state.data && active(query.state.data.status) ? 2_000 : false,
  });
  const passItems = [...new Map([...(passes.data?.pages.flatMap(page => page.items) ?? []), ...(selectedPass.data ? [selectedPass.data] : [])].map(pass => [pass.id, pass])).values()];
  const executionItems = [...new Map([...historyItems, ...(execution.data ? [execution.data] : [])].map(run => [run.summary.id, run])).values()];
  const evidence = useQuery({
    queryKey: ["evaluation-workspace", api.key, "result", executionId, route.passId],
    enabled: Boolean(execution.data && (route.passId ? selectedPass.data?.resultAvailable : execution.data.summary.resultAvailable)),
    queryFn: ({ signal }) => api.request<ExperimentEvidence>(route.passId ? "passResult" : "result", { id: route.passId ?? executionId }, signal),
  });
  async function refresh() {
    await Promise.all([history.refetch(), ...(executionId ? [execution.refetch(), passes.refetch()] : []), ...(route.passId ? [selectedPass.refetch()] : [])]);
  }
  return { definition, history, execution, executionId, executionItems, passes, passItems, selectedPass, evidence, refresh,
    executedRef, executedDefinition, retainedDefinition: sameDefinition ? definition.data : executedDefinition.data };
}
