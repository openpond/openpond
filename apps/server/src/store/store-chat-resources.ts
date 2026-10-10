import { randomUUID } from "node:crypto";
import { contentHash } from "@openpond/harness";
import { LocalDatasetRecordSchema, ChatResourceSummarySchema, type LocalDatasetRecord, type ChatResourceSummary } from "@openpond/contracts";
import { validateTasksetDraftWorkspace } from "openpond-sdk/taskset-drafts";
import { SqliteStoreDomain } from "./store-domain.js";

/** This installation owns local resources independently of account/workspace
 * selection. Hosted destinations retain their own explicit authorization. */
export class SqliteChatResourceStore extends SqliteStoreDomain {
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
    return this.getParsedPayload(revision === undefined ? "SELECT payload FROM local_dataset_workspaces WHERE id=?" : "SELECT payload FROM local_dataset_versions WHERE id=? AND revision=?",
      revision === undefined ? [id] : [id, revision], LocalDatasetRecordSchema.parse);
  }

  async readLocalDatasetByWorkspaceHash(id:string,workspaceHash:string):Promise<LocalDatasetRecord|null> {
    return this.getParsedPayload("SELECT payload FROM local_dataset_versions WHERE id=? AND json_extract(payload,'$.workspace.contentHash')=?",
      [id,workspaceHash],LocalDatasetRecordSchema.parse);
  }

  async listLocalDatasets(): Promise<LocalDatasetRecord[]> {
    return this.listParsedPayloads("SELECT payload FROM local_dataset_workspaces ORDER BY updated_at DESC", [], LocalDatasetRecordSchema.parse);
  }

  async recoverLocalDatasetOperation(operationId: string, requestHash: string): Promise<LocalDatasetRecord | null> {
    await this.ready; await this.writeQueue;
    const row = this.database.get<{request_hash:string;payload:string}>("SELECT request_hash,payload FROM local_dataset_operations WHERE operation_id=?", [operationId]);
    if (!row) return null;
    if (row.request_hash !== requestHash) throw new Error("Dataset operation ID was reused with different input.");
    return LocalDatasetRecordSchema.parse(JSON.parse(row.payload));
  }

  async saveLocalDataset(input: {record: LocalDatasetRecord; expectedRevision: number; operationId: string; requestHash: string}): Promise<LocalDatasetRecord> {
    const record = LocalDatasetRecordSchema.parse(input.record);
    validateTasksetDraftWorkspace(record.workspace);
    if (record.workspace.draft.profileId !== record.ownerId || record.workspace.draft.modelScope !== null) throw new Error("Independent local Dataset ownership cannot change.");
    await this.ready;
    const write = this.writeQueue.then(() => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const prior = this.database.get<{request_hash:string;payload:string}>("SELECT request_hash,payload FROM local_dataset_operations WHERE operation_id=?", [input.operationId]);
        if (prior) {
          if (prior.request_hash !== input.requestHash) throw new Error("Dataset operation ID was reused with different input.");
          this.database.exec("COMMIT");
          return LocalDatasetRecordSchema.parse(JSON.parse(prior.payload));
        }
        const id = record.workspace.draft.id;
        const row = this.database.get<{revision:number;payload:string}>("SELECT revision,payload FROM local_dataset_workspaces WHERE id=?", [id]);
        if ((row?.revision ?? 0) !== input.expectedRevision) throw new Error("Dataset changed. Reload its saved revision before editing.");
        if (record.workspace.draft.revision !== input.expectedRevision + 1) throw new Error("Dataset revisions must advance once per saved edit.");
        if (row) {
          const current = LocalDatasetRecordSchema.parse(JSON.parse(row.payload));
          if (current.ownerId !== record.ownerId || current.projectId !== record.projectId || current.workspace.draft.createdAt !== record.workspace.draft.createdAt) throw new Error("Dataset ownership and origin cannot change.");
          // Sync receipts may settle between reading and saving an authored
          // edit. The current server-owned link wins without rejecting the edit
          // or restoring an older receipt or disconnected destination.
          record.sync = current.sync;
        }
        const payload = JSON.stringify(record);
        this.database.run("INSERT INTO local_dataset_workspaces(id,revision,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at", [id, record.workspace.draft.revision, payload, record.workspace.draft.updatedAt]);
        this.database.run("INSERT INTO local_dataset_versions(id,revision,payload) VALUES(?,?,?)", [id, record.workspace.draft.revision, payload]);
        this.database.run("INSERT INTO local_dataset_operations(operation_id,request_hash,payload) VALUES(?,?,?)", [input.operationId, input.requestHash, payload]);
        this.database.exec("COMMIT"); return record;
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
        const row = this.database.get<{payload:string}>("SELECT payload FROM local_dataset_workspaces WHERE id=?", [id]);
        if (!row) throw new Error("Local Dataset was not found.");
        const current = LocalDatasetRecordSchema.parse(JSON.parse(row.payload));
        if (contentHash(current) !== expectedHash) throw new Error("Dataset state changed. Retry against its latest saved state.");
        const next = LocalDatasetRecordSchema.parse(update(current));
        if (next.ownerId !== current.ownerId || next.projectId !== current.projectId || next.workspace.contentHash !== current.workspace.contentHash) throw new Error("Metadata updates cannot edit Dataset bytes or ownership.");
        this.database.run("UPDATE local_dataset_workspaces SET payload=? WHERE id=?", [JSON.stringify(next), id]);
        this.database.run("UPDATE local_dataset_versions SET payload=? WHERE id=? AND revision=?", [JSON.stringify(next), id, next.workspace.draft.revision]);
        this.database.exec("COMMIT"); return next;
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
