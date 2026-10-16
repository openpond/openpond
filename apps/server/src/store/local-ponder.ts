import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { LocalPonderCoordinatorSchema, LocalPonderRelationshipSchema, type LocalPonderRelationship } from "../openpond/local-ponder-contract.js";
import type { TaskInputAdmission } from "@openpond/contracts";

export const LOCAL_PONDER_SCHEMA = `CREATE TABLE IF NOT EXISTS local_ponder_state (id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS local_ponder_agents (session_id TEXT PRIMARY KEY,coordinator_id TEXT NOT NULL,creation_key TEXT NOT NULL UNIQUE,payload TEXT NOT NULL);`;
export function readLocalPonderRelationship(db: OpenPondSqliteConnection, sessionId: string): LocalPonderRelationship | null {
  if (!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='local_ponder_agents'")) return null;
  const row = db.get<{payload:string}>("SELECT payload FROM local_ponder_agents WHERE session_id=?", [sessionId]);
  return row ? LocalPonderRelationshipSchema.parse(JSON.parse(row.payload)) : null;
}
export function assertLocalPonderAdmission(db: OpenPondSqliteConnection, input: Pick<TaskInputAdmission,"senderSessionId"|"sessionId"|"payload">): void {
  // Older stores initialize this table on startup, before inbox recovery.
  const relationship = readLocalPonderRelationship(db, input.sessionId);
  if (!relationship || relationship.coordinatorSessionId !== input.senderSessionId) return;
  const expected = input.payload.localPonderControlRevision;
  if (relationship.owner !== "ponder" || expected !== relationship.revision) throw new Error("local_ponder_control_changed");
}

export function changeLocalPonderControl(db: OpenPondSqliteConnection, sessionId:string,owner:"ponder"|"user",revision:number) {
  const current = readLocalPonderRelationship(db,sessionId);
  if(!current) throw new Error("local_ponder_agent_not_found");
  if(current.revision!==revision) throw new Error("local_ponder_control_changed");
  const row=db.get<{payload:string}>("SELECT payload FROM sessions WHERE id=?",[sessionId]);
  if(!row) throw new Error("local_ponder_agent_not_found");
  const session=JSON.parse(row.payload) as import("@openpond/contracts").Session;
  const next={...current,owner,revision:current.revision+(current.owner===owner?0:1),updatedAt:new Date().toISOString()};
  const updated={...session,hiddenFromDefaultSidebar:owner!=="user",updatedAt:next.updatedAt};
  db.run("UPDATE local_ponder_agents SET payload=? WHERE session_id=?",[JSON.stringify(next),sessionId]);
  db.run("UPDATE sessions SET payload=?,updated_at=? WHERE id=?",[JSON.stringify(updated),updated.updatedAt,sessionId]);
  if(current.owner!==owner) {
    const rows=db.all<{id:string,payload:string}>("SELECT id,payload FROM task_inputs WHERE session_id=? AND state='pending'",[sessionId]);
    for(const row of rows) {
      const input=JSON.parse(row.payload) as import("@openpond/contracts").TaskInput;
      if(input.senderSessionId!==current.coordinatorSessionId) continue;
      db.run("UPDATE task_inputs SET state='rejected',payload=? WHERE id=?",[JSON.stringify({...input,state:"rejected",error:"local_ponder_control_changed",updatedAt:next.updatedAt}),row.id]);
    }
  }
  return {relationship:next,session:updated};
}

export function changeLocalPonderModel(db:OpenPondSqliteConnection,modelRef:import("@openpond/contracts").ChatModelRef,revision:number) {
  const row=db.get<{payload:string}>("SELECT payload FROM local_ponder_state WHERE id=1");
  if(!row) throw new Error("local_ponder_unavailable");
  const current=LocalPonderCoordinatorSchema.parse(JSON.parse(row.payload));
  if(current.revision!==revision||!current.sessionId) throw new Error("local_ponder_configuration_changed");
  const sessionRow=db.get<{payload:string}>("SELECT payload FROM sessions WHERE id=?",[current.sessionId]);
  if(!sessionRow) throw new Error("local_ponder_unavailable");
  const session=JSON.parse(sessionRow.payload) as import("@openpond/contracts").Session;
  if(session.status==="active"||db.get("SELECT id FROM turns WHERE session_id=? AND status='in_progress' LIMIT 1",[session.id]))
    throw new Error("local_ponder_model_change_requires_idle");
  const updated={...session,provider:modelRef.providerId,modelRef,updatedAt:new Date().toISOString()};
  const coordinator={...current,modelRef,revision:current.revision+1};
  db.run("UPDATE sessions SET payload=?,updated_at=? WHERE id=?",[JSON.stringify(updated),updated.updatedAt,updated.id]);
  db.run("UPDATE local_ponder_state SET payload=? WHERE id=1",[JSON.stringify(coordinator)]);
  return {coordinator,session:updated};
}
