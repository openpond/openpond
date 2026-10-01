import {contentHash} from "@openpond/harness";
import {ClaudeProcessEvidenceSchema,ClaudeCodeRuntimeSchema} from "openpond-sdk/experiments";
import {z} from "zod";
import type {SqliteLocalExperimentStore} from "../store/store-local-experiments.js";
import {LocalExperimentError} from "./local-experiment-contract.js";
import {localRetainedAttempt} from "./local-experiment-output.js";
const Start=z.object({provider:z.literal("claude-code"),sessionId:z.uuid(),requestId:z.string(),modelId:z.string(),runtime:ClaudeCodeRuntimeSchema,sourceHash:z.string(),startedAt:z.iso.datetime()});
const Cleanup=z.object({sessionId:z.uuid(),confirmed:z.literal(true),completedAt:z.iso.datetime()});
export async function readClaudeProcessEvents(input:{store:Pick<SqliteLocalExperimentStore,"localExperimentTrace">;teamId:string;executionId:string;caseId:string}){
 const events: {sequence:number;type:string;payload:unknown}[]=[];let afterSequence:number|undefined;
 do{const page=await input.store.localExperimentTrace({teamId:input.teamId,id:input.executionId,caseId:input.caseId,limit:500,...(afterSequence?{afterSequence}:{})});events.push(...page.items.filter(event=>event.type.startsWith("external.")));if(events.length>20000)throw new LocalExperimentError("claude_trace_limit","Retained process trace exceeds its exact population bound.",422);afterSequence=page.nextCursor??undefined;}while(afterSequence);
 return events;
}
export async function retainClaudeProcessEvidence(input:{store:Pick<SqliteLocalExperimentStore,"localExperimentTrace">;teamId:string;executionId:string;caseId:string;attempt:unknown}){
 const attempt=localRetainedAttempt(input.attempt),events=await readClaudeProcessEvents(input);
 const first=events.find(event=>event.type==="external.start"),last=[...events].reverse().find(event=>event.type==="external.cleanup");
 if(!first||!last)throw new LocalExperimentError("claude_cleanup_unconfirmed","The process owner has not retained its actual session/cleanup receipt.",422);
 const start=Start.parse(first.payload),cleanup=Cleanup.parse(last.payload);
 if(start.sessionId!==cleanup.sessionId||events.some(event=>{const payload=z.record(z.string(),z.unknown()).parse(event.payload);return payload.sessionId!==undefined&&payload.sessionId!==start.sessionId;}))throw new LocalExperimentError("claude_trace_identity_conflict","Retained events changed the admitted process session.",422);
 const externalProcess=ClaudeProcessEvidenceSchema.parse({provider:start.provider,sessionId:start.sessionId,requestId:start.requestId,modelId:start.modelId,runtime:start.runtime,sourceHash:start.sourceHash,outputHash:contentHash(attempt.output),traceHash:contentHash(events),runtimeEventRefs:events.map(event=>String(event.sequence)),eventCount:events.length,startedAt:start.startedAt,completedAt:cleanup.completedAt,cleanupComplete:true});
 const {contentHash:prior,...body}=attempt;void prior;const content={...body,externalProcess};return {...content,contentHash:contentHash(content)};
}
