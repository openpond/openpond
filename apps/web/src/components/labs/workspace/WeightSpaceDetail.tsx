import { useQuery } from "@tanstack/react-query";
import { WeightSpaceSessionPanel } from "../../chat/WeightSpaceSessionPanel";
import { ErrorToast } from "../../common/ErrorToast";
import { useManagedWeightSpaceClient } from "./managed-weight-space-api";
import type { WorkspaceApi } from "./workspace-api";
import { useWorkspaceResourceName } from "./WorkspacePanel";
export function WeightSpaceDetail({api,id}:{api:WorkspaceApi;id:string}){
  const client=useManagedWeightSpaceClient(api);
  const source=useQuery({queryKey:["weight-space-detail",api.key,client.data?.account.apiOrigin,id],enabled:Boolean(client.data),retry:false,
    queryFn:({signal})=>{if(!client.data)throw new Error("Read this session's original account first.");return client.data.get(id,signal);}});
  useWorkspaceResourceName(source.data?.name??"Weight-space programming");
  return <><ErrorToast error={source.error??client.error}/>
    {source.data&&client.data?<WeightSpaceSessionPanel key={`${client.data.cacheKey}:${id}`} connection={api.connection} accountKey={api.accountKey} apiOrigin={client.data.account.apiOrigin} initial={source.data}/>:null}
    <button className="training-button secondary" disabled={source.isFetching||client.isFetching} onClick={()=>{void client.refetch();void source.refetch();}}>Reload editing session</button>
  </>;
}
