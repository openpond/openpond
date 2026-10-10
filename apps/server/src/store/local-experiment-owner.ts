import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { LocalExperimentError } from "../evaluations/local-experiment-contract.js";

const LEASE_MS=15000;
export function claimLocalExperimentOwner(db:OpenPondSqliteConnection,ownerId:string,pid:number) {
  const previous=db.get<{owner_id:string;pid:number;lease_until:number}>("SELECT owner_id,pid,lease_until FROM local_experiment_owner WHERE singleton=1");
  // A delayed heartbeat does not prove a local process is dead. Letting another
  // live server claim an expired row can dispatch concurrently after a stall.
  if(previous&&previous.owner_id!==ownerId&&alive(previous.pid))
    throw new LocalExperimentError("local_runtime_already_owned","Another live local server owns Experiment execution in this installation.");
  db.run("INSERT INTO local_experiment_owner(singleton,owner_id,pid,lease_until) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET owner_id=excluded.owner_id,pid=excluded.pid,lease_until=excluded.lease_until",[ownerId,pid,Date.now()+LEASE_MS]);
}
export function requireLocalRuntimeOwner(db:OpenPondSqliteConnection,ownerId:string) {
  const row=db.get<{owner_id:string;pid:number}>("SELECT owner_id,pid FROM local_experiment_owner WHERE singleton=1");
  if(!row||row.owner_id!==ownerId||row.pid!==process.pid)throw new LocalExperimentError("local_runtime_lease_lost","This process no longer owns local Experiment execution.");
}
export function renewLocalExperimentOwner(db:OpenPondSqliteConnection,ownerId:string) {
  // Renewal may arrive after the deadline when the event loop or write queue
  // stalls. The unchanged owner can renew; a replaced/released owner cannot.
  requireLocalRuntimeOwner(db,ownerId);
  db.run("UPDATE local_experiment_owner SET lease_until=? WHERE singleton=1 AND owner_id=?",[Date.now()+LEASE_MS,ownerId]);
}
function alive(pid:number) {
  if(!Number.isSafeInteger(pid)||pid<=0)return true;
  try {process.kill(pid,0);return true;}catch(error){return !(error instanceof Error&&"code" in error&&error.code==="ESRCH");}
}
