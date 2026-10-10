import { contentHash } from "@openpond/harness";
import { createTasksetDraftWorkspace } from "openpond-sdk/taskset-drafts";
import { OpenPondDatasetWorkspaceClient } from "openpond-sdk/dataset-workspaces";
import type { LocalDatasetRecord } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";

export function createLocalDatasetSync(deps:{store:SqliteStore;access:()=>Promise<{apiBaseUrl:string;token:string;actorId:string;teamId:string}>;fetch?:typeof fetch}) {
  const active = new Map<string,Promise<LocalDatasetRecord>>();
  const publications=new Map<string,{hash:string;work:Promise<LocalDatasetRecord>}>();
  const lastVerified = new Map<string,number>();
  const shutdown = new AbortController();
  const transport:typeof fetch = (url,init) => (deps.fetch ?? fetch)(url,{...init,signal:AbortSignal.any([shutdown.signal,AbortSignal.timeout(30_000),...init?.signal ? [init.signal] : []])});
  let closed = false;
  async function current(id:string) { const value = await deps.store.readLocalDataset(id); if (!value) throw new Error("Local Dataset was not found."); return value; }
  async function change(id:string,update:(record:LocalDatasetRecord)=>LocalDatasetRecord) {
    // A simultaneous local edit must be preserved while an older upload settles.
    for (let attempt=0;attempt<5;attempt++) {
      const value = await current(id);
      try { return await deps.store.updateLocalDatasetMetadata(id,contentHash(value),update); }
      catch (error) { if (!(error instanceof Error) || !error.message.startsWith("Dataset state changed.")) throw error; }
    }
    throw new Error("Dataset kept changing while synchronization settled. Retry synchronization.");
  }
  async function synchronize(id:string) {
    let record = await current(id);
    while (!closed && record.sync && !record.sync.paused && record.sync.status !== "conflict") {
      const link = record.sync;
      const access = await deps.access();
      if (access.actorId !== link.actorId || access.teamId !== link.teamId || new URL(access.apiBaseUrl).origin !== link.apiOrigin) {
        return change(id,r => ({...r,sync:r.sync ? {...r.sync,status:"retry",error:"Select the account and workspace linked to this Dataset before synchronizing."} : null}));
      }
      const client = new OpenPondDatasetWorkspaceClient({baseUrl:access.apiBaseUrl,apiKey:access.token,teamId:link.teamId,fetch:transport});
      if(link.beginVersionOperationId) {
        const receipt=(await client.operationResult(link.beginVersionOperationId,{datasetId:link.datasetId,kind:"begin_version"}))?.receipt ?? await client.beginVersion(link.datasetId,{operationId:link.beginVersionOperationId,expectedRevision:link.remoteRevision});
        record=await change(id,r=>({...r,sync:r.sync ? {...r.sync,remoteRevision:receipt.revision,remoteHash:receipt.workspace.contentHash,beginVersionOperationId:null,status:"pending"} : null}));continue;
      }
      if(link.publicationIntent) {
        const intent=link.publicationIntent;
        const receipt=(await client.operationResult(intent.operationId,{datasetId:link.datasetId,kind:"publish"}))?.receipt ?? await client.publish(link.datasetId,{operationId:intent.operationId,expectedRevision:intent.expectedRevision,workspaceHash:intent.workspaceHash,packageHash:intent.packageHash});
        record=await change(id,r=>({...r,sync:r.sync ? {...r.sync,remoteRevision:receipt.revision,remoteHash:receipt.workspace.contentHash,publicationIntent:null,status:intent.localHash===r.workspace.contentHash ? "synced" : "pending"} : null}));continue;
      }
      if (link.acknowledgedHash === record.workspace.contentHash && !link.pendingWorkspace) {
        const remote = await client.get(link.datasetId);
        lastVerified.set(id,Date.now());
        if (remote.revision !== link.remoteRevision || remote.workspace.contentHash !== link.remoteHash) return change(id,r => ({...r,sync:r.sync ? {...r.sync,status:"conflict",error:"The cloud Dataset changed. Both copies are retained."} : null}));
        return change(id,r => ({...r,sync:r.sync ? {...r.sync,status:"synced",error:null} : null}));
      }
      let previousPublication:LocalDatasetRecord["workspace"]["draft"]["publishedTasksetRef"]=null;
      if(!link.pendingWorkspace && link.remoteRevision) {
        const remote=await client.get(link.datasetId);
        if(remote.revision!==link.remoteRevision || remote.workspace.contentHash!==link.remoteHash)return change(id,r=>({...r,sync:r.sync ? {...r.sync,status:"conflict",error:"The cloud Dataset changed. Both copies are retained."} : null}));
        previousPublication=remote.workspace.draft.publishedTasksetRef;
        if(remote.workspace.draft.status==="published") {
          const operationId=`begin-${contentHash([id,link.apiOrigin,link.remoteRevision,link.remoteHash]).slice(0,56)}`;
          record=await change(id,r=>({...r,sync:r.sync ? {...r.sync,beginVersionOperationId:operationId,status:"syncing"} : null}));continue;
        }
      }
      if (!link.pendingWorkspace) {
        const pending = createTasksetDraftWorkspace({schemaVersion:record.workspace.schemaVersion,files:record.workspace.files,
          draft:{...record.workspace.draft,id:link.datasetId,profileId:link.teamId,revision:link.remoteRevision+1,status:"draft",publishedTasksetRef:previousPublication}});
        const operationId = `sync-${contentHash([id,link.apiOrigin,link.teamId,link.remoteRevision,record.workspace.contentHash]).slice(0,56)}`;
        record = await change(id,r => {
          if (!r.sync || r.sync.paused) return r;
          return {...r,sync:{...r.sync,pendingWorkspace:pending,pendingLocalHash:record.workspace.contentHash,operationId,status:"syncing",error:null}};
        });
        if (!record.sync?.pendingWorkspace || record.sync.paused) return record;
      }
      const retained = record.sync!;
      const pending = retained.pendingWorkspace!;
      const operationId = retained.operationId!;
      try {
        const recovered = await client.operationResult(operationId,{datasetId:retained.datasetId,kind:retained.remoteRevision ? "save" : "create"});
        if (!recovered && retained.remoteRevision) {
          const remote = await client.get(retained.datasetId);
          if (remote.revision !== retained.remoteRevision || remote.workspace.contentHash !== retained.remoteHash || remote.workspace.draft.status !== "draft") {
            // Its original CAS can no longer commit once the remote revision
            // advanced. Release only this undispatched pending upload.
            return change(id,r => ({...r,sync:r.sync ? {...r.sync,status:"conflict",pendingWorkspace:null,pendingLocalHash:null,operationId:null,error:"The cloud Dataset changed. Both copies are retained; disconnect this link to choose a new destination."} : null}));
          }
        }
        const receipt = recovered?.receipt ?? await client.save({operationId,expectedRevision:retained.remoteRevision,workspace:pending});
        if (receipt.workspace.contentHash !== pending.contentHash) throw new Error("Cloud receipt differs from retained upload bytes.");
        // Restore local identity/revision to compare the acknowledged saved bytes.
        const localHash = retained.pendingLocalHash!;
        record = await change(id,r => {
          if (!r.sync || r.sync.operationId !== operationId) return r;
          const state = {...r.sync,remoteRevision:receipt.revision,remoteHash:receipt.workspace.contentHash,acknowledgedHash:localHash,pendingWorkspace:null,pendingLocalHash:null,operationId:null,error:null};
          return {...r,sync:{...state,status:r.sync.paused ? "paused" : localHash === r.workspace.contentHash ? "synced" : "pending"}};
        });
      } catch (error) {
        return change(id,r => ({...r,sync:r.sync ? {...r.sync,status:r.sync.paused ? "paused" : "retry",error:error instanceof Error ? error.message.slice(0,1000) : "Cloud synchronization failed."} : null}));
      }
    }
    return record;
  }
  function sync(id:string) {
    const prior = active.get(id); if (prior) return prior;
    const work = synchronize(id).catch(error => change(id,r=>({...r,sync:r.sync ? {...r.sync,status:r.sync.paused ? "paused" : "retry",error:error instanceof Error ? error.message.slice(0,1000) : "Cloud synchronization failed."} : null}))).finally(() => active.delete(id)); active.set(id,work); return work;
  }
  async function performAction(action:string,record:LocalDatasetRecord,payload:Record<string,unknown>):Promise<LocalDatasetRecord> {
    const id = record.workspace.draft.id;
    if (action === "disconnect_sync") {
      if (active.has(id) || record.sync?.pendingWorkspace || record.sync?.publicationIntent || record.sync?.beginVersionOperationId) throw new Error("Pause and settle the retained upload before disconnecting.");
      return change(id,r => ({...r,sync:null}));
    }
    if (action === "pause_sync") return change(id,r => ({...r,sync:r.sync ? {...r.sync,paused:payload.paused !== false,status:payload.paused !== false ? "paused" : "pending"} : null}));
    if (!record.sync) {
      const access = await deps.access();
      record = await change(id,r => ({...r,sync:r.sync ?? {apiOrigin:new URL(access.apiBaseUrl).origin,actorId:access.actorId,teamId:access.teamId,datasetId:`dataset-${contentHash([r.ownerId,id,access.actorId,access.teamId]).slice(0,40)}`,remoteRevision:0,acknowledgedHash:null,remoteHash:null,pendingLocalHash:null,paused:false,status:"pending",error:null,operationId:null,pendingWorkspace:null}}));
    }
    if(action!=="publish")return sync(id);
    const priorPublication=publications.get(id);
    if(priorPublication) {if(priorPublication.hash===record.workspace.contentHash)return priorPublication.work;await priorPublication.work;return performAction(action,record,payload);}
    let work!:Promise<LocalDatasetRecord>;
    work=(async()=>{
      await sync(id);
      active.set(id,work);
      const currentRecord=await current(id),link=currentRecord.sync;
      if(!link || link.paused || link.status!=="synced" || link.acknowledgedHash!==record.workspace.contentHash || currentRecord.workspace.contentHash!==record.workspace.contentHash)throw new Error("Publication requires this exact saved revision to be acknowledged in its linked workspace.");
      const access=await deps.access();
      if(access.actorId!==link.actorId || access.teamId!==link.teamId || new URL(access.apiBaseUrl).origin!==link.apiOrigin)throw new Error("Select the linked cloud account and workspace before publishing.");
      const client=new OpenPondDatasetWorkspaceClient({baseUrl:access.apiBaseUrl,apiKey:access.token,teamId:link.teamId,fetch:transport});
      const remote=await client.get(link.datasetId);
      if(remote.revision!==link.remoteRevision || remote.workspace.contentHash!==link.remoteHash)throw new Error("The cloud Dataset changed before publication. Synchronize and inspect the conflict.");
      if(remote.workspace.draft.status==="published")return currentRecord;
      const validation=await client.validate(link.datasetId,link.remoteRevision);
      if(validation.workspaceHash!==link.remoteHash)throw new Error("Cloud validation differs from the acknowledged workspace.");
      const operationId=`publish-${contentHash([id,link.apiOrigin,link.remoteRevision,validation.packageHash]).slice(0,56)}`;
      await change(id,r=>({...r,sync:r.sync ? {...r.sync,publicationIntent:{operationId,expectedRevision:link.remoteRevision,workspaceHash:link.remoteHash!,packageHash:validation.packageHash,localHash:record.workspace.contentHash},status:"syncing"} : null}));
      return synchronize(id);
    })().catch(async error=>{await change(id,r=>({...r,sync:r.sync ? {...r.sync,status:r.sync.paused ? "paused" : "retry",error:error instanceof Error ? error.message : "Publication failed."} : null}));throw error;}).finally(()=>{publications.delete(id);if(active.get(id)===work)active.delete(id);});
    publications.set(id,{hash:record.workspace.contentHash,work});return work;
  }
  const timer = setInterval(() => { if (!closed) void deps.store.listLocalDatasets().then(records => Promise.allSettled(records.filter(r => r.sync && !r.sync.paused && r.sync.status !== "conflict" && (r.sync.acknowledgedHash !== r.workspace.contentHash || r.sync.pendingWorkspace || r.sync.publicationIntent || r.sync.beginVersionOperationId || Date.now()-(lastVerified.get(r.workspace.draft.id) ?? 0)>60_000)).map(r => sync(r.workspace.draft.id)))).catch(() => {}); },10_000);
  timer.unref();
  return {action:performAction,onSaved:(record:LocalDatasetRecord) => {if (record.sync && !record.sync.paused) void sync(record.workspace.draft.id).catch(() => {});},close:async()=>{closed=true;shutdown.abort(new Error("Local Dataset synchronization stopped."));clearInterval(timer);await Promise.allSettled([...active.values(),...Array.from(publications.values(),value=>value.work)]);}};
}
