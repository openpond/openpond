import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { WeightSpaceCancelIntentSchema, type WeightSpaceCancelIntent } from "@openpond/contracts";
import { canonicalJson, WeightSpaceExecutionMetadataSchema, ManagedModificationCancelSchema,
  parseAndVerifyWeightSpaceExecutionReceipt, type WeightSpaceExecution, type ManagedModificationCancel } from "openpond-sdk/training";
import { apiFetch } from "../../api/api-client";
import type { WorkspaceApi } from "./workspace/workspace-api";
const ACTION="training-weight-space-cancel";
type Attempt={intent:WeightSpaceCancelIntent;command:ManagedModificationCancel;operation:Awaited<ReturnType<WorkspaceApi["operation"]>>};
/** Cancellation uses the same retained device journal as Model saving. A lost
 * reply never turns recovery into a fresh cancellation at a newer revision. */
export function useCancelWeightSpace(api:WorkspaceApi,apiOrigin:string,execution:WeightSpaceExecution,onChanged:()=>void){
  const identity=canonicalJson([api.key,apiOrigin,execution.id]),live=useRef(identity);
  live.current=identity;
  useEffect(()=>{live.current=identity;return()=>{if(live.current===identity)live.current="";};},[identity]);
  const [frame,setFrame]=useState<{identity:string;busy:boolean;error:unknown;original:Attempt|null}>({identity,busy:false,error:null,original:null});
  const state=frame.identity===identity?frame:{identity,busy:false,error:null,original:null};
  const inFlight=useRef(new Set<string>());
  function fence(){if(live.current!==identity)throw new Error("Recover cancellation in its original account and editing session.");}
  function patch(value:Partial<typeof frame>){if(live.current===identity)setFrame(current=>({... (current.identity===identity?current:{identity,busy:false,error:null,original:null}),...value,identity}));}
  const pending=useQuery({queryKey:["weight-space-cancel-recovery",identity],enabled:!state.busy,retry:false,gcTime:0,
    queryFn:async({signal})=>{
      const attempts:Attempt[]=[],seen=new Set<string>();let cursor:string|undefined;
      for(let n=0;;n++){
        if(n>=100)throw new Error("The retained cancellation catalog exceeds its supported bound.");
        const page=await api.pendingOperations(ACTION,cursor,signal);
        for(const row of page.items){
          const intent=WeightSpaceCancelIntentSchema.parse(row.reviewedIntent);
          if(intent.execution.id!==execution.id)continue;
          if(intent.account.teamId!==api.teamId||intent.account.actorId!==api.actorId||intent.account.apiOrigin!==apiOrigin||intent.execution.projectId!==api.projectId)
            throw new Error("The retained cancellation belongs to another account or Project.");
          const command=ManagedModificationCancelSchema.parse(row.command??{teamId:api.teamId,id:execution.id,operationId:row.id,
            action:"cancel",expectedRevision:intent.execution.revision,planHash:intent.execution.plan.contentHash});
          attempts.push({intent,command,operation:api.recoverOperation(row)});
        }
        if(!page.nextCursor)break;
        if(seen.has(page.nextCursor))throw new Error("The cancellation catalog repeated a cursor.");
        seen.add(page.nextCursor);cursor=page.nextCursor;
      }
      return attempts.sort((a,b)=>a.operation.createdAt.localeCompare(b.operation.createdAt));
    }});
  const original=state.original??pending.data?.[0]??null;
  const terminal=["completed","cancelled","failed"].includes(execution.phase);
  async function cancel(){
    if(inFlight.current.has(identity))return;
    inFlight.current.add(identity);patch({busy:true,error:null});
    try{
      fence();let attempt=original;
      if(!attempt){
        if(!pending.isSuccess||terminal)throw new Error("Reload the current editing session and retained cancellations first.");
        const {schemaVersion:_schema,request:_request,result:_result,resultRecordedAt:_recorded,contentHash:_hash,...metadata}=execution;
        const intent=WeightSpaceCancelIntentSchema.parse({account:{teamId:api.teamId,actorId:api.actorId,apiOrigin},execution:WeightSpaceExecutionMetadataSchema.parse(metadata)});
        const operation=await api.operation(ACTION,intent);fence();
        attempt={intent,operation,command:ManagedModificationCancelSchema.parse({teamId:api.teamId,id:execution.id,operationId:operation.id,
          action:"cancel",expectedRevision:execution.revision,planHash:execution.plan.contentHash})};
      }
      patch({original:attempt});
      await attempt.operation.retainCommand(attempt.command,"dispatching");fence();
      const receipt=await parseAndVerifyWeightSpaceExecutionReceipt(await apiFetch(api.connection,`/v1/training/weight-space-sessions/${encodeURIComponent(execution.id)}/cancel`,{
        method:"POST",body:JSON.stringify({...attempt.intent.account,projectId:api.projectId,intentHash:attempt.operation.intentHash,command:attempt.command})}),attempt.command);
      fence();
      if(receipt.execution.ownerUserId!==api.actorId||receipt.execution.projectId!==api.projectId)throw new Error("Cancellation returned another account or Project.");
      await attempt.operation.acknowledge();fence();patch({original:null});await pending.refetch();fence();onChanged();
    }catch(error){patch({error});}finally{inFlight.current.delete(identity);patch({busy:false});}
  }
  return {cancel,busy:state.busy,error:state.error??pending.error,original,
    enabled:Boolean(original)||!terminal&&pending.isSuccess,reload:()=>void pending.refetch()};
}
