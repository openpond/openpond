import {contentHash} from "@openpond/harness";
import {LearningDomainError} from "../learning/errors.js";
import {createHumanReviewService} from "./service.js";
import type {HumanReview,HumanExecuteRequestSchema} from "./contracts.js";
import type {HumanReviewContext} from "./repository.js";
import type {z} from "zod";
/** Reserve before I/O; recovery reads the original owner's durable admission.
 * A reservation with unknown admission never becomes a second dispatch. */
export async function dispatchAssignedHumanExecution(input:{service:ReturnType<typeof createHumanReviewService>;context:HumanReviewContext;request:z.infer<typeof HumanExecuteRequestSchema>;configuration:unknown;dispatch:(configuration:unknown,review:HumanReview)=>Promise<{id:string}>;recover:(review:HumanReview)=>Promise<{id:string}|null>;cancel:(review:HumanReview)=>Promise<void>}) {
  const {service,context,request}=input,opened=await service.get(context,request.id);
  if(opened.kind!=="execute"||opened.generation!==request.generation)throw new LearningDomainError("human_execution_assignment_stale",409);
  const retained=opened.execution;
  if(retained&&retained.boundBy!==context.actorId)throw new LearningDomainError("human_execution_executor_changed",403);
  const runOperationId=retained?.operationId??`human-run-${contentHash([context.actorId,request.id,request.operationId])}`;
  const raw=input.configuration as {request:Record<string,unknown>};
  const configuration={...raw,operationId:runOperationId,request:{...raw.request,operationId:runOperationId}},configurationHash=contentHash(configuration);
  const reserved=retained?opened:await service.command(context,{action:"reserve_execution",id:request.id,expectedRevision:request.expectedRevision,operationId:`reserve-${request.operationId}`,generation:request.generation,runOperationId,configurationHash});
  if(!reserved.execution||reserved.execution.operationId!==runOperationId||reserved.execution.configurationHash!==configurationHash)throw new LearningDomainError("human_execution_reservation_conflict",409);
  const current=await service.get(context,request.id);
  if(current.execution?.executionId){if(current.status==="cancelled")await input.cancel(current);return current;}
  let dispatched: {id:string}|null;
  if(retained) dispatched=await input.recover(current);
  else {
    if(current.generation!==reserved.generation||["accepted","rejected","cancelled"].includes(current.status))throw new LearningDomainError("human_execution_assignment_stale",409);
    try{dispatched=await input.dispatch(configuration,current);}
    catch(error){dispatched=await input.recover(await service.get(context,request.id));if(!dispatched)throw error;}
  }
  if(!dispatched)throw new LearningDomainError("human_execution_admission_recovery_pending",409,"The original execution admission is unavailable. Recover its retained owner outcome before retrying this assignment.");
  for(let attempt=0;attempt<3;attempt++) {
    const latest=await service.get(context,request.id);
    if(latest.generation!==reserved.generation||!latest.execution||latest.execution.operationId!==runOperationId)throw new LearningDomainError("human_execution_assignment_stale",409);
    let bound:HumanReview;
    try{bound=latest.execution.executionId?latest:await service.command(context,{action:"bind_execution",id:request.id,expectedRevision:latest.revision,operationId:`bind-${runOperationId}`,generation:request.generation,runOperationId,configurationHash,executionId:dispatched.id});}
    catch(error){if(error instanceof LearningDomainError&&error.code==="human_revision_conflict")continue;throw error;}
    if(bound.execution?.executionId!==dispatched.id)throw new LearningDomainError("human_execution_binding_conflict",409);
    if(bound.status==="cancelled")await input.cancel(bound);
    return bound;
  }
  throw new LearningDomainError("human_execution_binding_recovery_pending",409,"The assignment changed while retaining its execution. Retry the original operation to recover that exact run.");
}
