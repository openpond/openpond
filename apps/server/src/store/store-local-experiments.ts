import { contentHash } from "@openpond/harness";
import { validateTasksetPackage } from "openpond-sdk/taskset-packages";
import { JudgeCallReservationSchema, type JudgeBudgetState, type JudgeCallReservation } from "@openpond/evals/learning";
import { SqliteChatWorkflowStore } from "./store-chat-workflows.js";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { LOCAL_EXPERIMENT_SCHEMA_SQL } from "./store-local-experiment-schema.js";
import { EVALUATION_OPERATION_SCHEMA_SQL,prepareEvaluationOperation,acknowledgeEvaluationOperation,type EvaluationOperationScope } from "./store-evaluation-operation-intents.js";
import { claimLocalExperimentOwner,requireLocalRuntimeOwner,renewLocalExperimentOwner } from "./local-experiment-owner.js";
import { localCases, localDefinition, localExecution, localOperation, refreshLocalExecution, writeLocalDefinition } from "./local-experiment-records.js";
import {localFlatRecord,localFlatSnapshot,writeLocalFlatSnapshot} from "./local-experiment-flat-records.js";
import {LocalExperimentConfigurationSnapshotSchema,type LocalExperimentConfigurationSnapshot} from "@openpond/contracts";
import { LocalExperimentError, LocalExperimentDefinitionSchema, type LocalExperimentDefinition,
  LocalExperimentExecutionSchema, type LocalExperimentExecution, type LocalExperimentAdmission, type LocalCaseStatus } from "../evaluations/local-experiment-contract.js";

/** All admissions, operation receipts and reservations share the existing WAL
 * connection and write queue. A transaction never awaits a provider call. */
