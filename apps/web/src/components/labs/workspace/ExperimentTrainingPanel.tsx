import {useRef,useState} from "react";
import type {TrainingHandoffOrigin} from "openpond-sdk/post-training";
import type {WorkspaceApi} from "./workspace-api";
import type {ModelsRoute} from "../models-route";
import {modelsLocation} from "../models-route";
import {TrainFromExperimentControl} from "../TrainFromExperimentControl";
import {HostedTrainingSetup} from "../HostedTrainingSetup";
import {WorkspacePanel} from "./WorkspacePanel";
import type {DraftEditorHandle} from "../useDraftNavigation";

export function ExperimentTrainingPanel({api,executionId,passId=null,navigate}:{api:WorkspaceApi;executionId:string;passId?:string|null;navigate(route:ModelsRoute):void}) {
  const [selected,setSelected]=useState<{key:string;origin:TrainingHandoffOrigin}|null>(null);
  const editorRef=useRef<DraftEditorHandle>(null);
  const key=JSON.stringify([api.key,executionId,passId]);
  const origin=selected?.key===key?selected.origin:null;
  if(!api.actorId)return null;
  return <>
    <TrainFromExperimentControl connection={api.connection} teamId={api.teamId} actorId={api.actorId} executionId={executionId} passId={passId} onOpen={value=>setSelected({key,origin:value})}/>
    {origin?<WorkspacePanel action="training" label="Training" onRequestClose={()=>editorRef.current?.requestClose()}>
      <HostedTrainingSetup connection={api.connection} teamId={api.teamId} actorId={api.actorId} projectId={origin.projectId} initialOrigin={origin}
        retainOperation={api.operation} editorRef={editorRef}
        onClose={()=>setSelected(null)} onOpenJob={id=>navigate(modelsLocation("runs",null,{resourceId:`hosted-run:${id}`,projectId:origin.projectId}))}
        onOpenPolicy={id=>navigate(modelsLocation("runs",null,{resourceId:`hosted-policy:${id}`,projectId:origin.projectId}))}/>
    </WorkspacePanel>:null}
  </>;
}
