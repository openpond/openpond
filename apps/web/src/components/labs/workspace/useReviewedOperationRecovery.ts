import {useInfiniteQuery} from "@tanstack/react-query";
import {EvaluationOperationRecoveryPageSchema,type EvaluationOperationRecovery} from "@openpond/contracts";
import type {WorkspaceApi} from "./workspace-api";
import {evaluationOwnerKey} from "./advanced-evaluation-api";
export function useReviewedOperationRecovery(api:WorkspaceApi,action:EvaluationOperationRecovery["action"]){
  return useInfiniteQuery({
    queryKey:["reviewed-evaluation-operations",evaluationOwnerKey(api),action],initialPageParam:undefined as string|undefined,
    getNextPageParam:(page:{items:EvaluationOperationRecovery[];nextCursor:string|null})=>page.nextCursor??undefined,
    queryFn:async({pageParam,signal})=>EvaluationOperationRecoveryPageSchema.parse(await api.pendingOperations(action,pageParam,signal)),
    refetchOnWindowFocus:true,
  });
}