export class SqliteLocalExperimentStore extends SqliteChatWorkflowStore {
  private localTablesReady=false;
  private async localWrite<T>(apply:(db:OpenPondSqliteConnection)=>T):Promise<T> {
    await this.ready;
    const write=this.writeQueue.then(()=> {
      const db=this.database;
      if(!this.localTablesReady){db.exec(LOCAL_EXPERIMENT_SCHEMA_SQL);db.exec(EVALUATION_OPERATION_SCHEMA_SQL);this.localTablesReady=true;}
      db.exec("BEGIN IMMEDIATE");
      try {const result=apply(db);db.exec("COMMIT");return result;}
      catch(error){db.exec("ROLLBACK");throw error;}
    });
    this.writeQueue=write.then(()=>{},()=>{});return write;
  }
  async prepareEvaluationOperation(input:EvaluationOperationScope) {return this.localWrite(db=>prepareEvaluationOperation(db,input));}
  async acknowledgeEvaluationOperation(input:EvaluationOperationScope&{id:string}) {return this.localWrite(db=>acknowledgeEvaluationOperation(db,input));}
  async claimLocalExperimentOwner(ownerId:string,pid=process.pid) {return this.localWrite(db=>claimLocalExperimentOwner(db,ownerId,pid));}
  async renewLocalExperimentOwner(ownerId:string) {return this.localWrite(db=>renewLocalExperimentOwner(db,ownerId));}
  async releaseLocalExperimentOwner(ownerId:string) {return this.localWrite(db=>db.run("DELETE FROM local_experiment_owner WHERE singleton=1 AND owner_id=?",[ownerId]));}
  async saveLocalExperiment(input:{operationId:string;intentHash:string;expectedRevision:number;definition:LocalExperimentDefinition;package:unknown}) {
    const definition=LocalExperimentDefinitionSchema.parse(input.definition);
    return this.localWrite(db=>localOperation(db,definition.teamId,input.operationId,"save",input.intentHash,()=> {
      const current=db.get<{revision:number}>("SELECT MAX(revision) AS revision FROM local_experiment_definitions WHERE team_id=? AND id=?",[definition.teamId,definition.id]);
      if(current?.revision&&localDefinition(db,definition.teamId,definition.id).definition.ownerActorId!==definition.ownerActorId)
        throw new LocalExperimentError("local_resource_denied","This local resource belongs to another account.",404);
      if((current?.revision??0)!==input.expectedRevision || definition.revision!==input.expectedRevision+1)
        throw new LocalExperimentError("local_definition_revision_conflict","The Experiment changed. Reload its saved revision before editing.");
      writeLocalDefinition(db,definition,input.package);return definition;
    }));
  }
  async readLocalExperiment(teamId:string,id:string,revision?:number) {return this.localWrite(db=>localDefinition(db,teamId,id,revision));}
  async recoverLocalExperimentOperation(teamId:string,operationId:string,kind:string,intentHash:string):Promise<unknown|null> {
    return this.localWrite(db=> {
      const row=db.get<{kind:string;intent_hash:string;receipt:string}>("SELECT kind,intent_hash,receipt FROM local_experiment_operations WHERE team_id=? AND operation_id=?",[teamId,operationId]);
      if(!row)return null;
      if(row.kind!==kind||row.intent_hash!==intentHash)throw new LocalExperimentError("local_operation_conflict","This operation already owns different immutable inputs.");
      return JSON.parse(row.receipt) as unknown;
    });
  }
  async listLocalExperiments(input:{teamId:string;ownerActorId:string;projectId?:string;afterId?:string;limit:number}) {
    return this.localWrite(db=> {
      const rows=db.all<{payload:string}>(`SELECT d.payload FROM local_experiment_definitions d WHERE d.team_id=? AND json_extract(d.payload,'$.ownerActorId')=?
        AND d.revision=(SELECT MAX(revision) FROM local_experiment_definitions v WHERE v.team_id=d.team_id AND v.id=d.id)
        ${input.projectId?"AND d.project_id=?":""} ${input.afterId?"AND d.id>?":""} ORDER BY d.id LIMIT ?`,
        [input.teamId,input.ownerActorId,...(input.projectId?[input.projectId]:[]),...(input.afterId?[input.afterId]:[]),input.limit+1]);
      const items=rows.slice(0,input.limit).map(row=>LocalExperimentDefinitionSchema.parse(JSON.parse(row.payload)));
      return {items,nextCursor:rows.length>input.limit?items.at(-1)!.id:null};
    });
  }
  async listLocalExecutionHistory(input:{teamId:string;ownerActorId:string;projectId?:string;afterId?:string;limit:number}) {
    return this.localWrite(db=> {
      const rows=db.all<{execution:string;definition:string;id:string}>(`SELECT e.payload AS execution,d.payload AS definition,e.id FROM local_experiment_executions e
        JOIN local_experiment_definitions d ON d.team_id=e.team_id AND d.id=e.definition_id AND d.revision=e.definition_revision
        WHERE e.team_id=? AND json_extract(e.payload,'$.ownerActorId')=?
        ${input.projectId?"AND d.project_id=?":""} ${input.afterId?"AND e.id>?":""} ORDER BY e.id LIMIT ?`,
        [input.teamId,input.ownerActorId,...(input.projectId?[input.projectId]:[]),...(input.afterId?[input.afterId]:[]),input.limit+1]);
      const items=rows.slice(0,input.limit).map(row=>({execution:LocalExperimentExecutionSchema.parse(JSON.parse(row.execution)),definition:LocalExperimentDefinitionSchema.parse(JSON.parse(row.definition))}));
      return {items,nextCursor:rows.length>input.limit?items.at(-1)!.execution.id:null};
    });
  }
  async startLocalExperiment(input:{operationId:string;intentHash:string;ownerId:string;execution:LocalExperimentExecution;admissions:LocalExperimentAdmission[]}) {
    return this.localWrite(db=>localOperation(db,input.execution.teamId,input.operationId,"start",input.intentHash,()=> {
      requireLocalRuntimeOwner(db,input.ownerId);
      const value=LocalExperimentExecutionSchema.parse(input.execution),ref=value.definition;
      const exact=localDefinition(db,value.teamId,ref.id,ref.revision).definition;
      if(exact.ownerActorId!==value.ownerActorId)throw new LocalExperimentError("local_resource_denied","This local resource belongs to another account.",404);
      if(exact.contentHash!==ref.contentHash || exact.packageHash!==value.packageHash || exact.configuration.maximumCostUsd!==value.maximumCostUsd)
        throw new LocalExperimentError("local_definition_pin_conflict","Execution requires its exact retained definition and package.");
      if(!input.admissions.length || input.admissions.length!==value.counts.pending || new Set(input.admissions.map(a=>a.receiptId)).size!==input.admissions.length)
        throw new LocalExperimentError("local_population_conflict","Execution admissions must cover the exact unique population.");
      db.run("INSERT INTO local_experiment_executions(team_id,id,definition_id,definition_revision,owner_id,payload) VALUES(?,?,?,?,?,?)",[value.teamId,value.id,ref.id,ref.revision,input.ownerId,JSON.stringify(value)]);
      input.admissions.forEach((admission,ordinal)=>db.run("INSERT INTO local_experiment_cases(team_id,execution_id,receipt_id,ordinal,status,admission) VALUES(?,?,?,?,?,?)",[value.teamId,value.id,admission.receiptId,ordinal,"pending",JSON.stringify(admission)]));
      return value;
    }));
  }
  async admitLocalExperimentRun(input:{intentHash:string;ownerId:string;definition:LocalExperimentDefinition;
    snapshot:LocalExperimentConfigurationSnapshot;package:unknown;execution:LocalExperimentExecution;admissions:LocalExperimentAdmission[]}) {
    return this.localWrite(db=>localOperation(db,input.execution.teamId,input.execution.operationId,"run",input.intentHash,()=> {
      requireLocalRuntimeOwner(db,input.ownerId);
      const value=LocalExperimentExecutionSchema.parse(input.execution),definition=LocalExperimentDefinitionSchema.parse(input.definition);
      const snapshot=LocalExperimentConfigurationSnapshotSchema.parse(input.snapshot),ref=value.definition,packageValue=validateTasksetPackage(input.package);
      const {contentHash:definitionHash,...definitionContent}=definition;
      const {sourceExperimentId,...configuration}=snapshot.configuration;void sourceExperimentId;
      if(value.kind!=="target"||definition.ownerActorId!==value.ownerActorId||definition.teamId!==value.teamId
        ||contentHash(definitionContent)!==definitionHash||contentHash({...configuration,expectedRevision:0})!==contentHash(definition.configuration)
        ||definition.id!==ref.id||definition.revision!==ref.revision||definition.contentHash!==ref.contentHash
        ||packageValue.contentHash!==snapshot.packageHash||snapshot.packageHash!==value.packageHash||snapshot.configuration.maximumCostUsd!==value.maximumCostUsd
        ||snapshot.configuration.operationId!==value.operationId||snapshot.configuration.request.teamId!==value.teamId
        ||contentHash(snapshot.model)!==contentHash(definition.model)||contentHash(snapshot.graders)!==contentHash(definition.graders))
        throw new LocalExperimentError("local_configuration_pin_conflict","The local run requires its exact sealed configuration and owner.");
      if(!input.admissions.length||input.admissions.length!==value.counts.pending||new Set(input.admissions.map(item=>item.receiptId)).size!==input.admissions.length)
        throw new LocalExperimentError("local_population_conflict","The run admissions must cover the exact unique population.");
      writeLocalDefinition(db,definition,input.package);
      db.run("INSERT INTO local_experiment_executions(team_id,id,definition_id,definition_revision,owner_id,payload) VALUES(?,?,?,?,?,?)",
        [value.teamId,value.id,ref.id,ref.revision,input.ownerId,JSON.stringify(value)]);
      writeLocalFlatSnapshot(db,value,snapshot,input.package);
      input.admissions.forEach((admission,ordinal)=>db.run("INSERT INTO local_experiment_cases(team_id,execution_id,receipt_id,ordinal,status,admission) VALUES(?,?,?,?,?,?)",
        [value.teamId,value.id,admission.receiptId,ordinal,"pending",JSON.stringify(admission)]));
      return localFlatRecord(db,value.teamId,value.id);
    }));
  }
  async readLocalExperimentRecord(teamId:string,id:string) {return this.localWrite(db=>localFlatRecord(db,teamId,id));}
  async readLocalExperimentSnapshot(teamId:string,id:string) {return this.localWrite(db=>localFlatSnapshot(db,localExecution(db,teamId,id)));}
  async listLocalExperimentRecords(input:{teamId:string;ownerActorId:string;projectId?:string;status?:LocalExperimentExecution["status"];datasetHash?:string;search?:string;afterId?:string;limit:number}) {
    return this.localWrite(db=> {
      const rows=db.all<{id:string}>(`SELECT e.id FROM local_experiment_executions e
        LEFT JOIN local_experiment_configurations c ON c.team_id=e.team_id AND c.execution_id=e.id
        JOIN local_experiment_definitions d ON d.team_id=e.team_id AND d.id=e.definition_id AND d.revision=e.definition_revision
        WHERE e.team_id=? AND json_extract(e.payload,'$.ownerActorId')=? AND json_extract(e.payload,'$.kind')='target'
        ${input.projectId?"AND COALESCE(json_extract(c.payload,'$.configuration.request.project.id'),json_extract(d.payload,'$.configuration.request.project.id'))=?":""}
        ${input.status?"AND json_extract(e.payload,'$.status')=?":""}
        ${input.datasetHash?"AND COALESCE(json_extract(c.payload,'$.configuration.request.taskset.contentHash'),json_extract(d.payload,'$.configuration.request.taskset.contentHash'))=?":""}
        ${input.search?"AND instr(lower(COALESCE(json_extract(c.payload,'$.configuration.request.name'),json_extract(d.payload,'$.configuration.request.name'))),lower(?))>0":""}
        ${input.afterId?"AND e.id>?":""} ORDER BY e.id LIMIT ?`,[input.teamId,input.ownerActorId,
        ...(input.projectId?[input.projectId]:[]),...(input.status?[input.status]:[]),...(input.datasetHash?[input.datasetHash]:[]),...(input.search?[input.search]:[]),...(input.afterId?[input.afterId]:[]),input.limit+1]);
      const items=rows.slice(0,input.limit).map(row=>localFlatRecord(db,input.teamId,row.id));
      return {items,nextCursor:rows.length>input.limit?items.at(-1)!.id:null};
    });
  }
  async readLocalExecution(teamId:string,id:string) {return this.localWrite(db=>({execution:localExecution(db,teamId,id),cases:localCases(db,teamId,id)}));}
  async readLocalExecutionCharges(teamId:string,id:string) {
    return this.localWrite(db=> {
      localExecution(db,teamId,id);
      return db.all<{request_id:string;case_id:string;status:string;cost_usd:number|null;usage:string|null}>(
        "SELECT request_id,case_id,status,cost_usd,usage FROM local_experiment_charges WHERE team_id=? AND execution_id=? ORDER BY request_id",[teamId,id])
        .map(row=>({requestId:row.request_id,caseId:row.case_id,status:row.status,costUsd:row.cost_usd,
          usage:row.usage?JSON.parse(row.usage) as unknown:null}));
    });
  }
  async appendLocalExperimentEvent(input:{teamId:string;id:string;caseId:string;ownerId:string;type:string;payload:unknown}) {
    return this.localWrite(db=> {
      this.requireLocalOwner(db,input.teamId,input.id,input.ownerId);
      const json=JSON.stringify(input.payload),bytes=Buffer.byteLength(json);
      const budget=db.get<{event_count:number;byte_count:number}>("SELECT event_count,byte_count FROM local_experiment_trace_budgets WHERE team_id=? AND execution_id=?",[input.teamId,input.id]);
      if(bytes>2097152 || (budget?.event_count??0)>=20000 || (budget?.byte_count??0)+bytes>67108864)
        throw new LocalExperimentError("local_trace_limit_exceeded","The execution exceeded its bounded retained trace budget.",422);
      const member=db.get("SELECT receipt_id FROM local_experiment_cases WHERE team_id=? AND execution_id=? AND receipt_id=?",[input.teamId,input.id,input.caseId]);
      if(!member)throw new LocalExperimentError("local_trace_case_conflict","Trace evidence must belong to an admitted case.");
      db.run("INSERT INTO local_experiment_events(team_id,execution_id,case_id,type,payload) VALUES(?,?,?,?,?)",[input.teamId,input.id,input.caseId,input.type,json]);
      db.run("INSERT INTO local_experiment_trace_budgets(team_id,execution_id,event_count,byte_count) VALUES(?,?,1,?) ON CONFLICT(team_id,execution_id) DO UPDATE SET event_count=event_count+1,byte_count=byte_count+excluded.byte_count",[input.teamId,input.id,bytes]);
    });
  }
  async localExperimentTrace(input:{teamId:string;id:string;caseId:string;afterSequence?:number;limit:number}) {
    return this.localWrite(db=> {
      localExecution(db,input.teamId,input.id);
      const member=db.get("SELECT receipt_id FROM local_experiment_cases WHERE team_id=? AND execution_id=? AND receipt_id=?",[input.teamId,input.id,input.caseId]);
      if(!member)throw new LocalExperimentError("local_case_not_found","This retained case does not belong to the execution.",404);
      const rows=db.all<{sequence:number;type:string;payload:string}>("SELECT sequence,type,payload FROM local_experiment_events WHERE team_id=? AND execution_id=? AND case_id=? AND sequence>? ORDER BY sequence LIMIT ?",[input.teamId,input.id,input.caseId,input.afterSequence??0,input.limit+1]);
      const items=rows.slice(0,input.limit).map(row=>({sequence:row.sequence,type:row.type,payload:JSON.parse(row.payload) as unknown}));
      return {items,nextCursor:rows.length>input.limit?items.at(-1)!.sequence:null};
    });
  }
  async startLocalScoringPass(input:{operationId:string;intentHash:string;ownerId:string;execution:LocalExperimentExecution;admissions:LocalExperimentAdmission[];package:unknown;graders:LocalExperimentDefinition["graders"]}) {
    return this.localWrite(db=>localOperation(db,input.execution.teamId,input.operationId,"score",input.intentHash,()=> {
      requireLocalRuntimeOwner(db,input.ownerId);
      const value=LocalExperimentExecutionSchema.parse(input.execution),sourceRef=value.sourceExecution;
      if(value.kind!=="scoring" || !sourceRef)throw new LocalExperimentError("local_scoring_source_missing","A scoring pass requires an exact original execution.");
      const source=localExecution(db,value.teamId,sourceRef.id);
      if(source.ownerActorId!==value.ownerActorId)throw new LocalExperimentError("local_resource_denied","This local resource belongs to another account.",404);
      if(source.executionHash!==sourceRef.executionHash || source.kind!=="target" || !source.completedAt || !source.cleanupComplete)
        throw new LocalExperimentError("local_scoring_source_unavailable","Retained grading requires a terminal original execution with confirmed cleanup.");
      if(value.packageHash!==source.packageHash || contentHash(value.definition)!==contentHash(source.definition))throw new LocalExperimentError("local_scoring_pin_conflict","The scoring pass changed original execution pins.");
      const originals=localCases(db,value.teamId,source.id);
      if(contentHash(input.admissions)!==contentHash(originals.map(row=>row.admission)))throw new LocalExperimentError("local_scoring_population_conflict","A scoring pass must cover the complete retained original population.");
      db.run("INSERT INTO local_experiment_executions(team_id,id,definition_id,definition_revision,owner_id,payload) VALUES(?,?,?,?,?,?)",[value.teamId,value.id,value.definition.id,value.definition.revision,input.ownerId,JSON.stringify(value)]);
      db.run("INSERT INTO local_experiment_scoring_selections(team_id,execution_id,source_execution_id,package_payload,graders) VALUES(?,?,?,?,?)",[value.teamId,value.id,source.id,JSON.stringify(input.package),JSON.stringify(input.graders)]);
      input.admissions.forEach((admission,ordinal)=>db.run("INSERT INTO local_experiment_cases(team_id,execution_id,receipt_id,ordinal,status,admission) VALUES(?,?,?,?,?,?)",[value.teamId,value.id,admission.receiptId,ordinal,"pending",JSON.stringify(admission)]));
      return value;
    }));
  }
  async readLocalScoringSelection(teamId:string,id:string) {
    return this.localWrite(db=> {
      localExecution(db,teamId,id);
      const row=db.get<{package_payload:string;graders:string;source_execution_id:string}>("SELECT package_payload,graders,source_execution_id FROM local_experiment_scoring_selections WHERE team_id=? AND execution_id=?",[teamId,id]);
      if(!row)throw new LocalExperimentError("local_scoring_not_found","This execution is not a scoring pass.",404);
      return {package:JSON.parse(row.package_payload) as unknown,graders:JSON.parse(row.graders) as LocalExperimentDefinition["graders"],sourceExecutionId:row.source_execution_id};
    });
  }
  async localJudgeBudgetTransaction<T>(input:{teamId:string;id:string;caseId:string;ownerId:string;intent:"dispatch"|"settle"},update:(state:JudgeBudgetState)=>{calls:JudgeCallReservation[];result:T}):Promise<T> {
    return this.localWrite(db=> {
      this.requireLocalOwner(db,input.teamId,input.id,input.ownerId);
      const execution=localExecution(db,input.teamId,input.id);
      if(input.intent==="dispatch") {
        this.requireLocalChargeBounds(db,input.teamId,input.id);
        const member=db.get<{status:string}>("SELECT status FROM local_experiment_cases WHERE team_id=? AND execution_id=? AND receipt_id=?",[input.teamId,input.id,input.caseId]);
        if(execution.status!=="running" || member?.status!=="running")throw new LocalExperimentError("local_grading_owner_inactive","Only an admitted running grader may reserve a judge call.");
      }
      const row=db.get<{calls:string}>("SELECT calls FROM local_experiment_judge_budgets WHERE team_id=? AND execution_id=?",[input.teamId,input.id]);
      const previous=row?JudgeCallReservationSchema.array().parse(JSON.parse(row.calls)):[];
      const other=db.get<{spent:number}>(`SELECT COALESCE(SUM(CASE WHEN status='settled' THEN cost_usd WHEN status IN ('reserved','dispatched','unknown') THEN maximum_usd ELSE 0 END),0) AS spent
        FROM local_experiment_charges WHERE team_id=? AND execution_id=? AND request_id NOT IN (SELECT json_extract(value,'$.id') FROM json_each(?))`,[input.teamId,input.id,JSON.stringify(previous)])!.spent;
      const next=update({maximumSpendUsd:Math.max(0,execution.maximumCostUsd-other),calls:previous}),calls=JudgeCallReservationSchema.array().parse(next.calls);
      for(const sealed of previous) {
        const retained=calls.find(call=>call.id===sealed.id);
        if(!retained || retained.requestHash!==sealed.requestHash || retained.reservedUsd!==sealed.reservedUsd
          || (sealed.status!=="reserved"&&contentHash(sealed)!==contentHash(retained)))throw new LocalExperimentError("local_judge_receipt_conflict","Retained judge reservations and receipts are immutable.");
      }
      db.run("INSERT INTO local_experiment_judge_budgets(team_id,execution_id,calls) VALUES(?,?,?) ON CONFLICT(team_id,execution_id) DO UPDATE SET calls=excluded.calls",[input.teamId,input.id,JSON.stringify(calls)]);
      for(const call of calls) {
        const status=call.status==="not_dispatched"?"released":call.response?.costUsd!==null&&call.response?.costUsd!==undefined?"settled":"unknown";
        db.run("INSERT INTO local_experiment_charges(team_id,execution_id,request_id,case_id,maximum_usd,cost_usd,status,usage) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(team_id,execution_id,request_id) DO UPDATE SET cost_usd=excluded.cost_usd,status=excluded.status,usage=excluded.usage",
          [input.teamId,input.id,call.id,input.caseId,call.reservedUsd,call.response?.costUsd??null,status,call.response?JSON.stringify(call.response):null]);
      }
      refreshLocalExecution(db,input.teamId,input.id);return next.result;
    });
  }
  async listLocalExecutions(teamId:string,definitionId:string,afterId:string|undefined,limit:number) {
    return this.localWrite(db=> {
      const rows=db.all<{payload:string}>(`SELECT payload FROM local_experiment_executions WHERE team_id=? AND definition_id=? AND json_extract(payload,'$.kind')='target' ${afterId?"AND id>?":""} ORDER BY id LIMIT ?`,[teamId,definitionId,...(afterId?[afterId]:[]),limit+1]);
      const items=rows.slice(0,limit).map(row=>LocalExperimentExecutionSchema.parse(JSON.parse(row.payload)));
      return {items,nextCursor:rows.length>limit?items.at(-1)!.id:null};
    });
  }
  async listLocalScoringPasses(teamId:string,sourceId:string,afterId:string|undefined,limit:number) {
    return this.localWrite(db=> {
      const rows=db.all<{payload:string}>(`SELECT e.payload FROM local_experiment_executions e JOIN local_experiment_scoring_selections s ON s.team_id=e.team_id AND s.execution_id=e.id WHERE e.team_id=? AND s.source_execution_id=? ${afterId?"AND e.id>?":""} ORDER BY e.id LIMIT ?`,[teamId,sourceId,...(afterId?[afterId]:[]),limit+1]);
      const items=rows.slice(0,limit).map(row=>LocalExperimentExecutionSchema.parse(JSON.parse(row.payload)));
      return {items,nextCursor:rows.length>limit?items.at(-1)!.id:null};
    });
  }
  async admitLocalCase(teamId:string,id:string,receiptId:string,ownerId:string) {
    return this.localWrite(db=> {
      this.requireLocalOwner(db,teamId,id,ownerId);
      const execution=localExecution(db,teamId,id);
      if(!["queued","running"].includes(execution.status))return false;
      const row=db.get<{status:string}>("SELECT status FROM local_experiment_cases WHERE team_id=? AND execution_id=? AND receipt_id=?",[teamId,id,receiptId]);
      if(!row || row.status!=="pending")return false;
      db.run("UPDATE local_experiment_cases SET status='running' WHERE team_id=? AND execution_id=? AND receipt_id=?",[teamId,id,receiptId]);
      refreshLocalExecution(db,teamId,id,{status:"running"});return true;
    });
  }
  async settleLocalCase(input:{teamId:string;id:string;receiptId:string;ownerId:string;status:Exclude<LocalCaseStatus,"pending"|"running">;result:unknown|null;error:string|null}) {
    return this.localWrite(db=> {
      this.requireLocalOwner(db,input.teamId,input.id,input.ownerId);
      const row=db.get<{status:string}>("SELECT status FROM local_experiment_cases WHERE team_id=? AND execution_id=? AND receipt_id=?",[input.teamId,input.id,input.receiptId]);
      if(row?.status!=="running")throw new LocalExperimentError("local_case_not_owned","Only the admitted case owner may seal retained output.");
      db.run("UPDATE local_experiment_cases SET status=?,result=?,error=? WHERE team_id=? AND execution_id=? AND receipt_id=?",[input.status,input.result===null?null:JSON.stringify(input.result),input.error,input.teamId,input.id,input.receiptId]);
      return refreshLocalExecution(db,input.teamId,input.id);
    });
  }
  async cancelLocalExecution(teamId:string,id:string) {
    return this.localWrite(db=> {
      const value=localExecution(db,teamId,id);
      if(!["queued","running","cancelling"].includes(value.status))return value;
      db.run("UPDATE local_experiment_cases SET status='cancelled' WHERE team_id=? AND execution_id=? AND status='pending'",[teamId,id]);
      return refreshLocalExecution(db,teamId,id,{status:"cancelling"});
    });
  }
  async finishLocalExecution(teamId:string,id:string,ownerId:string,error:string|null=null,cleanupComplete=true) {
    return this.localWrite(db=> {
      this.requireLocalOwner(db,teamId,id,ownerId);
      let value=refreshLocalExecution(db,teamId,id);
      if(value.counts.running)throw new LocalExperimentError("local_cleanup_pending","Wait for active case transport cleanup before sealing execution.");
      if(value.counts.pending)db.run("UPDATE local_experiment_cases SET status='cancelled' WHERE team_id=? AND execution_id=? AND status='pending'",[teamId,id]);
      value=refreshLocalExecution(db,teamId,id);
      return refreshLocalExecution(db,teamId,id,{status:value.status==="cancelling"&&cleanupComplete?"cancelled":error||value.counts.failed||value.counts.unknown||!cleanupComplete?"failed":"completed",completedAt:new Date().toISOString(),cleanupComplete,error});
    });
  }
  /** Recover the previous process without replaying admitted target calls. */
  async recoverLocalExperiments(ownerId:string) {
    return this.localWrite(db=> {
      requireLocalRuntimeOwner(db,ownerId);
      const rows=db.all<{team_id:string;id:string}>("SELECT team_id,id FROM local_experiment_executions WHERE owner_id<>?",[ownerId]);
      const recovered:LocalExperimentExecution[]=[];
      for(const row of rows) {
        const value=localExecution(db,row.team_id,row.id);
        if(!["queued","running","cancelling"].includes(value.status))continue;
        db.run("UPDATE local_experiment_cases SET status=CASE WHEN status='running' THEN 'unknown' ELSE 'cancelled' END,error='local_process_interrupted' WHERE team_id=? AND execution_id=? AND status IN ('pending','running')",[row.team_id,row.id]);
        db.run("UPDATE local_experiment_charges SET status='unknown' WHERE team_id=? AND execution_id=? AND status IN ('reserved','dispatched')",[row.team_id,row.id]);
        recovered.push(refreshLocalExecution(db,row.team_id,row.id,{status:"interrupted",completedAt:new Date().toISOString(),cleanupComplete:false,error:"The previous process ended. Admitted calls and uncertain charges were retained; start a new execution explicitly."}));
      }
      return recovered;
    });
  }
  async reserveLocalCharge(input:{teamId:string;id:string;caseId:string;requestId:string;ownerId:string;maximumUsd:number}) {
    return this.localWrite(db=> {
      this.requireLocalOwner(db,input.teamId,input.id,input.ownerId);
      this.requireLocalChargeBounds(db,input.teamId,input.id);
      if(!Number.isFinite(input.maximumUsd)||input.maximumUsd<=0)throw new LocalExperimentError("local_charge_bound_unknown","An enforceable positive model charge ceiling is required.",422);
      const value=refreshLocalExecution(db,input.teamId,input.id);
      if(value.status!=="running")throw new LocalExperimentError("local_execution_not_running","The execution no longer accepts model dispatch.");
      const admitted=db.get<{status:string}>("SELECT status FROM local_experiment_cases WHERE team_id=? AND execution_id=? AND receipt_id=?",[input.teamId,input.id,input.caseId]);
      if(admitted?.status!=="running")throw new LocalExperimentError("local_case_not_admitted","Model reservation requires an owned running case.");
      if(db.get("SELECT request_id FROM local_experiment_charges WHERE team_id=? AND execution_id=? AND request_id=?",[input.teamId,input.id,input.requestId]))throw new LocalExperimentError("local_dispatch_already_admitted","This target request was already admitted and cannot be replayed.");
      if(value.usage.knownCostUsd+value.usage.heldUsd+input.maximumUsd>value.maximumCostUsd+1e-12)throw new LocalExperimentError("experiment_budget_exhausted","The local ceiling cannot cover this model's maximum accepted request charge.",422);
      db.run("INSERT INTO local_experiment_charges(team_id,execution_id,request_id,case_id,maximum_usd,status) VALUES(?,?,?,?,?,'reserved')",[input.teamId,input.id,input.requestId,input.caseId,input.maximumUsd]);
      refreshLocalExecution(db,input.teamId,input.id);
    });
  }
  async markLocalChargeDispatched(teamId:string,id:string,requestId:string,ownerId:string) {
    return this.localWrite(db=> {
      this.requireLocalOwner(db,teamId,id,ownerId);
      const row=db.get<{status:string}>("SELECT status FROM local_experiment_charges WHERE team_id=? AND execution_id=? AND request_id=?",[teamId,id,requestId]);
      if(row?.status!=="reserved")throw new LocalExperimentError("local_dispatch_not_reserved","Target dispatch requires a fresh durable reservation.");
      db.run("UPDATE local_experiment_charges SET status='dispatched' WHERE team_id=? AND execution_id=? AND request_id=?",[teamId,id,requestId]);
      refreshLocalExecution(db,teamId,id);
    });
  }
  async settleLocalCharge(input:{teamId:string;id:string;requestId:string;ownerId:string;costUsd:number|null;usage:unknown|null;notDispatched?:boolean}) {
    const settled=await this.localWrite(db=> {
      this.requireLocalOwner(db,input.teamId,input.id,input.ownerId);
      const row=db.get<{status:string;maximum_usd:number;cost_usd:number|null;usage:string|null}>("SELECT status,maximum_usd,cost_usd,usage FROM local_experiment_charges WHERE team_id=? AND execution_id=? AND request_id=?",[input.teamId,input.id,input.requestId]);
      if(!row)throw new LocalExperimentError("local_charge_not_reserved","The charge does not belong to this execution.");
      if(input.costUsd!==null&&(!Number.isFinite(input.costUsd)||input.costUsd<0))throw new LocalExperimentError("local_charge_invalid","Measured charge must be finite and nonnegative.");
      const exceedsBound=input.costUsd!==null&&input.costUsd>row.maximum_usd+1e-12;
      const status=input.notDispatched&&row.status==="reserved"?"released":input.costUsd===null?"unknown":"settled";
      if(["released","settled"].includes(row.status)) {
        if(row.status!==status || row.cost_usd!==input.costUsd || (row.usage?contentHash(JSON.parse(row.usage)):null)!==(input.usage?contentHash(input.usage):null))throw new LocalExperimentError("local_charge_receipt_conflict","A sealed charge receipt is immutable.");
        return {execution:refreshLocalExecution(db,input.teamId,input.id),exceedsBound};
      }
      db.run("UPDATE local_experiment_charges SET status=?,cost_usd=?,usage=? WHERE team_id=? AND execution_id=? AND request_id=?",[status,input.costUsd,input.usage===null?null:JSON.stringify(input.usage),input.teamId,input.id,input.requestId]);
      return {execution:refreshLocalExecution(db,input.teamId,input.id),exceedsBound};
    });
    // Commit the measured receipt before rejecting its violated bound. Throwing
    // inside a transaction would discard evidence and mislabel known spend.
    if(settled.exceedsBound)throw new LocalExperimentError("local_charge_outside_bound","Measured charge exceeds its authoritative reservation. Its receipt was retained; no further target dispatch is admitted.");
    return settled.execution;
  }
  private requireLocalChargeBounds(db:OpenPondSqliteConnection,teamId:string,id:string) {
    if(db.get("SELECT request_id FROM local_experiment_charges WHERE team_id=? AND execution_id=? AND cost_usd>maximum_usd+0.000000000001 LIMIT 1",[teamId,id]))
      throw new LocalExperimentError("local_charge_outside_bound","A retained provider receipt exceeded its authoritative reservation. Further target and judge dispatch is blocked.");
  }
  private requireLocalOwner(db:OpenPondSqliteConnection,teamId:string,id:string,ownerId:string) {
    requireLocalRuntimeOwner(db,ownerId);
    const row=db.get<{owner_id:string}>("SELECT owner_id FROM local_experiment_executions WHERE team_id=? AND id=?",[teamId,id]);
    if(!row || row.owner_id!==ownerId)throw new LocalExperimentError("local_execution_owner_conflict","This process does not own the execution.");
  }
}
