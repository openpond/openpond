import { chatTrainingAttachmentKey, type ChatTrainingAttachment } from "@openpond/contracts";
import { useEffect, useId, useState } from "react";
import { inlineErrorMessage } from "../../lib/error-messages";
import { ComposerResourcePanel, type ResourcePanelKind } from "./ComposerResourcePanel";
import { ComposerExperimentSetup } from "./ComposerExperimentSetup";
import { experimentAction } from "./composer-experiment-action";
import { DropdownSelect } from "../DropdownSelect";
import { ChevronDown, MoreVertical, MessageSquare } from "../icons";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import "./composer-resources.css";

export function ComposerResourceControls({resources,busy,onDraft}: {
  resources:ReturnType<typeof useChatResourceFocus>; busy:boolean; onDraft:(text:string,training?:ChatTrainingAttachment)=>void;
}) {
  const [panel,setPanel]=useState<ResourcePanelKind>("experiment");
  const [hasOpened,setHasOpened]=useState(false), [expanded,setExpanded]=useState(false);
  const [action,setAction]=useState("Run");
  const panelId=useId();
  const {scope,focus}=resources;
  useEffect(()=>{setExpanded(false);setHasOpened(false);},[scope?.id]);
  if(!scope)return null;
  const dataset=focus.dataset, isExperiment=scope.ordinal!==null, disabled=busy||resources.selecting;
  const datasets=dataset ? [dataset,...resources.datasets.filter(item=>item.id!==dataset.id||item.revision!==dataset.revision)] : resources.datasets;
  const previous=scope.runs.at(-1);
  const run=focus.experiment ?? (previous ? resources.experiments.find(item=>item.id===previous.id) ?? previous : null);
  const model=scope.evaluationModel;
  const selectedGrader=resources.graders.find(item=>item.id===scope.selectedGraderId);
  const executionReady=Boolean(dataset&&resources.graders.length&&resources.models.some(item=>`${item.providerId}/${item.id}`===model));
  const actionReady=!["Run","Run updated","Repeat run","Retry"].includes(action)||(executionReady&&!run?.state.match(/^(running|queued|pending|starting)$/i));
  const primary=experimentAction({isExperiment,dataset,graders:resources.graders.length,model,
    modelAvailable:resources.models.some(item=>`${item.providerId}/${item.id}`===model),run});
  function open(next:ResourcePanelKind) {setPanel(next);setHasOpened(true);setExpanded(true);}
  function request(next:string) {setAction(next);open("action");}
  const modelChoice=resources.models.find(item=>`${item.providerId}/${item.id}`===model);
  const modelLabel=modelChoice ? `${modelChoice.name??modelChoice.id} (${modelChoice.providerId})` : model;
  const gradersLabel=`${resources.graders.length} dataset grader${resources.graders.length===1?"":"s"}`;
  const context=dataset ? `${dataset.name} V${dataset.revision}` : "this dataset";
  const requests:Record<string,string>={
    Run:`Run ${context} against ${modelLabel}, using ${gradersLabel}.`,
    "Run updated":`Run the updated configuration for ${context} against ${modelLabel}, using ${gradersLabel}. Keep previous results for comparison.`,
    Retry:`Inspect why the previous run stopped, then retry ${context} against ${modelLabel} with its dataset graders if appropriate. Reconcile any uncertain submission first.`,
    "Repeat run":`Repeat ${context} against ${modelLabel} with its dataset graders as a new run. Preserve the previous results.`,
    Improve:`Review the results and coverage of experiment ${scope.ordinal} and propose a concrete next experiment.`,
    "View progress":`Check the progress of experiment ${scope.ordinal}${run ? ` (run ${run.id})` : ""}.`,
    Compare:`Compare experiment ${scope.ordinal}${run ? ` (run ${run.id})` : ""} with its earlier results.`,
    "Test grader":`Test ${selectedGrader?.name ?? "the dataset graders"} on ${context} against known-good and known-bad examples.`,
  };
  return <div className={`composer-resource-area ${expanded ? "is-expanded" : ""}`}>
    <div className="composer-resource-bar" aria-label={isExperiment ? "Current experiment" : "Current dataset"}>
      {isExperiment ? <DropdownSelect compact floating placement="top" floatingMenuWidth={280} label="Experiment scope" value={scope.id} className="composer-resource-number"
        triggerContent={<><span>{scope.ordinal}</span><ChevronDown size={12}/></>} tooltip={`${scope.ordinal}: ${scope.name}`}
        options={[...(focus.scopeContext?.scopes??[]).map(item=>({value:item.id,label:`${item.ordinal}  ${item.name}`})),{value:"new",label:"New experiment",icon:"plus"}]}
        onChange={value=>{if(value==="new")open("new-experiment");else void resources.selectScope(value);}} disabled={disabled}/> : null}
      <DropdownSelect compact floating searchable floatingMenuWidth={320} placement="top" label="Dataset focus" className="composer-resource-dataset"
        value={dataset ? `${dataset.id}@${dataset.revision}` : ""} tooltip={context}
        triggerContent={<><span className="composer-resource-dataset-name">{dataset?.name??"Dataset"}</span>{dataset ? <span className="composer-resource-version">V{dataset.revision}</span>:null}<ChevronDown size={12}/></>}
        options={[{value:"",label:"Choose dataset"},...datasets.map(item=>({value:`${item.id}@${item.revision}`,label:`${item.name} V${item.revision}`})),{value:"create",label:"New dataset…",icon:"plus"}]}
        onChange={value=>{if(value==="create")return open("dataset");const at=value.lastIndexOf("@");void resources.select("dataset",at<0?value:value.slice(0,at),at<0?undefined:Number(value.slice(at+1)));}} disabled={disabled}/>
      <DropdownSelect compact floating placement="top" floatingMenuWidth={280} label="Grader focus" className="composer-resource-graders" value={scope.selectedGraderId??""}
        options={[{value:"",label:"All graders",shortLabel:`Graders ${resources.graders.length}`},...resources.graders.map(item=>({value:item.id,label:item.name})),{value:"add",label:"Create grader…",icon:"plus",separatorBefore:true},{value:"test",label:"Test selected grader…",disabled:!scope.selectedGraderId}]}
        onChange={value=>{if(value==="add")open("grader");else if(value==="test")request("Test grader");else void resources.select("grader",value);}} disabled={disabled||!dataset}/>
      <button type="button" className="composer-resource-primary" disabled={disabled} onClick={()=>primary==="New experiment"||primary==="Set up"?open("experiment"):request(primary)}>{primary}</button>
      {dataset && !dataset.owner && !dataset.profileRef ? <button type="button" className="composer-resource-secondary" disabled={disabled} onClick={()=>open("training")}>Train…</button>:null}
      <DropdownSelect compact floating placement="top" floatingMenuWidth={250} label="More resource actions" value="" className="composer-resource-more" triggerContent={<MoreVertical size={15}/>}
        options={[...(run ? [{value:"Compare",label:"Compare results…"},...(primary==="Improve"?[{value:"Repeat run",label:"Repeat run…"}]:[])]:[]),
          ...(scope.training??[]).map((job,index)=>({value:`training:${chatTrainingAttachmentKey(job)}`,label:`Training ${index+1}…`,description:job.location==="cloud"?"Hosted":"Local"}))]}
        onChange={value=>{if(value.startsWith("training:")){const job=scope.training?.find(item=>`training:${chatTrainingAttachmentKey(item)}`===value);if(job)onDraft("Check this training job and show its results and any model it produced.",job);}else request(value);}} disabled={disabled||!run&&!scope.training?.length}/>
      <button type="button" className="composer-resource-expand" aria-label={expanded?"Collapse resource controls":"Expand resource controls"} aria-expanded={expanded} aria-controls={panelId}
        onClick={()=>{setHasOpened(true);if(!expanded)setPanel("experiment");setExpanded(value=>!value);}}><ChevronDown size={15}/></button>
    </div>
    <div id={panelId} className="composer-resource-expansion" inert={!expanded} aria-hidden={!expanded}><div className="composer-resource-expansion-inner">
      {hasOpened ? panel==="experiment"||panel==="new-experiment" ? <ComposerExperimentSetup resources={resources} busy={busy} createNew={panel==="new-experiment"||!isExperiment} onClose={()=>setExpanded(false)} onAddGrader={()=>open("grader")} onRows={()=>open("rows")}/>
        : panel==="action" ? <div className="composer-resource-request"><div className="composer-experiment-setup-heading"><strong>{action}</strong></div><p>{requests[action]}</p><button type="button" className="composer-experiment-create" disabled={disabled||!actionReady} onClick={()=>{onDraft(requests[action]!);setExpanded(false);}}><MessageSquare size={13} aria-hidden /> Add to chat</button></div>
        : <ComposerResourcePanel key={`${panel}:${dataset?.id}:${dataset?.revision}`} kind={panel} resources={resources} busy={busy} onDraft={text=>{onDraft(text);setExpanded(false);}}/> : null}
    </div></div>
    {resources.error&&inlineErrorMessage(resources.error)?<div role="status" className="chat-resource-error">{resources.error}</div>:null}
  </div>;
}
