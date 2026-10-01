import path from "node:path";
import { openStorageDatabase } from "@openpond/persistence";
import { verifyExperimentImprovementState, type ExperimentImprovementState } from "./experiment-improvement-state.js";

/** Private local authority with cross-process transactional CAS and immutable revision history. */
export function createExperimentImprovementStore(storeDir:string) {
  const db=openStorageDatabase(path.join(storeDir,"library","harnesses","experiment-improvements.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS experiment_improvements(id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, team_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(actor_id,team_id,operation_id));
    CREATE TABLE IF NOT EXISTS experiment_improvement_revisions(id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id,revision));`);
  let queue:Promise<unknown>=Promise.resolve();
  const serialize=<T>(fn:()=>Promise<T>):Promise<T>=>{const next=queue.then(fn);queue=next.catch(()=>undefined);return next;};
  function row(id:string,actorId:string,teamId:string){const value=db.prepare("SELECT payload FROM experiment_improvements WHERE id=? AND actor_id=? AND team_id=?").get(id,actorId,teamId);return value?verifyExperimentImprovementState(JSON.parse(String(value.payload))):null;}
  function persist(value:ExperimentImprovementState){const verified=verifyExperimentImprovementState(value);db.prepare("INSERT INTO experiment_improvement_revisions(id,revision,payload) VALUES(?,?,?)").run(value.id,value.revision,JSON.stringify(verified));
    db.prepare("INSERT INTO experiment_improvements(id,actor_id,team_id,operation_id,request_hash,revision,payload) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload").run(value.id,value.actorId,value.teamId,value.operationId,value.requestHash,value.revision,JSON.stringify(verified));return verified;}
  return {
    async find(id:string,actorId:string,teamId:string){await queue;return row(id,actorId,teamId);},
    async read(id:string,actorId:string,teamId:string){await queue;const value=row(id,actorId,teamId);if(!value)throw new Error("Improvement is unavailable to this owner.");return value;},
    async list(actorId:string,teamId:string,limit=30,afterId?:string){await queue;if(limit<1||limit>50)throw new Error("Improvement list limit is invalid.");return db.prepare("SELECT payload FROM experiment_improvements WHERE actor_id=? AND team_id=? AND id>? ORDER BY id LIMIT ?").all(actorId,teamId,afterId??"",limit).map(value=>verifyExperimentImprovementState(JSON.parse(String(value.payload))));},
    create(value:ExperimentImprovementState){return serialize(async()=>{db.exec("BEGIN IMMEDIATE");try{const existing=db.prepare("SELECT payload FROM experiment_improvements WHERE actor_id=? AND team_id=? AND operation_id=?").get(value.actorId,value.teamId,value.operationId);
      if(existing){const result=verifyExperimentImprovementState(JSON.parse(String(existing.payload)));if(result.requestHash!==value.requestHash)throw new Error("Improvement operation was reused with different authority or evidence.");db.exec("COMMIT");return result;}
      const result=persist(value);db.exec("COMMIT");return result;}catch(error){db.exec("ROLLBACK");throw error;}});},
    mutate(id:string,actorId:string,teamId:string,expectedRevision:number,fn:(current:ExperimentImprovementState)=>Promise<ExperimentImprovementState>){return serialize(async()=>{db.exec("BEGIN IMMEDIATE");try{const current=row(id,actorId,teamId);if(!current||current.revision!==expectedRevision)throw new Error("Improvement changed; reload its current revision.");const next=await fn(current);
      if(next.id!==current.id||next.actorId!==actorId||next.teamId!==teamId||next.operationId!==current.operationId||next.requestHash!==current.requestHash||next.revision!==current.revision+1)throw new Error("Improvement transition changed its immutable owner or operation authority.");const result=persist(next);db.exec("COMMIT");return result;}catch(error){db.exec("ROLLBACK");throw error;}});},
    async close(){await queue;db.close();}
  };
}
export type ExperimentImprovementStore=ReturnType<typeof createExperimentImprovementStore>;
