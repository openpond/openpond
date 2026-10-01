import {useState} from "react";
import {contentHash} from "@openpond/harness";
import {AdvancedEditor} from "./AdvancedRefinerEvaluationControl";
import type {AdvancedExperimentTarget} from "./EvaluationSetupState";
import type {WorkspaceApi} from "./workspace-api";
import {WorkspacePanel} from "./WorkspacePanel";
import {useDraftNavigation} from "../useDraftNavigation";
import {evaluationOwnerKey} from "./advanced-evaluation-api";
/** New experiment's typed Refiner target uses the actual advanced engine. It
 * never manufactures an ordinary model policy or starts on target selection. */
export function AdvancedRefinerExperimentSetup({api,target,onClose,onOpenRun}:{api:WorkspaceApi;target:AdvancedExperimentTarget;onClose:()=>void;onOpenRun?: (id:string)=>void}){
  const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),guard=useDraftNavigation({name:"Refiner experiment",dirty,busy,onLeave:onClose});
  return <><WorkspacePanel label="New experiment / Refiner" action="advanced-refiner" onRequestClose={()=>void guard.requestLeave(onClose)}>
    <p>Target: improvement system. Review quality and downstream adaptation retain their own exact source, evidence, holdout and budget admission.</p>
    <AdvancedEditor key={contentHash([evaluationOwnerKey(api),target])} api={api} evidence={target.evidence} onDirty={setDirty} onBusy={setBusy} onOpenRun={onOpenRun}/>
  </WorkspacePanel>{guard.dialog}</>;
}
