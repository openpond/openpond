import { randomUUID } from "node:crypto";
import { contentHash } from "@openpond/harness";
import { LocalDatasetRecordSchema, ChatResourceSummarySchema, type LocalDatasetRecord, type ChatResourceSummary } from "@openpond/contracts";
import { validateTasksetDraftWorkspace,TasksetDraftWorkspaceFileSchema } from "openpond-sdk/taskset-drafts";
import { SqliteStoreDomain } from "./store-domain.js";
import {localDatasetProjectionPaths,projectLocalDatasetWorkspace} from "../training/local-dataset-projection.js";
import { hydrateLocalDatasetFile, hydrateLocalDatasetMetadata, hydrateLocalDatasetRecord, retainLocalDatasetRecord } from "./store-local-dataset-storage.js";

const LocalDatasetListingSchema=LocalDatasetRecordSchema.omit({workspace:true}).extend({workspace:LocalDatasetRecordSchema.shape.workspace.omit({files:true})});
export type LocalDatasetListing=ReturnType<typeof LocalDatasetListingSchema.parse>;

/** This installation owns local resources independently of account/workspace
 * selection. Hosted destinations retain their own explicit authorization. */
export class SqliteChatResourceStore extends SqliteStoreDomain {
  private datasetListings = new Map<string,{stamp:string;value:LocalDatasetListing}>();
  private datasetListingDataVersion: number | null = null;
  async listChatHostedExperiments():Promise<unknown[]> {await this.ready;await this.writeQueue;return this.database.all<{payload:string}>("SELECT payload FROM chat_hosted_experiments ORDER BY id",[]).map(row=>JSON.parse(row.payload) as unknown);}
  async readChatHostedExperiment(id:string):Promise<unknown|null> {
    await this.ready;await this.writeQueue;
    const row=this.database.get<{payload:string}>("SELECT payload FROM chat_hosted_experiments WHERE id=?",[id]);return row ? JSON.parse(row.payload) as unknown : null;
  }
  async retainChatHostedExperiment(id:string,ownerHash:string,configurationHash:string,payload:unknown):Promise<void> {
    await this.ready;
    const write=this.writeQueue.then(()=>{
      const prior=this.database.get<{owner_hash:string;configuration_hash:string}>("SELECT owner_hash,configuration_hash FROM chat_hosted_experiments WHERE id=?",[id]);
      if(prior && (prior.owner_hash!==ownerHash || prior.configuration_hash!==configurationHash))throw new Error("The retained hosted Experiment changed owner or configuration.");
      this.database.run("INSERT INTO chat_hosted_experiments(id,owner_hash,configuration_hash,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",[id,ownerHash,configurationHash,JSON.stringify(payload)]);
    });this.writeQueue=write.then(()=>{},()=>{});return write;
  }
  async readChatExperimentGroup(operationId:string,requestHash?:string):Promise<unknown|null> {
    await this.ready;await this.writeQueue;
    const row=this.database.get<{request_hash:string;payload:string}>("SELECT request_hash,payload FROM chat_experiment_groups WHERE operation_id=?",[operationId]);
    if(!row)return null;
    if(requestHash && row.request_hash!==requestHash)throw new Error("Experiment operation ID was reused with different inputs.");
    return JSON.parse(row.payload) as unknown;
  }
  async prepareChatExperimentGroup(operationId:string,requestHash:string,payload:unknown):Promise<unknown> {
    await this.ready;
    const write=this.writeQueue.then(()=>{
      this.database.run("INSERT OR IGNORE INTO chat_experiment_groups(operation_id,request_hash,payload) VALUES(?,?,?)",[operationId,requestHash,JSON.stringify(payload)]);
      const row=this.database.get<{request_hash:string;payload:string}>("SELECT request_hash,payload FROM chat_experiment_groups WHERE operation_id=?",[operationId])!;
      if(row.request_hash!==requestHash)throw new Error("Experiment operation ID was reused with different inputs.");
      return JSON.parse(row.payload) as unknown;
    });
    this.writeQueue=write.then(()=>{},()=>{});return write;
  }
  async localResourceOwnerId(): Promise<string> {
    await this.ready;
    const write = this.writeQueue.then(() => {
      this.database.run("INSERT OR IGNORE INTO local_resource_owner(singleton,id) VALUES(1,?)", [`local-owner-${randomUUID()}`]);
      return this.database.get<{id:string}>("SELECT id FROM local_resource_owner WHERE singleton=1", [])!.id;
    });
    this.writeQueue = write.then(() => undefined, () => undefined);
    return write;
  }

