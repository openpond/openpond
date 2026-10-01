import {contentHash} from "@openpond/harness";
import {LearningDomainError} from "@openpond/evals/learning";
import type {HumanReview} from "@openpond/evals/human-review";
import type {SqliteStore} from "../store/store.js";
import type {createLocalExperimentService} from "../evaluations/local-experiment-service.js";
import {readClaudeProcessEvents} from "../evaluations/claude-process-evidence.js";
export async function inspectLocalHumanAttempt(input:{store:SqliteStore;experiments:ReturnType<typeof createLocalExperimentService>;scope:string;review:HumanReview;slotIndex:number;afterId?:string}){
 const a=input.review.evidence.attempts[input.slotIndex]!;
 const inspected=await input.experiments.inspectCase({teamId:input.scope,id:a.experimentId,receiptId:a.attemptId,limit:100});
 const offset=input.afterId===undefined?0:Number(input.afterId);if(!Number.isSafeInteger(offset)||offset<0)throw new LearningDomainError("human_inspection_cursor_invalid",422);
 let events:unknown[]=inspected.case.messages;
 if(inspected.case.externalProcess){
  const receipt=inspected.case.externalProcess,trace=await readClaudeProcessEvents({store:input.store,teamId:input.scope,executionId:a.experimentId,caseId:a.attemptId});
  if(contentHash(trace)!==receipt.traceHash||trace.length!==receipt.eventCount||contentHash(trace.map(event=>String(event.sequence)))!==contentHash(receipt.runtimeEventRefs)||a.trace?.contentHash!==receipt.traceHash)throw new LearningDomainError("human_process_trace_revision_changed",409);
  events=trace;
 }
 const page:unknown[]=[];let bytes=0;for(const event of events.slice(offset,offset+100)){const size=Buffer.byteLength(JSON.stringify(event));if(page.length&&bytes+size>2097152)break;page.push(event);bytes+=size;}
 return{reviewId:input.review.id,reviewRevision:input.review.revision,evidenceHash:contentHash(input.review.evidence),slot:input.review.evidence.attempts.length===2?input.slotIndex===0?"A":"B":"Attempt",slotIndex:input.slotIndex,nextEventCursor:offset+page.length<events.length?String(offset+page.length):null,input:inspected.case.input,output:inspected.case.output,error:inspected.case.error,events:page,eventCount:events.length,evidenceLimited:inspected.case.status!=="completed"};
}
