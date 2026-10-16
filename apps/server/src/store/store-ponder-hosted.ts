import {SqliteStoreDomain} from "./store-domain.js";
import type {PonderHostedAssignment,PonderHostedAssignmentDetail} from "@openpond/contracts";
export type HostedPonderBinding={id:string;apiBaseUrl:string;teamId:string|null};
export type HostedPonderConnection={enabled:boolean;revision:number;account:HostedPonderBinding|null;capability?:{available:boolean;reason:string|null}};
export type HostedPonderJob=Omit<PonderHostedAssignment,"canCancel"> & {revision:number;creationKey:string;payloadHash:string;request:{modelId:string;reasoningEffort?:string;attachments:{id:string;name:string;contentType:string;sizeBytes:number}[]};events:PonderHostedAssignmentDetail["events"];outputs:PonderHostedAssignmentDetail["outputs"];cancelRequested:boolean;completionReceiptId:string|null;deliveryError:string|null};
const schema=`CREATE TABLE IF NOT EXISTS ponder_hosted_inputs(creation_key TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ponder_hosted_connections(coordinator_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ponder_hosted_jobs(id TEXT PRIMARY KEY,coordinator_id TEXT NOT NULL,creation_key TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL,payload TEXT NOT NULL);`;
export class SqlitePonderHostedStore extends SqliteStoreDomain {
 async reserveHostedPonderInput(input:import("../openpond/ponder-hosted-inputs.js").HostedPonderInput){
  await this.ready;const write=this.writeQueue.then(()=>{this.database.exec(schema);this.database.run("INSERT OR IGNORE INTO ponder_hosted_inputs VALUES(?,?,?)",[input.creationKey,input.payloadHash,JSON.stringify(input)]);const row=this.database.get<{payload_hash:string;payload:string}>("SELECT payload_hash,payload FROM ponder_hosted_inputs WHERE creation_key=?",[input.creationKey]);if(!row||row.payload_hash!==input.payloadHash)throw new Error("local_ponder_hosted_asset_conflict");return JSON.parse(row.payload) as typeof input;});this.writeQueue=write.then(()=>{},()=>{});return write;
 }
 async saveHostedPonderInput(input:import("../openpond/ponder-hosted-inputs.js").HostedPonderInput){
  await this.upsertPayload("UPDATE ponder_hosted_inputs SET payload=? WHERE creation_key=? AND payload_hash=?",[JSON.stringify(input),input.creationKey,input.payloadHash]);return input;
 }

 async hostedPonderConnection(coordinatorId:string):Promise<HostedPonderConnection>{
  await this.ready;await this.writeQueue;this.database.exec(schema);const row=this.database.get<{payload:string}>("SELECT payload FROM ponder_hosted_connections WHERE coordinator_id=?",[coordinatorId]);
  return row?JSON.parse(row.payload):{enabled:false,revision:0,account:null};
 }
 async configureHostedPonderConnection(coordinatorId:string,expectedRevision:number,enabled:boolean,account:HostedPonderBinding|null,capability?:HostedPonderConnection["capability"]):Promise<HostedPonderConnection>{
  await this.ready;const write=this.writeQueue.then(()=>{const db=this.database;db.exec(schema);db.exec("BEGIN IMMEDIATE");try{
   const row=db.get<{payload:string}>("SELECT payload FROM ponder_hosted_connections WHERE coordinator_id=?",[coordinatorId]);const current:HostedPonderConnection=row?JSON.parse(row.payload):{enabled:false,revision:0,account:null};
   if(current.revision!==expectedRevision)throw new Error("local_ponder_hosted_connection_changed");
   const next={enabled,revision:current.revision+1,account,capability:capability ?? current.capability};
   const coordinatorRow=db.get<{payload:string}>("SELECT payload FROM local_ponder_state WHERE id=1");
   if(!coordinatorRow)throw new Error("local_ponder_unavailable");
   const coordinator=JSON.parse(coordinatorRow.payload);if(coordinator.id!==coordinatorId)throw new Error("local_ponder_configuration_changed");
   db.run("UPDATE local_ponder_state SET payload=? WHERE id=1",[JSON.stringify({...coordinator,hostedSandboxesEnabled:enabled,revision:coordinator.revision+1})]);
   db.run("INSERT INTO ponder_hosted_connections VALUES(?,?) ON CONFLICT(coordinator_id) DO UPDATE SET payload=excluded.payload",[coordinatorId,JSON.stringify(next)]);db.exec("COMMIT");return next;
  }catch(error){db.exec("ROLLBACK");throw error;}});this.writeQueue=write.then(()=>{},()=>{});return write;
 }
 async hostedPonderJobs(coordinatorId:string):Promise<HostedPonderJob[]>{
  await this.ready;await this.writeQueue;this.database.exec(schema);return this.database.all<{payload:string}>("SELECT payload FROM ponder_hosted_jobs WHERE coordinator_id=? ORDER BY rowid DESC",[coordinatorId]).map(row=>JSON.parse(row.payload));
 }
 async reserveHostedPonderJob(job:HostedPonderJob):Promise<HostedPonderJob>{
  await this.ready;const write=this.writeQueue.then(()=>{const db=this.database;db.exec(schema);db.run("INSERT OR IGNORE INTO ponder_hosted_jobs VALUES(?,?,?,?,?)",[job.id,job.coordinatorId,job.creationKey,job.payloadHash,JSON.stringify(job)]);
   const row=db.get<{payload:string;payload_hash:string}>("SELECT payload,payload_hash FROM ponder_hosted_jobs WHERE creation_key=?",[job.creationKey]);if(!row||row.payload_hash!==job.payloadHash)throw new Error("local_ponder_hosted_assignment_conflict");return JSON.parse(row.payload) as HostedPonderJob;});this.writeQueue=write.then(()=>{},()=>{});return write;
 }
 async saveHostedPonderJob(job:HostedPonderJob):Promise<HostedPonderJob>{
  await this.ready;const write=this.writeQueue.then(()=>{this.database.exec(schema);this.database.exec("BEGIN IMMEDIATE");try{const current=this.database.get<{payload:string}>("SELECT payload FROM ponder_hosted_jobs WHERE id=?",[job.id]);if(!current)throw new Error("local_ponder_hosted_assignment_not_found");if((JSON.parse(current.payload) as HostedPonderJob).revision!==job.revision)throw new Error("local_ponder_hosted_assignment_changed");
   const next={...job,revision:job.revision+1,updatedAt:new Date().toISOString()};this.database.run("UPDATE ponder_hosted_jobs SET payload=? WHERE id=?",[JSON.stringify(next),job.id]);this.database.exec("COMMIT");return next;}catch(error){this.database.exec("ROLLBACK");throw error;}});this.writeQueue=write.then(()=>{},()=>{});return write;
 }
}