  async readLocalDataset(id: string, revision?: number): Promise<LocalDatasetRecord | null> {
    await this.ready; await this.writeQueue;
    const row = this.database.get<{payload:string}>(revision === undefined
      ? "SELECT r.payload FROM local_dataset_workspaces w JOIN local_dataset_records r ON r.record_hash=w.record_hash WHERE w.id=?"
      : "SELECT r.payload FROM local_dataset_versions w JOIN local_dataset_records r ON r.record_hash=w.record_hash WHERE w.id=? AND w.revision=?",
      revision === undefined ? [id] : [id, revision]);
    return row ? hydrateLocalDatasetRecord(this.database, row.payload) : null;
  }

  async readLocalDatasetByWorkspaceHash(id:string,workspaceHash:string):Promise<LocalDatasetRecord|null> {
    await this.ready; await this.writeQueue;
    const row=this.database.get<{payload:string}>("SELECT r.payload FROM local_dataset_versions w JOIN local_dataset_records r ON r.record_hash=w.record_hash WHERE w.id=? AND json_extract(r.payload,'$.workspace.contentHash')=?",[id,workspaceHash]);
    return row ? hydrateLocalDatasetRecord(this.database,row.payload) : null;
  }

  async listLocalDatasets(syncOnly=false): Promise<LocalDatasetRecord[]> {
    if(syncOnly) {
      const linked=(await this.listLocalDatasetListings()).filter(record=>record.sync);
      const records=await Promise.all(linked.map(record=>this.readLocalDataset(record.workspace.draft.id)));
      return records.filter((record):record is LocalDatasetRecord=>record!==null);
    }
    await this.ready; await this.writeQueue;
    return this.database.all<{payload:string}>("SELECT r.payload FROM local_dataset_workspaces w JOIN local_dataset_records r ON r.record_hash=w.record_hash ORDER BY w.updated_at DESC",[])
      .map(row=>hydrateLocalDatasetRecord(this.database,row.payload));
  }

  async listLocalDatasetListings():Promise<LocalDatasetListing[]> {
    // Catalog polling needs authored metadata, never every PDF's base64 bytes.
    await this.ready;await this.writeQueue;
    // Even SQLite JSON projection must scan every base64 byte. Poll small row
    // stamps and hydrate metadata once per edit, rather than once per UI poll.
    const version=this.database.get<{data_version:number}>("PRAGMA data_version",[])!.data_version;
    if(this.datasetListingDataVersion!==version)this.datasetListings.clear();
    this.datasetListingDataVersion=version;
    const rows=this.database.all<{id:string;revision:number;updated_at:string}>("SELECT id,revision,updated_at FROM local_dataset_workspaces ORDER BY updated_at DESC",[]);
    const ids=new Set(rows.map(row=>row.id));
    for(const id of this.datasetListings.keys())if(!ids.has(id))this.datasetListings.delete(id);
    return rows.map(row=>{
      const stamp=`${row.revision}:${row.updated_at}`;
      const cached=this.datasetListings.get(row.id);
      if(cached?.stamp===stamp)return structuredClone(cached.value);
      const payload=this.database.get<{payload:string}>("SELECT json_remove(r.payload,'$.workspace.files') AS payload FROM local_dataset_workspaces w JOIN local_dataset_records r ON r.record_hash=w.record_hash WHERE w.id=?",[row.id])!.payload;
      const value=LocalDatasetListingSchema.parse(hydrateLocalDatasetMetadata(this.database,payload));
      this.datasetListings.set(row.id,{stamp,value});return structuredClone(value);
    });
  }

  async readLocalDatasetListing(id:string,revision?:number):Promise<LocalDatasetListing|null> {
    await this.ready; await this.writeQueue;
    const table=revision===undefined ? "local_dataset_workspaces" : "local_dataset_versions";
    const row=this.database.get<{payload:string}>(`SELECT json_remove(r.payload,'$.workspace.files') AS payload FROM ${table} w JOIN local_dataset_records r ON r.record_hash=w.record_hash WHERE w.id=?${revision===undefined ? "" : " AND w.revision=?"}`,revision===undefined ? [id] : [id,revision]);
    return row ? LocalDatasetListingSchema.parse(hydrateLocalDatasetMetadata(this.database,row.payload)) : null;
  }

