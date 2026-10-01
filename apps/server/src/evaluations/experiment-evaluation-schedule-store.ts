import { ScheduledAdmissionRejectedError } from "./evaluation-schedule-admission-guard.js";
import path from "node:path";
import { contentHash } from "@openpond/harness";
import { randomUUID } from "node:crypto";
import { openStorageDatabase } from "@openpond/persistence";
import {
  verifyExperimentEvaluationSchedule,
  type ExperimentEvaluationSchedule,
} from "openpond-sdk/experiment-evaluation-schedules";
/** The timer, occurrence intent and immutable history share cross-process CAS.
 * Provider calls run outside this transaction and retain a canonical run ID. */
export function createExperimentEvaluationScheduleStore(storeDir: string) {
  const db = openStorageDatabase(
    path.join(
      storeDir,
      "library",
      "harnesses",
      "experiment-evaluation-schedules.sqlite",
    ),
  );
  db.exec(`CREATE TABLE IF NOT EXISTS experiment_evaluation_schedules(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,team_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,lease_token TEXT,lease_expires_at TEXT);
 CREATE TABLE IF NOT EXISTS experiment_evaluation_schedule_revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,revision));
 CREATE TABLE IF NOT EXISTS experiment_evaluation_schedule_operations(actor_id TEXT NOT NULL,team_id TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor_id,team_id,operation_id));`);
  function read(id: string, actorId: string, teamId: string) {
    const row = db
      .prepare(
        "SELECT payload FROM experiment_evaluation_schedules WHERE id=? AND actor_id=? AND team_id=?",
      )
      .get(id, actorId, teamId);
    return row
      ? verifyExperimentEvaluationSchedule(JSON.parse(String(row.payload)))
      : null;
  }
  function transaction<T>(fn: () => T) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function write(value: ExperimentEvaluationSchedule) {
    const v = verifyExperimentEvaluationSchedule(value);
    const existing = db
      .prepare(
        "SELECT actor_id,team_id FROM experiment_evaluation_schedules WHERE id=?",
      )
      .get(v.id);
    if (
      existing &&
      (existing.actor_id !== v.actorId || existing.team_id !== v.teamId)
    )
      throw new Error("Schedule ID belongs to another owner.");
    db.prepare(
      "INSERT INTO experiment_evaluation_schedule_revisions(id,revision,payload) VALUES(?,?,?)",
    ).run(v.id, v.revision, JSON.stringify(v));
    db.prepare(
      "INSERT INTO experiment_evaluation_schedules(id,actor_id,team_id,revision,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",
    ).run(v.id, v.actorId, v.teamId, v.revision, JSON.stringify(v));
    return v;
  }
  return {
    read,
    list(actorId: string, teamId: string, afterId = "", limit = 50) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Invalid schedule page size.");
      return db
        .prepare(
          "SELECT payload FROM experiment_evaluation_schedules WHERE actor_id=? AND team_id=? AND id>? ORDER BY id LIMIT ?",
        )
        .all(actorId, teamId, afterId, limit)
        .map((row) =>
          verifyExperimentEvaluationSchedule(JSON.parse(String(row.payload))),
        );
    },
    operation(
      actorId: string,
      teamId: string,
      operationId: string,
      requestHash: string,
      fn: () => ExperimentEvaluationSchedule,
    ) {
      return transaction(() => {
        const prior = db
          .prepare(
            "SELECT request_hash,result FROM experiment_evaluation_schedule_operations WHERE actor_id=? AND team_id=? AND operation_id=?",
          )
          .get(actorId, teamId, operationId);
        if (prior) {
          if (prior.request_hash !== requestHash)
            throw new Error(
              "Schedule operation retains another reviewed intent.",
            );
          return verifyExperimentEvaluationSchedule(
            JSON.parse(String(prior.result)),
          );
        }
        const proposed = fn();
        if (proposed.actorId !== actorId || proposed.teamId !== teamId)
          throw new Error("Schedule operation changed its owner.");
        const value = write(proposed);
        db.prepare(
          "INSERT INTO experiment_evaluation_schedule_operations(actor_id,team_id,operation_id,request_hash,result) VALUES(?,?,?,?,?)",
        ).run(actorId, teamId, operationId, requestHash, JSON.stringify(value));
        db.prepare(
          "UPDATE experiment_evaluation_schedules SET lease_token=NULL,lease_expires_at=NULL WHERE id=?",
        ).run(value.id);
        return value;
      });
    },
    claim(id: string, actorId: string, teamId: string) {
      return transaction(() => {
        const value = read(id, actorId, teamId);
        if (!value) return null;
        const row = db
          .prepare(
            "SELECT lease_expires_at FROM experiment_evaluation_schedules WHERE id=?",
          )
          .get(id);
        if (
          row?.lease_expires_at &&
          String(row.lease_expires_at) > new Date().toISOString()
        )
          return null;
        const token = randomUUID();
        db.prepare(
          "UPDATE experiment_evaluation_schedules SET lease_token=?,lease_expires_at=? WHERE id=?",
        ).run(token, new Date(Date.now() + 60000).toISOString(), id);
        return { value, token };
      });
    },
    advance(value: ExperimentEvaluationSchedule, token: string) {
      return transaction(() => {
        const current = read(value.id, value.actorId, value.teamId),
          row = db
            .prepare(
              "SELECT lease_token,lease_expires_at FROM experiment_evaluation_schedules WHERE id=?",
            )
            .get(value.id);
        if (
          !current ||
          row?.lease_token !== token ||
          String(row.lease_expires_at) <= new Date().toISOString() ||
          value.revision !== current.revision + 1
        )
          throw new Error(
            "Scheduled evaluation owner lease or revision changed.",
          );
        const result = write(value);
        return result;
      });
    },
    admissionGuard(value:ExperimentEvaluationSchedule,token:string,operationId:string) {
      const expectedId=`local-run-${contentHash([value.teamId,value.actorId,operationId]).slice(0,48)}`;
      const current=()=>{const schedule=read(value.id,value.actorId,value.teamId),fire=schedule?.fires.find(fire=>fire.operationId===operationId);if(!schedule||!fire||fire.configurationHash!==value.configurationHash)throw new Error("The actual scheduled occurrence changed.");return {schedule,fire};};
      return {
        withAdmission<T>(write:()=>T):T { return transaction(()=>{const {schedule,fire}=current(),lease=db.prepare("SELECT lease_token,lease_expires_at FROM experiment_evaluation_schedules WHERE id=?").get(value.id);if(schedule.revision!==value.revision||lease?.lease_token!==token||String(lease.lease_expires_at)<=new Date().toISOString()||fire.state!=="dispatching")throw new ScheduledAdmissionRejectedError(value.id,operationId,value.configurationHash);return write();});},
        assertExecution(id:string) {const {fire}=current();if(id!==expectedId||!["dispatching","running"].includes(fire.state))throw new Error("The retained scheduled Run is no longer authorized for new provider requests.");}
      };
    },
    retainRejectedAdmission(value:ExperimentEvaluationSchedule,token:string,proof:ScheduledAdmissionRejectedError) {
      return transaction(()=> {
        const current=read(value.id,value.actorId,value.teamId);
        const lease=db.prepare("SELECT lease_token FROM experiment_evaluation_schedules WHERE id=?").get(value.id);
        const fire=current?.fires.find(item=>item.operationId===proof.operationId);
        if(!current||!fire||proof.scheduleId!==current.id||proof.configurationHash!==fire.configurationHash
          ||fire.executionId!==null||!['dispatching','cleaning'].includes(fire.state)
          ||(lease?.lease_token&&lease.lease_token!==token))throw new Error("The rejected occurrence requires current owner recovery.");
        // The proof was created under canonical Run's serialized transaction,
        // after original-operation lookup and before insertion callback invocation.
        // A cancelled occurrence cannot subsequently pass admission's lease CAS.
        const {contentHash:_hash,...body}=current;
        const next={...body,revision:current.revision+1,updatedAt:new Date().toISOString(),
          fires:current.fires.map(item=>item.operationId===proof.operationId?{...item,state:'cancelled' as const,actualSpendUsd:0,cleanupComplete:true,error:proof.message}:item)};
        return write({...next,contentHash:contentHash(next)});
      });
    },
    renew(id: string, token: string) {
      return (
        db
          .prepare(
            "UPDATE experiment_evaluation_schedules SET lease_expires_at=? WHERE id=? AND lease_token=? AND lease_expires_at>?",
          )
          .run(
            new Date(Date.now() + 60000).toISOString(),
            id,
            token,
            new Date().toISOString(),
          ).changes === 1
      );
    },
    release(id: string, token: string) {
      db.prepare(
        "UPDATE experiment_evaluation_schedules SET lease_token=NULL,lease_expires_at=NULL WHERE id=? AND lease_token=?",
      ).run(id, token);
    },
    close() {
      db.close();
    },
  };
}
