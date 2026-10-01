import { useEffect, useRef, useState } from "react";
import "../../styles/execution-activity.css";

export type NativeExecutionActivity = {
  scopeKey:string;
  generatedAt:string;
  counts:{training:number;experiments:number};
  items:Array<{kind:"training"|"experiment";location:"hosted"|"local";id:string;name:string;phase:string;updatedAt:string;href?:string}>;
  hasMore:boolean;
};
/** Parent supplies one authorized aggregate for the active workspace/Project.
 * The trigger and continuous ring retain identity during polling. */
export function ExecutionActivityControl({summary,scopeKey,loading,error,onRetry,onSelect}: {
  summary:NativeExecutionActivity|null;scopeKey:string;loading:boolean;error:string|null;
  onRetry:()=>void;onSelect:(item:NativeExecutionActivity["items"][number])=>void;
}) {
  const [open,setOpen]=useState(false), root=useRef<HTMLDivElement>(null);
  const value=summary?.scopeKey===scopeKey?summary:null;
  const active=Boolean(value&&value.counts.training+value.counts.experiments>0);
  const formatCount=(count:number)=>new Intl.NumberFormat(undefined,{notation:"compact",maximumFractionDigits:1}).format(count);
  const status=error?value?"Activity reconnecting":"Activity unavailable":loading&&!value?"Checking activity":active?"Active work":"No active work";
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape"){setOpen(false);root.current?.querySelector<HTMLButtonElement>("button")?.focus();}};
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);
    return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape);};
  },[open]);
  return <div className="execution-activity" ref={root}>
    <button className="execution-activity-trigger" type="button" aria-expanded={open} aria-controls="execution-activity-list" aria-label={`${status}${value?`: ${value.counts.training} training, ${value.counts.experiments} experiments`:""}`} onClick={()=>setOpen(v=>!v)}>
      <span aria-hidden="true" className={`execution-activity-ring${active?" is-active":""}`}/>
      {value?<><span className="execution-activity-training">{formatCount(value.counts.training)} training</span><span className="execution-activity-experiments">{formatCount(value.counts.experiments)} experiments</span></>:<span>{status}</span>}
    </button>
    <div id="execution-activity-list" className="execution-activity-list" hidden={!open}>
      <p className="execution-activity-scope">Activity in the selected workspace and Project</p>
      {error?<p role="status">{status}. <button type="button" onClick={onRetry}>Retry</button></p>:null}
      <ul>{value?.items.map(item=><li key={`${item.kind}:${item.location}:${item.id}`}><button type="button" onClick={()=>onSelect(item)}><span>{item.name}</span><small>{item.kind==="training"?"Training":"Experiment"} {item.phase.replaceAll("_"," ")}</small></button></li>)}</ul>
      {!value?.items.length?<p role="status">{status}</p>:null}
      {value?.hasMore?<p>Counts include all active work.</p>:null}
    </div>
  </div>;
}
