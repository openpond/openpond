import {useInfiniteQuery} from "@tanstack/react-query";
import type {z} from "zod";
import type {ConnectedRecordedListSchema} from "openpond-sdk/connected-evidence";
import type {ModelsRoute} from "../models-route";
import type {WorkspaceApi} from "./workspace-api";
import {EvaluationTime} from "./EvaluationPresentation";
export type RecordedExperimentPage=z.infer<typeof ConnectedRecordedListSchema>;

export function useRecordedExperimentHistory(api:WorkspaceApi) {
  return useInfiniteQuery({queryKey:["evaluation-workspace",api.key,"recordedExperiments"],
    initialPageParam:undefined as string|undefined,getNextPageParam:(page:RecordedExperimentPage)=>page.nextCursor??undefined,
    queryFn:({signal,pageParam})=>api.request<RecordedExperimentPage>("connectedRecordedList",{...(api.projectId?{projectId:api.projectId}:{}),...(pageParam?{cursor:pageParam}:{}),limit:30},signal),
  });
}
export function RecordedExperimentCollection({api,route,navigate}:{api:WorkspaceApi;route:ModelsRoute;navigate(route:ModelsRoute):void}) {
  const query=useRecordedExperimentHistory(api);
  const items=[...new Map((query.data?.pages.flatMap(page=>page.items)??[]).map(item=>[item.id,item])).values()];
  const visible=items.filter(item=>!route.query||item.name.toLocaleLowerCase().includes(route.query.toLocaleLowerCase()));
  return <section><h2>Recorded evidence</h2><table className="training-data-table"><thead><tr><th>Experiment</th><th>Dataset</th><th>Frozen cases</th><th>Created</th></tr></thead>
    <tbody>{visible.map(item=><tr key={item.id}><td><button className="training-text-button" onClick={()=>navigate({...route,resourceId:item.id,executionKind:"recorded_evidence",passId:null,projectId:item.projectId,detailTab:"overview",after:null})}>{item.name}</button></td><td>{item.dataset.id} / revision {item.dataset.revision}</td><td>{item.caseCount}</td><td><EvaluationTime value={item.createdAt}/></td></tr>)}</tbody></table>
    {query.error?<p role="alert">{query.error.message}<button onClick={()=>void query.refetch()}>Retry</button></p>:null}
    {!items.length?<p role="status">{query.isPending?"Reading frozen recorded Experiments…":"No frozen recorded Experiments in this workspace."}</p>:null}
    {query.hasNextPage?<button disabled={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage()}>More recorded Experiments</button>:null}
  </section>;
}
