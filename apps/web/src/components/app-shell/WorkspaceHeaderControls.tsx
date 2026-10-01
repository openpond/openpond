import { useQuery } from "@tanstack/react-query";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { InboxControl } from "../human-review/InboxControl";
import { ExecutionActivityControl, type NativeExecutionActivity } from "./ExecutionActivityControl";
import { modelsLocation, modelsRouteFromLocation, navigateModelsRoute } from "../labs/lab-primary-tab-state";

export function WorkspaceHeaderControls({connection,teamId,actorId,projectId}:{connection:ClientConnection|null;teamId:string|null;actorId:string|null;projectId:string|null}) {
  const scopeKey=JSON.stringify([teamId,actorId,projectId]);
  const activity=useQuery({queryKey:["workspace-execution-activity",connection?.serverUrl,scopeKey],enabled:Boolean(connection&&teamId&&actorId),staleTime:4_000,refetchInterval:8_000,
    queryFn:({signal})=>apiFetch<NativeExecutionActivity>(connection!,`/v1/training/execution-activity?${new URLSearchParams({teamId:teamId!,...(projectId?{projectId}:{})})}`,{signal})});
  if(!connection||!teamId||!actorId)return null;
  const openInbox=()=>{void navigateModelsRoute(modelsLocation("inbox",null,{area:"console",projectId}));};
  return <>
    <ExecutionActivityControl summary={activity.data??null} scopeKey={scopeKey} loading={activity.isPending} error={activity.error?.message??null} onRetry={()=>{void activity.refetch();}}
      onSelect={item=>{
        if(item.kind==="experiment") {
          const parsed=item.href?modelsRouteFromLocation(new URL(item.href,"https://native.openpond.invalid")):null;
          void navigateModelsRoute(parsed?{...parsed,executionLocation:item.location}:modelsLocation("experiments",null,{area:"console",resourceId:item.id,projectId,executionLocation:item.location}));
        } else {
          const parsed=item.href?modelsRouteFromLocation(new URL(item.href,"https://native.openpond.invalid")):null;
          void navigateModelsRoute(item.location==="local"&&parsed?parsed:modelsLocation("runs",null,{resourceId:`hosted-run:${item.id}`}));
        }
      }}/>
    <InboxControl context={{connection,scope:teamId,actorId,location:"hosted"}} onOpen={openInbox}/>
  </>;
}
