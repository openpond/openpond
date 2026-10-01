import {useMemo} from "react";
import type {ClientConnection} from "../../api";
import {HostedTrainingPolicyDetail} from "./HostedTrainingPolicyDetail";
import {createWorkspaceApi} from "./workspace/workspace-api";
export function HostedTrainingPolicyRoute({connection,teamId,actorId,projectId,policyId,onOpenJob,onOpenExperiment}:{connection:ClientConnection;teamId:string;actorId:string;projectId:string|null;policyId:string;onOpenJob(id:string):void;onOpenExperiment(id:string):void}) {
  const api=useMemo(()=>createWorkspaceApi(connection,{teamId,actorId,projectId,accountKey:actorId}),[connection,teamId,actorId,projectId]);
  return <HostedTrainingPolicyDetail connection={connection} teamId={teamId} actorId={actorId} policyId={policyId} retainOperation={api.operation} onOpenJob={onOpenJob} onOpenExperiment={onOpenExperiment}/>;
}
