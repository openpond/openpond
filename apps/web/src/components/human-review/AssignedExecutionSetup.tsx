import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { HumanReviewViewSchema, type HumanReviewView } from "@openpond/evals/human-review";
import type { ModelsRoute } from "../labs/models-route";
import { EvaluationSetupProvider, useEvaluationSetup } from "../labs/workspace/EvaluationSetupState";
import { ExperimentSetupPanel } from "../labs/workspace/ExperimentSetupPanel";
import { createWorkspaceApi, type Inventory } from "../labs/workspace/workspace-api";
import { humanRequest, type HumanInboxContext } from "./api";

export function AssignedExecutionSetup(props:{context:HumanInboxContext;review:HumanReviewView;route:ModelsRoute;onNavigate:(route:ModelsRoute)=>void;onClose:()=>void}) {
  return <EvaluationSetupProvider><AssignedExecutionContent {...props}/></EvaluationSetupProvider>;
}
function AssignedExecutionContent({context,review,route,onNavigate,onClose}:Parameters<typeof AssignedExecutionSetup>[0]) {
  const setup = useEvaluationSetup();
  const evidence=review.evidence;
  const api = useMemo(()=>createWorkspaceApi(context.connection,{teamId:context.scope,actorId:context.actorId,accountKey:context.actorId,projectId:review.projectId,executionLocation:context.location}),[context.connection,context.scope,context.actorId,context.location,review.projectId]);
  const inventory = useQuery({queryKey:["assigned-execution-inventory",api.key],queryFn:({signal})=>api.request<Inventory>("inventory",{},signal)});
  useEffect(()=>{
    if(!evidence)return;
    const release = evidence.dataset;
    setup.open(null,release,route);
    setup.setDraft(current=>current?{...current,name:review.title}:current);
    setup.selectAll(release,false);
    for (const id of evidence.taskIds ?? []) setup.toggle(release,id,true);
  },[review.id,review.generation]);
  if (!evidence) return <p role="status">Open or claim this assignment to access its exact tasks.</p>;
  if (inventory.error) return <p role="alert">{inventory.error.message}</p>;
  if (!setup.draft || !inventory.data) return <p role="status">Reading the assigned Dataset and authorized targets…</p>;
  return <ExperimentSetupPanel api={api} inventory={inventory.data} route={route} navigate={onNavigate}
    dispatch={async(configuration,operationId)=>{
      const result = HumanReviewViewSchema.parse(await humanRequest(context,{endpoint:"execute",scope:context.scope,id:review.id,expectedRevision:review.revision,generation:review.generation,operationId,configuration}));
      if (!result.execution?.executionId) throw new Error("The assigned execution is still being admitted. Retry this same setup to read its retained outcome.");
      window.dispatchEvent(new Event("human-review-changed"));
      return {id:result.execution.executionId};
    }}
    onSaved={()=>onClose()} onClose={onClose}/>;
}