  /** Saved versions own the complete source hash. Hydrate just the selected
   * closure so admission never copies unrelated binary strings into JS heaps. */
  async readLocalDatasetProjection(id:string,taskIds:string[],selection:{revision?:number;workspaceHash?:string}) {
    await this.ready;await this.writeQueue;
    const where=selection.workspaceHash ? "w.id=? AND json_extract(r.payload,'$.workspace.contentHash')=?" : selection.revision===undefined ? "w.id=?" : "w.id=? AND w.revision=?";
    const table=selection.workspaceHash || selection.revision!==undefined ? "local_dataset_versions" : "local_dataset_workspaces";
    const params=selection.workspaceHash ? [id,selection.workspaceHash] : selection.revision===undefined ? [id] : [id,selection.revision];
    const from=`${table} w JOIN local_dataset_records r ON r.record_hash=w.record_hash`;
    const row=this.database.get<{payload:string}>(`SELECT json_remove(r.payload,'$.workspace.files') AS payload FROM ${from} WHERE ${where}`,params);
    if(!row)return null;
    const listing=LocalDatasetListingSchema.parse(hydrateLocalDatasetMetadata(this.database,row.payload));
    const {paths,policyPaths}=localDatasetProjectionPaths(listing.workspace.draft,taskIds);
    const publicPaths=[...policyPaths],selectedPaths=[...paths];
    const excluded=publicPaths.length ? `json_extract(file.value,'$.path') NOT IN (${publicPaths.map(()=>"?").join(",")})` : "1";
    const included=selectedPaths.length ? ` OR json_extract(file.value,'$.path') IN (${selectedPaths.map(()=>"?").join(",")})` : "";
    const files=this.database.all<{payload:string}>(`SELECT file.value AS payload FROM ${from},json_each(r.payload,'$.workspace.files') file WHERE ${where} AND (${excluded}${included})`,[...params,...publicPaths,...selectedPaths])
      .map(file=>TasksetDraftWorkspaceFileSchema.parse(hydrateLocalDatasetFile(this.database,JSON.parse(file.payload))));
    const sourceWorkspaceHash=listing.workspace.contentHash;
    const workspace=projectLocalDatasetWorkspace({...listing.workspace,files},taskIds);
    return {record:LocalDatasetRecordSchema.parse({...listing,workspace}),sourceWorkspaceHash};
  }

  async recoverLocalDatasetOperation(operationId: string, requestHash: string): Promise<LocalDatasetRecord | null> {
    await this.ready; await this.writeQueue;
    const row = this.database.get<{request_hash:string;payload:string}>("SELECT w.request_hash,r.payload FROM local_dataset_operations w JOIN local_dataset_records r ON r.record_hash=w.record_hash WHERE w.operation_id=?", [operationId]);
    if (!row) return null;
    if (row.request_hash !== requestHash) throw new Error("Dataset operation ID was reused with different input.");
    return hydrateLocalDatasetRecord(this.database,row.payload);
  }

