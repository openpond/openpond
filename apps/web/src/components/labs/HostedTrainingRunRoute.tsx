import {useMemo} from "react";
import type {ClientConnection} from "../../api";
import {LabHostedTrainingRunDetail} from "./LabHostedTrainingRunDetail";
import {createWorkspaceApi} from "./workspace/workspace-api";
export function HostedTrainingRunRoute({connection,teamId,actorId,projectId,jobId,onOpenExperiment}:{connection:ClientConnection;teamId:string;actorId:string;projectId:string|null;jobId:string;onOpenExperiment(id:string):void}) {
  const api=useMemo(()=>createWorkspaceApi(connection,{teamId,actorId,projectId,accountKey:actorId}),[connection,teamId,actorId,projectId]);
  return <LabHostedTrainingRunDetail connection={connection} teamId={teamId} actorId={actorId} jobId={jobId} retainOperation={api.operation} onOpenExperiment={onOpenExperiment}/>;
}
