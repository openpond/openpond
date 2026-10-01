import { randomUUID } from "node:crypto";
import { z } from "zod";
import { contentHash } from "@openpond/harness";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

const Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const EvaluationOperationScopeSchema=z.object({scopeHash:Hash,action:z.string().trim().min(1).max(100),intentHash:Hash}).strict();
export type EvaluationOperationScope=z.infer<typeof EvaluationOperationScopeSchema>;
export const recoverableEvaluationActions=["advanced-refiner-start","experiment-evaluation-schedule"] as const;
export type EvaluationOperationPhase="reviewed"|"dispatching";
export const EVALUATION_OPERATION_SCHEMA_SQL=`CREATE TABLE IF NOT EXISTS evaluation_operation_intents (
 scope_hash TEXT NOT NULL,action TEXT NOT NULL,intent_hash TEXT NOT NULL,
 operation_id TEXT NOT NULL,created_at TEXT NOT NULL,acknowledged_at TEXT,
 PRIMARY KEY(scope_hash,action,intent_hash)
);
CREATE TABLE IF NOT EXISTS evaluation_operation_reviewed_payloads (
 scope_hash TEXT NOT NULL,action TEXT NOT NULL,intent_hash TEXT NOT NULL,
 operation_id TEXT NOT NULL,payload TEXT NOT NULL,command TEXT,phase TEXT NOT NULL,
 PRIMARY KEY(scope_hash,action,intent_hash)
);
CREATE TABLE IF NOT EXISTS evaluation_operation_acknowledged_history (
 scope_hash TEXT NOT NULL,action TEXT NOT NULL,intent_hash TEXT NOT NULL,
 operation_id TEXT PRIMARY KEY,created_at TEXT NOT NULL,acknowledged_at TEXT NOT NULL,
 payload TEXT,command TEXT,phase TEXT
);`;
type RetainedRow={operation_id:string;created_at:string;acknowledged_at:string|null;payload:string|null;command:string|null;phase:EvaluationOperationPhase|null};
function retainedRow(db:OpenPondSqliteConnection,input:EvaluationOperationScope&{id:string}) {
  const args=[input.scopeHash,input.action,input.intentHash,input.id];
  return db.get<RetainedRow>(`SELECT i.operation_id,i.created_at,i.acknowledged_at,p.payload,p.command,p.phase FROM evaluation_operation_intents i LEFT JOIN evaluation_operation_reviewed_payloads p USING(scope_hash,action,intent_hash,operation_id) WHERE i.scope_hash=? AND i.action=? AND i.intent_hash=? AND i.operation_id=?`,args)
    ?? db.get<RetainedRow>(`SELECT operation_id,created_at,acknowledged_at,payload,command,phase FROM evaluation_operation_acknowledged_history WHERE scope_hash=? AND action=? AND intent_hash=? AND operation_id=?`,args);
}
function archiveAcknowledged(db:OpenPondSqliteConnection,scope:EvaluationOperationScope,id:string) {
  db.run(`INSERT OR IGNORE INTO evaluation_operation_acknowledged_history(scope_hash,action,intent_hash,operation_id,created_at,acknowledged_at,payload,command,phase) SELECT i.scope_hash,i.action,i.intent_hash,i.operation_id,i.created_at,i.acknowledged_at,p.payload,p.command,p.phase FROM evaluation_operation_intents i LEFT JOIN evaluation_operation_reviewed_payloads p USING(scope_hash,action,intent_hash,operation_id) WHERE i.scope_hash=? AND i.action=? AND i.intent_hash=? AND i.operation_id=? AND i.acknowledged_at IS NOT NULL`,[scope.scopeHash,scope.action,scope.intentHash,id]);
}
function bounded(value:unknown){const raw=JSON.stringify(value);if(raw===undefined||Buffer.byteLength(raw,"utf8")>1_048_576)throw new Error("Reviewed operation payload exceeds 1 MiB.");return raw;}
function retainable(action:string){if(!recoverableEvaluationActions.some(value=>value===action))throw new Error("This action does not admit recoverable reviewed payloads.");}
export function prepareEvaluationOperation(db:OpenPondSqliteConnection,input:EvaluationOperationScope&{reviewedIntent?:unknown}) {
  const scope=EvaluationOperationScopeSchema.parse({scopeHash:input.scopeHash,action:input.action,intentHash:input.intentHash});
  let payload:string|undefined;
  if(input.reviewedIntent!==undefined){retainable(scope.action);if(contentHash(input.reviewedIntent)!==scope.intentHash)throw new Error("Reviewed intent changed its exact hash.");payload=bounded(input.reviewedIntent);}
  const row=db.get<{operation_id:string;created_at:string;acknowledged_at:string|null}>(
    "SELECT operation_id,created_at,acknowledged_at FROM evaluation_operation_intents WHERE scope_hash=? AND action=? AND intent_hash=?",
    [scope.scopeHash,scope.action,scope.intentHash]);
  if((!row||row.acknowledged_at)&&recoverableEvaluationActions.some(value=>value===scope.action)) {
    const unresolved=db.get(`SELECT i.operation_id FROM evaluation_operation_intents i LEFT JOIN evaluation_operation_reviewed_payloads p USING(scope_hash,action,intent_hash,operation_id) WHERE i.scope_hash=? AND i.action=? AND i.acknowledged_at IS NULL AND (p.phase='dispatching' OR p.payload IS NULL) LIMIT 1`,[scope.scopeHash,scope.action]);
    if(unresolved)throw new Error("Recover the original uncertain operation before preparing another reviewed intent.");
  }
  const id=row&&!row.acknowledged_at?row.operation_id:randomUUID(),createdAt=row&&!row.acknowledged_at?row.created_at:new Date().toISOString();
  if(!row||row.acknowledged_at){
    if(row?.acknowledged_at)archiveAcknowledged(db,scope,row.operation_id);
    db.run("INSERT INTO evaluation_operation_intents(scope_hash,action,intent_hash,operation_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(scope_hash,action,intent_hash) DO UPDATE SET operation_id=excluded.operation_id,created_at=excluded.created_at,acknowledged_at=NULL",[scope.scopeHash,scope.action,scope.intentHash,id,createdAt]);
    db.run("DELETE FROM evaluation_operation_reviewed_payloads WHERE scope_hash=? AND action=? AND intent_hash=?",[scope.scopeHash,scope.action,scope.intentHash]);
  }
  if(payload!==undefined){
    const prior=db.get<{operation_id:string;payload:string}>("SELECT operation_id,payload FROM evaluation_operation_reviewed_payloads WHERE scope_hash=? AND action=? AND intent_hash=?",[scope.scopeHash,scope.action,scope.intentHash]);
    if(prior&&(prior.operation_id!==id||contentHash(JSON.parse(prior.payload))!==scope.intentHash))throw new Error("The retained reviewed payload belongs to another exact operation.");
    if(!prior)db.run("INSERT INTO evaluation_operation_reviewed_payloads(scope_hash,action,intent_hash,operation_id,payload,phase) VALUES(?,?,?,?,?,'reviewed')",[scope.scopeHash,scope.action,scope.intentHash,id,payload]);
  }
  return {id,createdAt};
}
export function retainEvaluationOperation(db:OpenPondSqliteConnection,input:EvaluationOperationScope&{id:string;command:unknown;phase:EvaluationOperationPhase}) {
  retainable(input.action);const scope=EvaluationOperationScopeSchema.parse({scopeHash:input.scopeHash,action:input.action,intentHash:input.intentHash}),command=bounded(input.command);
  const row=retainedRow(db,{...scope,id:input.id});
  if(!row?.payload||contentHash(JSON.parse(row.payload))!==scope.intentHash)throw new Error("The reviewed command requires its exact retained operation.");
  if(row.command&&contentHash(JSON.parse(row.command))!==contentHash(input.command))throw new Error("The reviewed command is immutable.");
  if(Buffer.byteLength(row.payload,"utf8")+Buffer.byteLength(command,"utf8")>1_048_576)throw new Error("Reviewed intent and command exceed 1 MiB.");
  const phase=row.phase==="dispatching"?"dispatching":input.phase;
  if(row.acknowledged_at){
    if(!row.command||row.phase!=="dispatching")throw new Error("The original reviewed command was discarded before dispatch.");
    return {retained:true as const,phase:row.phase??phase};
  }
  db.run("UPDATE evaluation_operation_reviewed_payloads SET command=?,phase=? WHERE scope_hash=? AND action=? AND intent_hash=? AND operation_id=?",[command,phase,scope.scopeHash,scope.action,scope.intentHash,input.id]);
  return {retained:true as const,phase};
}
export function pendingEvaluationOperations(db:OpenPondSqliteConnection,input:{scopeHash:string;action:string;cursor?:string;limit?:number}) {
  retainable(input.action);const scopeHash=Hash.parse(input.scopeHash),limit=z.number().int().min(1).max(100).parse(input.limit??100);
  const rows=db.all<{operation_id:string;intent_hash:string;created_at:string;payload:string|null;command:string|null;phase:EvaluationOperationPhase|null}>(`SELECT i.operation_id,i.intent_hash,i.created_at,p.payload,p.command,p.phase FROM evaluation_operation_intents i LEFT JOIN evaluation_operation_reviewed_payloads p USING(scope_hash,action,intent_hash,operation_id) WHERE i.scope_hash=? AND i.action=? AND i.acknowledged_at IS NULL AND i.operation_id>? ORDER BY i.operation_id LIMIT ?`,[scopeHash,input.action,input.cursor??"",limit]);
  return {items:rows.map(row=>({id:row.operation_id,action:input.action,intentHash:row.intent_hash,createdAt:row.created_at,reviewedIntent:row.payload?JSON.parse(row.payload) as unknown:null,command:row.command?JSON.parse(row.command) as unknown:null,phase:row.phase,recoveryReady:Boolean(row.payload&&row.command)})),nextCursor:rows.length===limit?rows.at(-1)!.operation_id:null};
}
export function readPendingEvaluationOperation(db:OpenPondSqliteConnection,input:EvaluationOperationScope&{id:string}) {
  const row=retainedRow(db,input);
  if(!row?.payload||!row.phase)throw new Error("The original reviewed operation payload is unavailable; recover its actual canonical receipt.");
  const reviewedIntent=JSON.parse(row.payload) as unknown;if(contentHash(reviewedIntent)!==input.intentHash)throw new Error("Retained reviewed intent hash changed.");
  return {reviewedIntent,command:row.command?JSON.parse(row.command) as unknown:null,phase:row.phase};
}
export function acknowledgeEvaluationOperation(db:OpenPondSqliteConnection,input:EvaluationOperationScope&{id:string;expectedPhase?:"reviewed"}) {
  const scope=EvaluationOperationScopeSchema.parse({scopeHash:input.scopeHash,action:input.action,intentHash:input.intentHash});
  const row=retainedRow(db,{...scope,id:input.id});
  if(!row)throw new Error("This acknowledgement does not own the retained operation intent.");
  if(input.expectedPhase&&row.phase!==input.expectedPhase)throw new Error("The reviewed command crossed dispatch; recover its canonical receipt before acknowledgement.");
  if(row.acknowledged_at)return {acknowledged:true as const};
  db.run("UPDATE evaluation_operation_intents SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE scope_hash=? AND action=? AND intent_hash=? AND operation_id=?",[new Date().toISOString(),scope.scopeHash,scope.action,scope.intentHash,input.id]);
  archiveAcknowledged(db,scope,input.id);
  return {acknowledged:true as const};
}
