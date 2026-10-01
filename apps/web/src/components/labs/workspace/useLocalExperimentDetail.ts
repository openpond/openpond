import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { LocalExperimentRecordSchema, LocalExperimentExecutionPageSchema, LocalExperimentResultSchema, LocalExperimentScoringPassSchema,LocalExperimentComparisonSchema } from "@openpond/contracts";
import { localRequest } from "./local-workspace-api";
import type { WorkspaceApi } from "./workspace-api";
import type { ModelsRoute } from "../models-route";
export function useLocalExperimentDetail(api: WorkspaceApi, route: ModelsRoute) {
  const queryClient = useQueryClient(), base = ["local-experiments", api.key], executionId = route.resourceId;
  const execution = useQuery({
    queryKey: [...base, "experiment", executionId, route.contentHash], enabled: Boolean(executionId),
    queryFn: ({ signal }) => localRequest(api, LocalExperimentRecordSchema, "read", { id: executionId, ...(route.contentHash ? {configurationHash:route.contentHash} : {}) }, signal),
    refetchInterval: query => query.state.data?.completedAt ? false : 1000,
  });
  const passes = useInfiniteQuery({
    queryKey: [...base, "passes", executionId], enabled: Boolean(execution.data), initialPageParam: undefined as string | undefined,
    queryFn: ({signal,pageParam}) => localRequest(api, LocalExperimentExecutionPageSchema, "passes", {executionId, ...(pageParam?{afterId:pageParam}:{})}, signal),
    getNextPageParam: page => page.nextCursor ?? undefined, refetchInterval: query => query.state.data?.pages.some(page=>page.items.some(pass=>!pass.completedAt)) ? 3000 : false,
  });
  const resultId = route.passId ?? executionId;
  const result = useQuery({
    queryKey: [...base,"result",resultId], enabled: Boolean(execution.data && resultId),
    queryFn: async ({signal}) => {
      const value = await localRequest(api,LocalExperimentResultSchema,"result",{id:resultId},signal);
      if (route.passId ? value.execution.kind!=="scoring" || value.execution.sourceExecution?.id!==executionId
        || value.execution.sourceExecution.executionHash!==execution.data?.executionHash : value.execution.id!==executionId)
        throw new Error("This result belongs to another Experiment.");
      return value;
    }, refetchInterval: query => query.state.data?.execution.completedAt ? false : 1000,
  });
  const selectedPass = useQuery({
    queryKey:[...base,"pass",route.passId],enabled:Boolean(execution.data && route.passId),
    queryFn:async({signal})=> {
      const value=await localRequest(api,LocalExperimentScoringPassSchema,"pass",{id:route.passId},signal);
      if(value.execution.sourceExecution?.id!==executionId||value.execution.sourceExecution.executionHash!==execution.data?.executionHash)
        throw new Error("This scoring pass belongs to another Experiment.");
      return value;
    },refetchInterval:query=>query.state.data?.execution.completedAt?false:1000,
  });
  const evidence=useQuery({queryKey:[...base,"portable-evidence",resultId],enabled:Boolean(result.data?.execution.completedAt&&resultId),
    queryFn:async({signal})=>(await localRequest(api,LocalExperimentComparisonSchema,"compare",{baselineId:resultId,candidateId:resultId},signal)).baseline});
  return {execution,executionId,passes,result,resultId,selectedPass,evidence,refresh:()=>queryClient.invalidateQueries({queryKey:base})};
}
