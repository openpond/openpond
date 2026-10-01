import {contentHash} from "@openpond/harness";
import {HumanExportLocalRequestSchema,HumanLocalEvidenceExportSchema,sealHumanRecord} from "@openpond/evals/human-review";
import {LearningDomainError} from "@openpond/evals/learning";
import {assertBoundedTaskJson} from "@openpond/evals/task-schema";
import {validateTasksetPackage} from "openpond-sdk/taskset-packages";
import type {SqliteStore} from "../store/store.js";
import {localRetainedCase} from "../evaluations/local-experiment-output.js";
import {readClaudeProcessEvents} from "../evaluations/claude-process-evidence.js";
function fail(code:string):never{throw new LearningDomainError(code,409);}
/** Explicit authenticated owner export. Hosted publication retains this local
 * provenance as an attestation, never as a hosted target execution receipt. */
export async function exportLocalHumanEvidence(deps:{store:SqliteStore;actorId():Promise<string>;teamId():Promise<string>},raw:unknown){
 const request=HumanExportLocalRequestSchema.parse(raw),actorId=await deps.actorId();if(request.scope!==await deps.teamId())fail("human_local_scope_changed");
 let dataset:{id:string;revision:number;contentHash:string}|undefined,compiledGraderHash:string|undefined,sealedAt:string|undefined;
 const attempts=[];
 for(const selection of request.selections){
  // Drain the store's existing writer queue before reading its retained receipt.
  await deps.store.localExperimentTrace({teamId:request.scope,id:selection.executionId,caseId:selection.receiptId,limit:1});
  const retained=deps.store.humanReviewLocalEvidence(request.scope,selection.executionId),definition=retained.released.definition;
  if(retained.execution.ownerActorId!==actorId||definition.ownerActorId!==actorId||retained.execution.kind!=="target"||!retained.execution.completedAt||!retained.execution.cleanupComplete||definition.configuration.request.project?.id!==request.projectId)fail("human_local_publication_source_denied");
  const member=retained.cases.find(row=>row.receiptId===selection.receiptId);if(!member?.result)fail("human_local_publication_receipt_missing");
  const value=validateTasksetPackage(retained.released.package),task=value.taskset.tasks.find(task=>task.id===member.admission.taskId),grader=value.taskset.graders.find(grader=>grader.id===request.graderId);
  if(!task||grader?.kind!=="human"||!grader.form)fail("human_local_publication_grader_required");
  const release={id:value.taskset.id,revision:value.taskset.revision,contentHash:value.taskset.contentHash};if(dataset&&contentHash(dataset)!==contentHash(release)||compiledGraderHash&&compiledGraderHash!==contentHash(grader))fail("human_local_publication_pair_conflict");dataset=release;compiledGraderHash=contentHash(grader);
  sealedAt=retained.execution.completedAt;const attempt=localRetainedCase(member.result).attempt;
  let source:Record<string,unknown>[];
  if(attempt.externalProcess){const events=await readClaudeProcessEvents({store:deps.store,teamId:request.scope,executionId:selection.executionId,caseId:selection.receiptId});if(contentHash(events)!==attempt.externalProcess.traceHash)fail("human_local_publication_trace_changed");source=events.filter(event=>["external.stream","external.human_intervention","external.control_receipt"].includes(event.type)).map(event=>{const payload=event.payload as Record<string,unknown>;if(event.type==="external.stream"){const raw=payload.event as Record<string,unknown>;return{sequence:event.sequence,type:event.type,...Object.fromEntries(["type","message","result","usage","is_error"].filter(key=>raw[key]!==undefined).map(key=>[key,key==="message"?Object.fromEntries(["role","content"].filter(field=>(raw.message as Record<string,unknown>)[field]!==undefined).map(field=>[field,(raw.message as Record<string,unknown>)[field]])):raw[key]]))};}return{sequence:event.sequence,type:event.type,...Object.fromEntries(["action","text","occurredAt","state"].filter(key=>payload[key]!==undefined).map(key=>[key,payload[key]]))};});}
  else source=attempt.messages.map((message,sequence)=>{const raw=message as Record<string,unknown>;return{sequence,...Object.fromEntries(["role","content","kind","name","input","output"].filter(key=>raw[key]!==undefined).map(key=>[key,raw[key]]))};});
  const events:Record<string,unknown>[]=[];let bytes=0;for(const event of source){const size=Buffer.byteLength(JSON.stringify(event));if(events.length>=1000||bytes+size>350000)break;events.push(event);bytes+=size;}
  attempts.push({origin:{kind:"owner_attested_local" as const,ownerActorId:actorId,teamId:request.scope,executionHash:retained.execution.executionHash,configurationHash:contentHash(definition.configuration),retainedAttemptHash:attempt.contentHash,traceHash:attempt.externalProcess?.traceHash??attempt.native?.traceHash??attempt.profileNative?.traceHash??attempt.contentHash,publicationCutoffHash:contentHash(events)},executionId:retained.execution.id,receiptId:member.receiptId,taskId:task.id,targetId:definition.model.modelId,familyKey:task.clusterKey,split:task.split,input:task.input,policyVisibleContext:task.policyVisibleContext,output:attempt.output,error:attempt.error,events,coverage:{sourceEventCount:source.length,publishedEventCount:events.length,traceLimited:source.length>events.length,artifactsIncluded:false as const}});
 }
 if(await deps.actorId()!==actorId||await deps.teamId()!==request.scope)fail("human_local_scope_changed");
 const result=HumanLocalEvidenceExportSchema.parse(sealHumanRecord({schemaVersion:"openpond.humanLocalEvidenceExport.v1",actorId,scope:request.scope,projectId:request.projectId,dataset:dataset!,graderId:request.graderId,compiledGraderHash:compiledGraderHash!,attempts,sealedAt:sealedAt!}));assertBoundedTaskJson(result,900000);return result;
}
