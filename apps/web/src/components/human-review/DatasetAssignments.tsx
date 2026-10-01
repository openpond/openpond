import type {DatasetPopulationPage} from "openpond-sdk/dataset-workspaces";
import type {WorkspaceApi} from "../labs/workspace/workspace-api";
import type {ModelsRoute} from "../labs/models-route";
import {useDatasetPopulation} from "../labs/workspace/useDatasetPopulation";
import {useEvaluationSetup} from "../labs/workspace/EvaluationSetupState";
import {HumanReviewLaunch} from "./HumanReviewLaunch";
import {useHumanGraderChoices} from "./useHumanGraderChoices";
export function DatasetAssignments({api,release,route,navigate,localSourceId}:{api:WorkspaceApi;release:DatasetPopulationPage["release"];route:ModelsRoute;navigate:(route:ModelsRoute)=>void;localSourceId?:string}){
  const setup=useEvaluationSetup(),context=api.humanContext,projectId=route.projectId??api.projectId;
  const population=useDatasetPopulation(api,release,localSourceId,Boolean(context&&projectId));
  const graders=useHumanGraderChoices(context??undefined,projectId??undefined,release);
  const ids=population.data?.items.filter(item=>setup.selected(release,item.id)).map(item=>item.id)??[];
  const all=Boolean(population.data&&ids.length===population.data.taskCount);
  const ready=Boolean(context&&projectId&&ids.length&&ids.length<=1000&&!population.error);
  return <section aria-label="Task assignments"><p>{ids.length} selected tasks, independent progress per task</p>{population.error||graders.error?<p role="alert">{population.error?.message??graders.error}</p>:null}{ids.length>1000?<p>Choose a subset of at most 1,000 tasks per assignment batch.</p>:null}{!projectId?<p>Select the owning Project to assign these tasks.</p>:null}{ready&&context&&projectId?(["author","execute"] as const).map(kind=><HumanReviewLaunch key={`${api.key}:${release.contentHash}:${kind}`} context={context} projectId={projectId} selections={[]} graders={graders.choices.filter(g=>g.mode==="individual")} tasks={{dataset:release,kind,...(all?{all:true}:{taskIds:ids})}} onOpenReview={record=>navigate({...route,page:"inbox",resourceId:record.id,detailTab:null,projectId})}/>):null}</section>;
}
