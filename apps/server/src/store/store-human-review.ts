import {retainHumanLocalPublication,readHumanLocalPublications,type HumanLocalPublicationScope} from "./human-local-publications.js";
import {writeHumanLiveControl,type HumanLiveControlInput} from "./human-live-control.js";
import { HumanReviewSchema, type HumanReviewRepository, type HumanReviewTransaction, type HumanOperationReceipt } from "@openpond/evals/human-review";
import { LearningDomainError } from "@openpond/evals/learning";
import { SqliteLocalExperimentStore } from "./store-local-experiments.js";
import { localCases, localDefinition, localExecution } from "./local-experiment-records.js";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
export const HUMAN_REVIEW_SQL = `
CREATE TABLE IF NOT EXISTS human_review_revisions(scope TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id,revision));
CREATE TABLE IF NOT EXISTS human_reviews(scope TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,project_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id));
CREATE INDEX IF NOT EXISTS human_reviews_project_idx ON human_reviews(scope,project_id,id);
CREATE TABLE IF NOT EXISTS human_review_operations(scope TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id));
`;
export class SqliteHumanReviewStore extends SqliteLocalExperimentStore {
  async humanLiveControl(input:HumanLiveControlInput){await this.ready;const operation=this.writeQueue.then(()=>{const db=this.database;db.exec("BEGIN IMMEDIATE");try{const result=writeHumanLiveControl(db,input);db.exec("COMMIT");return result;}catch(error){db.exec("ROLLBACK");throw error;}});this.writeQueue=operation.then(()=>{},()=>{});return operation;}
  async humanLiveControlReceipt(input:Omit<HumanLiveControlInput,"phase">){await this.ready;await this.writeQueue;return writeHumanLiveControl(this.database,{...input,phase:"inspect"});}
  async rememberHumanLocalPublication(input:Parameters<typeof retainHumanLocalPublication>[1]){await this.ready;const write=this.writeQueue.then(()=>{const db=this.database;db.exec("BEGIN IMMEDIATE");try{retainHumanLocalPublication(db,input);db.exec("COMMIT");}catch(error){db.exec("ROLLBACK");throw error;}});this.writeQueue=write.then(()=>{},()=>{});return write;}
  async forgetHumanLocalPublication(input:{scope:string;actorId:string;publicationId:string}){await this.ready;const write=this.writeQueue.then(()=>{if(!this.database.get("SELECT name FROM sqlite_master WHERE type='table' AND name='human_local_publications'"))return;return this.database.run("DELETE FROM human_local_publications WHERE scope=? AND actor_id=? AND json_extract(publication,'$.id')=?",[input.scope,input.actorId,input.publicationId]);});this.writeQueue=write.then(()=>{},()=>{});return write;}
  async humanLocalPublications(input:HumanLocalPublicationScope){await this.ready;await this.writeQueue;return readHumanLocalPublications(this.database,input);}
  humanReviewRepository(): HumanReviewRepository {
    return { transaction: async (scope, callback) => {
      await this.ready;
      const operation = this.writeQueue.then(async () => {
        const db = this.database;
        db.exec(HUMAN_REVIEW_SQL); db.exec("BEGIN IMMEDIATE"); let open = true;
        try { const result = await callback(createHumanReviewTransaction(db,scope,()=>{if(!open)throw new Error("human_transaction_closed");})); db.exec("COMMIT"); return result; }
        catch (e) { db.exec("ROLLBACK"); throw e; }
        finally { open = false; }
      });
      this.writeQueue = operation.then(()=>{},()=>{}); return operation;
    } };
  }
  /** Human authority calls this only while its repository owns the connection/queue.
   * It cannot await queued Experiment writes from within that transaction. */
  humanReviewLocalEvidence(scope:string,id:string) {
    const execution = localExecution(this.database,scope,id);
    const released = localDefinition(this.database,scope,execution.definition.id,execution.definition.revision);
    return { execution, released, cases: localCases(this.database,scope,id) };
  }
}
export function createHumanReviewTransaction(db: OpenPondSqliteConnection, scope: string, check:()=>void): HumanReviewTransaction {
  type Row = { payload:string };
  return {
    async get(id,revision) { check(); const row = revision === undefined ? db.get<Row>("SELECT payload FROM human_reviews WHERE scope=? AND id=?",[scope,id]) : db.get<Row>("SELECT payload FROM human_review_revisions WHERE scope=? AND id=? AND revision=?",[scope,id,revision]); return row ? HumanReviewSchema.parse(JSON.parse(row.payload)) : null; },
    async put(raw,expectedRevision) {
      check(); const record=HumanReviewSchema.parse(raw), previous=db.get<{revision:number}>("SELECT revision FROM human_reviews WHERE scope=? AND id=?",[scope,record.id]);
      if (record.scope!==scope || record.revision!==expectedRevision+1 || (previous?.revision??0)!==expectedRevision) throw new LearningDomainError("human_revision_conflict",409);
      db.run("INSERT INTO human_review_revisions(scope,id,revision,payload) VALUES(?,?,?,?)",[scope,record.id,record.revision,JSON.stringify(record)]);
      db.run("INSERT INTO human_reviews(scope,id,revision,project_id,payload) VALUES(?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",[scope,record.id,record.revision,record.projectId,JSON.stringify(record)]);
    },
    async list(query) { check(); const rows=db.all<Row>(`SELECT payload FROM human_reviews WHERE scope=? ${query.projectId?"AND project_id=?":""} ${query.afterId?"AND id>?":""} ORDER BY id LIMIT ?`,[scope,...(query.projectId?[query.projectId]:[]),...(query.afterId?[query.afterId]:[]),query.limit+1]); const items=rows.slice(0,query.limit).map(r=>HumanReviewSchema.parse(JSON.parse(r.payload)));return{items,nextCursor:rows.length>query.limit?items.at(-1)!.id:null}; },
    async operation(id) { check(); const row=db.get<Row>("SELECT payload FROM human_review_operations WHERE scope=? AND id=?",[scope,id]);return row?JSON.parse(row.payload) as HumanOperationReceipt:null; },
    async saveOperation(id,receipt) { check();db.run("INSERT INTO human_review_operations(scope,id,payload) VALUES(?,?,?)",[scope,id,JSON.stringify(receipt)]); },
  };
}
