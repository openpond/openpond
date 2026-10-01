import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

const Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const EvaluationOperationScopeSchema=z.object({scopeHash:Hash,action:z.string().trim().min(1).max(100),intentHash:Hash}).strict();
export type EvaluationOperationScope=z.infer<typeof EvaluationOperationScopeSchema>;
export const EVALUATION_OPERATION_SCHEMA_SQL=`CREATE TABLE IF NOT EXISTS evaluation_operation_intents (
 scope_hash TEXT NOT NULL,action TEXT NOT NULL,intent_hash TEXT NOT NULL,
 operation_id TEXT NOT NULL,created_at TEXT NOT NULL,acknowledged_at TEXT,
 PRIMARY KEY(scope_hash,action,intent_hash)
);`;
export function prepareEvaluationOperation(db:OpenPondSqliteConnection,input:EvaluationOperationScope) {
  const scope=EvaluationOperationScopeSchema.parse(input);
  const row=db.get<{operation_id:string;created_at:string;acknowledged_at:string|null}>(
    "SELECT operation_id,created_at,acknowledged_at FROM evaluation_operation_intents WHERE scope_hash=? AND action=? AND intent_hash=?",
    [scope.scopeHash,scope.action,scope.intentHash]);
  if(row&&!row.acknowledged_at)return {id:row.operation_id,createdAt:row.created_at};
  const id=randomUUID(),createdAt=new Date().toISOString();
  db.run("INSERT INTO evaluation_operation_intents(scope_hash,action,intent_hash,operation_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(scope_hash,action,intent_hash) DO UPDATE SET operation_id=excluded.operation_id,created_at=excluded.created_at,acknowledged_at=NULL",
    [scope.scopeHash,scope.action,scope.intentHash,id,createdAt]);
  return {id,createdAt};
}
export function acknowledgeEvaluationOperation(db:OpenPondSqliteConnection,input:EvaluationOperationScope&{id:string}) {
  const scope=EvaluationOperationScopeSchema.parse({scopeHash:input.scopeHash,action:input.action,intentHash:input.intentHash});
  const row=db.get<{operation_id:string}>("SELECT operation_id FROM evaluation_operation_intents WHERE scope_hash=? AND action=? AND intent_hash=?",[scope.scopeHash,scope.action,scope.intentHash]);
  if(row?.operation_id!==input.id)throw new Error("This acknowledgement does not own the retained operation intent.");
  db.run("UPDATE evaluation_operation_intents SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE scope_hash=? AND action=? AND intent_hash=? AND operation_id=?",
    [new Date().toISOString(),scope.scopeHash,scope.action,scope.intentHash,input.id]);
  return {acknowledged:true as const};
}
