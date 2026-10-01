import {useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {contentHash} from "@openpond/harness";
import {LocalExperimentSourceChoicesSchema,OpenPondProfileRefSchema} from "@openpond/contracts";
import {HostedTasksetSummarySchema,type HostedTasksetSummary} from "openpond-sdk/taskset-catalog";
import {ProfileEvaluationDiscoverySchema,type ProfileEvaluationDiscovery} from "openpond-sdk/experiments";
import {api as nativeApi} from "../../../api";
import {WorkspacePanel} from "./WorkspacePanel";
import {EvaluationTableState} from "./EvaluationTableState";
import {useEvaluationSetup} from "./EvaluationSetupState";
import type {Inventory,WorkspaceApi} from "./workspace-api";
import type {ModelsRoute} from "../models-route";

export function WorkflowEvaluationDiscovery({api,inventory,route,navigate,onClose}:{
  api:WorkspaceApi;inventory:Inventory|null;route:ModelsRoute;navigate:(value:ModelsRoute)=>void;onClose:()=>void;
}){
  const setup=useEvaluationSetup();
  const [sourceId,setSourceId]=useState("");
  const library=useQuery({queryKey:["workflow-evaluation-library",api.key],enabled:api.location==="local",
    queryFn:()=>nativeApi.profileCatalog(api.connection)});
  const local=useQuery({queryKey:["evaluation-workspace",api.key,"localSources"],enabled:api.location==="local",
    queryFn:async({signal})=>LocalExperimentSourceChoicesSchema.parse(await api.local("sourceChoices",{},signal))});
  const projects=inventory?.projects.projects.filter(project=>!api.projectId||project.id===api.projectId)??[];
  const hostedSources=[...new Map(projects.flatMap(project=>project.content.targets.flatMap(item=>
    item.target.kind==="harness"||item.target.kind==="suite"?[[item.target.profileRepositoryId,{id:item.target.profileRepositoryId,name:project.content.name}] as const]:[]))).values()];
  const sources=api.location==="local"?library.data?.profiles.filter(item=>item.ref.source==="local").map(item=>({id:contentHash(item.ref),name:item.name,ref:item.ref}))??[]:hostedSources;
  const selected=sources.find(item=>item.id===sourceId);
  const discovery=useQuery({queryKey:["workflow-evaluation-discovery",api.key,sourceId],enabled:Boolean(selected),
    queryFn:async({signal})=>ProfileEvaluationDiscoverySchema.parse(api.location==="local"&&selected&&"ref" in selected
      ?await nativeApi.profileEvaluationDiscovery(api.connection,OpenPondProfileRefSchema.parse(selected.ref),signal)
      :await api.request("profileEvaluationDiscovery",{profileRepositoryId:sourceId},signal))});
  const value=discovery.data;
  function localChoice(definition:ProfileEvaluationDiscovery["definitions"][number]){
    return local.data?.profiles.find(item=>value&&contentHash(item.profileRef)===contentHash(value.profileRef)
      &&item.sourceRevision===value.sourceRevision&&contentHash(item.harnessRelease)===contentHash(value.harnessRelease)
      &&item.definitionId===definition.id&&item.definitionHash===contentHash(definition));
  }
  function hostedChoice(definition:ProfileEvaluationDiscovery["definitions"][number]){
    return projects.flatMap(project=>project.content.targets).find(item=>item.target.kind==="harness"&&value
      &&item.target.profileRepositoryId===value.profileRef.repositoryId&&item.target.source.profileId===value.profileRef.profileId
      &&item.target.source.sourceRevision===value.sourceRevision&&item.target.source.definitionHash===contentHash(definition)
      &&item.target.source.catalogHash===value.catalogHash&&contentHash(item.target.source.harnessRelease)===contentHash(value.harnessRelease));
  }
  const released=(definition:ProfileEvaluationDiscovery["definitions"][number])=>inventory?.releasedDatasets.items.find(item=>
    item.release.id===definition.tasksetRelease.id&&item.release.contentHash===definition.tasksetRelease.contentHash);
  const exactDatasets=useQuery({queryKey:["workflow-evaluation-datasets",api.key,sourceId,value?.sourceRevision,value?.catalogHash],enabled:api.location==="hosted"&&Boolean(value),
    queryFn:async({signal})=>{
      const rows:HostedTasksetSummary[]=[],references=[...new Map(value!.definitions.filter(definition=>hostedChoice(definition)&&!released(definition)).map(definition=>[contentHash(definition.tasksetRelease),definition.tasksetRelease])).values()];
      let next=0;
      await Promise.all(Array.from({length:Math.min(4,references.length)},async()=>{while(next<references.length){const release=references[next++]!;signal.throwIfAborted();
        try{const row=HostedTasksetSummarySchema.parse(await api.request("resolveDataset",{release},signal));if(contentHash(row.release)!==contentHash(release))throw new Error("Exact Dataset release changed.");rows.push(row);}
        catch(error){if(signal.aborted)throw error;}
      }}));
      return rows;
    }});
  const exactReleased=(definition:ProfileEvaluationDiscovery["definitions"][number])=>released(definition)??exactDatasets.data?.find(item=>contentHash(item.release)===contentHash(definition.tasksetRelease));
  function useDefinition(definition:ProfileEvaluationDiscovery["definitions"][number]){
    if(setup.draft)return;
    const source=localChoice(definition),target=hostedChoice(definition),dataset=exactReleased(definition);
    const release=api.location==="local"?source?.taskset:dataset?.release;
    if(!release||api.location==="local"&&!source||api.location==="hosted"&&!target)return;
    setup.open(null,release,route,target?.id??"model");
    setup.setDraft(current=>current?{...current,mode:"model_harness_profile",profileChoiceId:source?.id??"",
      name:definition.label,seed:definition.seeds.join(", ")}:current);
    setup.selectAll(release,definition.taskIds.length===0);
    for(const id of definition.taskIds)setup.toggle(release,id,true);
    onClose();
  }
  return <WorkspacePanel action="workflow-evaluations" label="Existing Workflow evaluations" onRequestClose={onClose}>
    <header><h2>Existing evaluations</h2></header>
    <label className="training-taskset-selector"><span>Released Profile</span><select value={sourceId} onChange={event=>setSourceId(event.target.value)}>
      <option value="">Choose an authorized source</option>{sources.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    {library.error?<p role="alert">{library.error.message}</p>:null}
    {!sources.length&&!library.isPending?<p>No authorized released Profile sources are associated with this view.</p>:null}
    {value?<><p>Source revision {value.sourceRevision}</p><p>Catalog {value.catalogHash??"No released catalog"}</p>
      <table className="training-data-table"><thead><tr><th>Evaluation</th><th>Dataset</th><th>Selection</th></tr></thead><tbody>
        {value.definitions.map(definition=>{
          const source=localChoice(definition),dataset=exactReleased(definition),target=hostedChoice(definition);
          const ready=api.location==="local"?Boolean(source):Boolean(dataset&&target);
          return <tr key={definition.id}><td><strong>{definition.label}</strong><p>{definition.target.kind}</p>
            <details><summary>Exact definition</summary><pre>{JSON.stringify(definition,null,2)}</pre></details>
            <button type="button" className="training-button" disabled={!ready||Boolean(setup.draft)} onClick={()=>useDefinition(definition)}>Use existing evaluation</button>
            {!ready?<p>{exactDatasets.isFetching&&api.location==="hosted"?"Resolving the exact Dataset release…":"Its exact Dataset and executable source are unavailable in this selection."}</p>:null}
          </td><td>{definition.tasksetRelease.id}<p>{definition.tasksetRelease.contentHash}</p>
            {source||dataset?<button type="button" className="training-button" onClick={()=>{onClose();navigate({...route,page:"datasets",resourceId:source?.id??dataset!.id,
              datasetKind:source?undefined:"release",revision:source?.taskset.revision??dataset!.release.revision,
              contentHash:definition.tasksetRelease.contentHash,detailTab:"tasks",after:null});}}>Open Dataset</button>:null}
          </td><td>{definition.taskIds.length?`${definition.taskIds.length} pinned tasks`:"Declared split"}<p>{definition.seeds.join(", ")}</p></td></tr>;
        })}
        <EvaluationTableState columns={3} empty={!value.definitions.length}>No definitions in this exact released Profile.</EvaluationTableState>
      </tbody></table>
      <h3>Suites</h3>{value.suites.map(suite=><details key={suite.id}><summary>{suite.label}</summary>
        <p>{suite.scope}</p><ul>{suite.definitionIds.map(id=><li key={id}>{value.definitions.find(item=>item.id===id)?.label??id}</li>)}</ul>
        {value.suiteRuns.filter(run=>run.suiteId===suite.id).map(run=><details key={run.id}><summary>Suite receipt {run.id}</summary><pre>{JSON.stringify(run,null,2)}</pre></details>)}
      </details>)}
      <h3>Retained executions</h3>{value.runs.map(run=><details key={run.manifest.id}><summary>{run.manifest.id}, {run.passed?"Passed":"Did not pass"}</summary>
        <p>Retained source execution. Review its exact manifest and receipts before choosing a released definition for a new run.</p>
        <pre>{JSON.stringify(run,null,2)}</pre></details>)}
      {value.comparisons.map(comparison=><details key={comparison.id}><summary>Comparison {comparison.id}</summary><pre>{JSON.stringify(comparison,null,2)}</pre></details>)}
      {value.reports.map(report=><details key={report.id}><summary>Report {report.id}</summary><pre>{JSON.stringify(report,null,2)}</pre></details>)}
    </>:selected?<>{discovery.isPending?<p role="status">Loading exact evaluations…</p>:null}{discovery.error?<p role="alert">{discovery.error.message} <button type="button" className="training-button" onClick={()=>void discovery.refetch()}>Retry</button></p>:null}</>:null}
  </WorkspacePanel>;
}
