import path from "node:path";
import {openStorageDatabase} from "@openpond/persistence";
import {contentHash} from "@openpond/harness";
import {normalizeModelUsageTokens} from "../runtime/model-usage-normalization.js";
import {hostedUsageCostUsd} from "../training/hosted-token-pricing.js";
import {prepareLocalExperimentModel} from "../evaluations/local-experiment-model.js";
import {streamOpenPondHostedChatTurn} from "@openpond/runtime";
import type {Session,Turn} from "@openpond/contracts";
import type {LocalExperimentImprovementService} from "./experiment-improvement-service.js";
import type {HarnessStateStore} from "../store/harness-state-store.js";

/** Durable inference reservations are separate from source mutations. A lost
 * provider outcome seals unknown accounting and prohibits another paid call. */
export function createExperimentImprovementBudget(deps:{store:HarnessStateStore;storeDir:string;improvements:LocalExperimentImprovementService;
  actorId():Promise<string>;teamId():Promise<string>;stream?:typeof streamOpenPondHostedChatTurn}) {
  const db=openStorageDatabase(path.join(deps.storeDir,"library","harnesses","experiment-improvement-budget.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS improvement_calls(candidate_id TEXT NOT NULL,request_id TEXT NOT NULL,actor_id TEXT NOT NULL,team_id TEXT NOT NULL,request_hash TEXT NOT NULL,source_hash TEXT NOT NULL,configuration_hash TEXT NOT NULL,maximum_usd REAL NOT NULL,status TEXT NOT NULL,cost_usd REAL,usage TEXT,created_at TEXT NOT NULL,completed_at TEXT,PRIMARY KEY(candidate_id,request_id));
    CREATE TABLE IF NOT EXISTS improvement_call_receipts(candidate_id TEXT NOT NULL,request_id TEXT NOT NULL,content_hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(candidate_id,request_id));`);
  async function authority(session:Session,turn:Turn){
    const actual=await deps.store.getTurn(turn.id),selected=await deps.store.getSession(session.id),marker=actual?.metadata.refinementCandidate;
    if(!actual||!selected||actual.sessionId!==session.id||actual.status!=="in_progress"||actual.metadata.source!=="experiment-improvement"||!marker||typeof marker!=="object"||!("candidateId" in marker)||typeof marker.candidateId!=="string")throw new Error("Candidate inference has no actual admitted Work turn.");
    const actor={actorId:await deps.actorId(),teamId:await deps.teamId()},state=await deps.improvements.read(actor,marker.candidateId);
    if(state.status!=="authoring"||!state.work||state.work.sessionId!==session.id||state.work.turnId!==turn.id||contentHash(marker)!==contentHash({candidateId:state.id,authoringRevision:state.work.revision,...actor})||contentHash(selected.currentProfile)!==contentHash(state.profileRef))throw new Error("Candidate inference source or owner changed.");
    const partition=await deps.improvements.partition(actor,state.id);return{actor,state,partition,turn:actual};
  }
  const stream=deps.stream??streamOpenPondHostedChatTurn;
  return {
    async resolveSessionModelStream(session:Session,turn:Turn):Promise<typeof streamOpenPondHostedChatTurn|null>{
      const actual=await deps.store.getTurn(turn.id);if(actual?.metadata.source!=="experiment-improvement"&&actual?.metadata.refinementCandidate===undefined)return null;
      const initial=await authority(session,turn),model=initial.turn.modelRef??session.modelRef;
      if(session.provider!=="openpond"||model?.providerId!=="openpond"||!model.modelId)throw new Error("Candidate Work requires an explicitly selected OpenPond hosted-tool model.");
      const admission=await prepareLocalExperimentModel({kind:"hosted_chat",modelId:model.modelId,maxOutputTokens:4096,temperature:0,topP:1});
      return async function*(request){
        const current=await authority(session,turn),id=current.state.id,requestId=request.requestId;
        if(!requestId||request.model!==admission.model.modelId)throw new Error("Candidate inference changed its admitted request/model identity.");
        const remaining=current.state.limits.maximumDurationMs-(Date.now()-Date.parse(current.state.work!.startedAt));if(remaining<=0)throw new Error("Candidate Work reached its admitted duration limit.");
        if(request.maxTokens!==undefined&&request.maxTokens>admission.model.maxOutputTokens)throw new Error("Candidate inference exceeds its admitted output token ceiling.");
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error("Candidate authoring duration limit reached.")),remaining);
        const signal=request.signal?AbortSignal.any([request.signal,controller.signal]):controller.signal;
        const bounded={...request,maxTokens:Math.min(request.maxTokens??admission.model.maxOutputTokens,admission.model.maxOutputTokens),temperature:admission.model.temperature,topP:admission.model.topP,signal};
        const {signal:_signal,...body}=bounded,requestHash=contentHash(body),sourceHash=contentHash({state:current.state.contentHash,partition:current.partition.contentHash});
        let reservedByThisCall=false,dispatched=false,finished=false,usage:import("@openpond/cloud").HostedChatUsage|null=null;
        try {
          db.exec("BEGIN IMMEDIATE");
          try {
            if(db.prepare("SELECT 1 FROM improvement_calls WHERE candidate_id=? AND request_id=?").get(id,requestId))throw new Error("This candidate request already has an immutable dispatch receipt; never redispatch an uncertain call.");
            const calls=db.prepare("SELECT status,cost_usd,maximum_usd FROM improvement_calls WHERE candidate_id=? AND actor_id=? AND team_id=?").all(id,current.actor.actorId,current.actor.teamId);
            if(calls.some(call=>!["settled","not_dispatched"].includes(String(call.status))))throw new Error("Reconcile the pending or unknown candidate inference charge before another paid call.");
            const spent=calls.reduce((total,call)=>total+(call.status==="not_dispatched"?0:Number(call.cost_usd)),0);
            if(calls.length+current.state.authoringSteps>=current.state.limits.maximumAuthoringSteps||spent+admission.maximumChargeUsd>current.state.limits.maximumCostUsd)throw new Error("Candidate authoring reached its admitted call or cost ceiling.");
            db.prepare("INSERT INTO improvement_calls(candidate_id,request_id,actor_id,team_id,request_hash,source_hash,configuration_hash,maximum_usd,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id,requestId,current.actor.actorId,current.actor.teamId,requestHash,sourceHash,admission.model.configurationHash,admission.maximumChargeUsd,"reserved",new Date().toISOString());
            db.exec("COMMIT");reservedByThisCall=true;
          }catch(error){db.exec("ROLLBACK");throw error;}
          await authority(session,turn);signal.throwIfAborted();
          db.prepare("UPDATE improvement_calls SET status='dispatched' WHERE candidate_id=? AND request_id=? AND status='reserved'").run(id,requestId);dispatched=true;
          for await(const delta of stream(bounded)){
            await authority(session,turn);signal.throwIfAborted();if(delta.type==="usage")usage=delta.usage;if(delta.type==="finish")finished=true;yield delta;
          }
        }finally{
          clearTimeout(timer);controller.abort();
          const row=db.prepare("SELECT * FROM improvement_calls WHERE candidate_id=? AND request_id=?").get(id,requestId);
          if(reservedByThisCall&&row&&row.status!=="settled"&&row.status!=="unknown"&&row.status!=="not_dispatched"){
            const tokens=normalizeModelUsageTokens(usage),costUsd=dispatched&&finished&&tokens.promptTokens!==null&&tokens.completionTokens!==null&&admission.pricing?hostedUsageCostUsd(usage,admission.pricing):null;
            const status=!dispatched?"not_dispatched":costUsd===null?"unknown":"settled",completedAt=new Date().toISOString();
            const receipt={schemaVersion:"openpond.improvementModelCall.v1",candidateId:id,requestId,actorId:current.actor.actorId,teamId:current.actor.teamId,requestHash,sourceHash,configurationHash:admission.model.configurationHash,maximumUsd:admission.maximumChargeUsd,status,costUsd,usage:usage===null?null:tokens,completedAt},hash=contentHash(receipt);
            db.exec("BEGIN IMMEDIATE");try{db.prepare("UPDATE improvement_calls SET status=?,cost_usd=?,usage=?,completed_at=? WHERE candidate_id=? AND request_id=?").run(status,costUsd,JSON.stringify(receipt.usage),completedAt,id,requestId);db.prepare("INSERT INTO improvement_call_receipts(candidate_id,request_id,content_hash,payload) VALUES(?,?,?,?)").run(id,requestId,hash,JSON.stringify({...receipt,contentHash:hash}));db.exec("COMMIT");}catch(error){db.exec("ROLLBACK");throw error;}
          }
        }
      };
    },
    close:()=>db.close()
  };
}