  async saveLocalDataset(input: {record: LocalDatasetRecord; expectedRevision: number; operationId: string; requestHash: string}): Promise<LocalDatasetRecord> {
    const record = LocalDatasetRecordSchema.parse(input.record);
    validateTasksetDraftWorkspace(record.workspace,Number.POSITIVE_INFINITY);
    if (record.workspace.draft.profileId !== record.ownerId || record.workspace.draft.modelScope !== null) throw new Error("Independent local Dataset ownership cannot change.");
    await this.ready;
    const write = this.writeQueue.then(() => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const prior = this.database.get<{request_hash:string;payload:string}>("SELECT w.request_hash,r.payload FROM local_dataset_operations w JOIN local_dataset_records r ON r.record_hash=w.record_hash WHERE w.operation_id=?", [input.operationId]);
        if (prior) {
          if (prior.request_hash !== input.requestHash) throw new Error("Dataset operation ID was reused with different input.");
          const recovered=hydrateLocalDatasetRecord(this.database,prior.payload);
          this.database.exec("COMMIT");
          return recovered;
        }
        const id = record.workspace.draft.id;
        const row = this.database.get<{revision:number;payload:string}>("SELECT w.revision,r.payload FROM local_dataset_workspaces w JOIN local_dataset_records r ON r.record_hash=w.record_hash WHERE w.id=?", [id]);
        if ((row?.revision ?? 0) !== input.expectedRevision) throw new Error("Dataset changed. Reload its saved revision before editing.");
        if (record.workspace.draft.revision !== input.expectedRevision + 1) throw new Error("Dataset revisions must advance once per saved edit.");
        if (row) {
          const current = hydrateLocalDatasetRecord(this.database,row.payload);
          if (current.ownerId !== record.ownerId || current.projectId !== record.projectId || current.workspace.draft.createdAt !== record.workspace.draft.createdAt) throw new Error("Dataset ownership and origin cannot change.");
          // Sync receipts may settle between reading and saving an authored
          // edit. The current server-owned link wins without rejecting the edit
          // or restoring an older receipt or disconnected destination.
          record.sync = current.sync;
        }
        const hash = retainLocalDatasetRecord(this.database,record);
        this.database.run("INSERT INTO local_dataset_workspaces(id,revision,record_hash,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record_hash=excluded.record_hash,updated_at=excluded.updated_at", [id, record.workspace.draft.revision, hash, record.workspace.draft.updatedAt]);
        this.database.run("INSERT INTO local_dataset_versions(id,revision,record_hash) VALUES(?,?,?)", [id, record.workspace.draft.revision, hash]);
        this.database.run("INSERT INTO local_dataset_operations(operation_id,request_hash,record_hash) VALUES(?,?,?)", [input.operationId, input.requestHash, hash]);
        this.database.exec("COMMIT"); this.datasetListings.delete(id); return record;
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    });
    this.writeQueue = write.then(() => undefined, () => undefined); return write;
  }

  /** Check/sync metadata CAS does not change the authored revision or bytes. */
  async updateLocalDatasetMetadata(id: string, expectedHash: string, update: (current: LocalDatasetRecord) => LocalDatasetRecord): Promise<LocalDatasetRecord> {
    await this.ready;
    const write = this.writeQueue.then(() => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.database.get<{payload:string}>("SELECT r.payload FROM local_dataset_workspaces w JOIN local_dataset_records r ON r.record_hash=w.record_hash WHERE w.id=?", [id]);
        if (!row) throw new Error("Local Dataset was not found.");
        const current = hydrateLocalDatasetRecord(this.database,row.payload);
        if (contentHash(current) !== expectedHash) throw new Error("Dataset state changed. Retry against its latest saved state.");
        const next = LocalDatasetRecordSchema.parse(update(current));
        if (next.ownerId !== current.ownerId || next.projectId !== current.projectId || next.workspace.contentHash !== current.workspace.contentHash) throw new Error("Metadata updates cannot edit Dataset bytes or ownership.");
        const hash=retainLocalDatasetRecord(this.database,next);
        this.database.run("UPDATE local_dataset_workspaces SET record_hash=? WHERE id=?", [hash, id]);
        this.database.run("UPDATE local_dataset_versions SET record_hash=? WHERE id=? AND revision=?", [hash, id, next.workspace.draft.revision]);
        this.database.exec("COMMIT"); this.datasetListings.delete(id); return next;
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    });
    this.writeQueue = write.then(() => undefined, () => undefined); return write;
  }

  async linkChatResource(sessionId: string, turnId: string, input: ChatResourceSummary): Promise<void> {
    const value = ChatResourceSummarySchema.parse(input);
    await this.upsertPayload("INSERT INTO chat_resource_links(session_id,turn_id,kind,resource_id,revision,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,turn_id,kind,resource_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload WHERE excluded.revision>=chat_resource_links.revision",
      [sessionId, turnId, value.kind, value.id, value.revision, JSON.stringify(value)]);
  }

  async chatResourceLinks(query: {sessionId?:string; kind?:string; id?:string}): Promise<{sessionId:string;turnId:string;summary:ChatResourceSummary}[]> {
    await this.ready; await this.writeQueue;
    const conditions: string[] = [], args: string[] = [];
    if (query.sessionId) { conditions.push("session_id=?"); args.push(query.sessionId); }
    if (query.kind) { conditions.push("kind=?"); args.push(query.kind); }
    if (query.id) { conditions.push("resource_id=?"); args.push(query.id); }
    return this.database.all<{session_id:string;turn_id:string;payload:string}>(`SELECT session_id,turn_id,payload FROM chat_resource_links${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}`, args)
      .map(row => ({sessionId:row.session_id,turnId:row.turn_id,summary:ChatResourceSummarySchema.parse(JSON.parse(row.payload))}));
  }
}
