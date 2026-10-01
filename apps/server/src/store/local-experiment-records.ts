import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { LocalExperimentError, LocalExperimentExecutionSchema, LocalExperimentDefinitionSchema,
  type LocalExperimentDefinition, type LocalExperimentExecution, type LocalExperimentAdmission, type LocalCaseStatus } from "../evaluations/local-experiment-contract.js";

export type LocalCaseRecord = { receiptId:string;status:LocalCaseStatus;admission:LocalExperimentAdmission;result:unknown|null;error:string|null };
export function localDefinition(db:OpenPondSqliteConnection,teamId:string,id:string,revision?:number) {
  const row=db.get<{payload:string;package_payload:string}>(
    `SELECT payload,package_payload FROM local_experiment_definitions WHERE team_id=? AND id=? ${revision===undefined?"ORDER BY revision DESC LIMIT 1":"AND revision=?"}`,
    revision===undefined?[teamId,id]:[teamId,id,revision]);
  if(!row)throw new LocalExperimentError("local_definition_not_found","Local Experiment definition is unavailable in this workspace.",404);
  return {definition:LocalExperimentDefinitionSchema.parse(JSON.parse(row.payload)),package:JSON.parse(row.package_payload) as unknown};
}
export function localExecution(db:OpenPondSqliteConnection,teamId:string,id:string):LocalExperimentExecution {
  const row=db.get<{payload:string}>("SELECT payload FROM local_experiment_executions WHERE team_id=? AND id=?",[teamId,id]);
  if(!row)throw new LocalExperimentError("local_execution_not_found","Local Experiment execution is unavailable in this workspace.",404);
  return LocalExperimentExecutionSchema.parse(JSON.parse(row.payload));
}
export function localCases(db:OpenPondSqliteConnection,teamId:string,id:string):LocalCaseRecord[] {
  return db.all<{receipt_id:string;status:LocalCaseStatus;admission:string;result:string|null;error:string|null}>(
    "SELECT receipt_id,status,admission,result,error FROM local_experiment_cases WHERE team_id=? AND execution_id=? ORDER BY ordinal",[teamId,id])
    .map(row=>({receiptId:row.receipt_id,status:row.status,admission:JSON.parse(row.admission) as LocalExperimentAdmission,result:row.result?JSON.parse(row.result) as unknown:null,error:row.error}));
}
export function refreshLocalExecution(db:OpenPondSqliteConnection,teamId:string,id:string,update:Partial<LocalExperimentExecution>={}):LocalExperimentExecution {
  const old=localExecution(db,teamId,id);
  const counts={pending:0,running:0,completed:0,failed:0,cancelled:0,unknown:0};
  for(const row of db.all<{status:LocalCaseStatus;count:number}>("SELECT status,COUNT(*) AS count FROM local_experiment_cases WHERE team_id=? AND execution_id=? GROUP BY status",[teamId,id])) counts[row.status]=row.count;
  const charges=db.get<{spent:number;held:number;uncertain:number}>(`SELECT COALESCE(SUM(CASE WHEN status='settled' THEN cost_usd ELSE 0 END),0) AS spent,
    COALESCE(SUM(CASE WHEN status IN ('reserved','dispatched','unknown') THEN maximum_usd ELSE 0 END),0) AS held,
    COALESCE(SUM(CASE WHEN status IN ('dispatched','unknown') THEN 1 ELSE 0 END),0) AS uncertain FROM local_experiment_charges WHERE team_id=? AND execution_id=?`,[teamId,id])!;
  const value=LocalExperimentExecutionSchema.parse({...old,...update,counts,usage:{knownCostUsd:charges.spent,costUsd:charges.uncertain?null:charges.spent,heldUsd:charges.held,uncertainRequests:charges.uncertain}});
  db.run("UPDATE local_experiment_executions SET payload=? WHERE team_id=? AND id=?",[JSON.stringify(value),teamId,id]);
  return value;
}
export function localOperation<T>(db:OpenPondSqliteConnection,teamId:string,operationId:string,kind:string,intentHash:string,apply:()=>T):T {
  const existing=db.get<{kind:string;intent_hash:string;receipt:string}>("SELECT kind,intent_hash,receipt FROM local_experiment_operations WHERE team_id=? AND operation_id=?",[teamId,operationId]);
  if(existing) {
    if(existing.kind!==kind || existing.intent_hash!==intentHash) throw new LocalExperimentError("local_operation_conflict","This operation already owns different immutable inputs.");
    return JSON.parse(existing.receipt) as T;
  }
  const receipt=apply();
  db.run("INSERT INTO local_experiment_operations(team_id,operation_id,kind,intent_hash,receipt) VALUES(?,?,?,?,?)",[teamId,operationId,kind,intentHash,JSON.stringify(receipt)]);
  return receipt;
}
export function writeLocalDefinition(db:OpenPondSqliteConnection,value:LocalExperimentDefinition,packageValue:unknown) {
  db.run("INSERT INTO local_experiment_definitions(team_id,id,revision,content_hash,project_id,payload,package_payload) VALUES(?,?,?,?,?,?,?)",
    [value.teamId,value.id,value.revision,value.contentHash,value.configuration.request.project?.id??null,JSON.stringify(value),JSON.stringify(packageValue)]);
}
