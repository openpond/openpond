import {z} from "zod";
import { contentHash } from "@openpond/harness";
import { LocalDatasetRequestSchema, LocalDatasetRecordSchema, type LocalDatasetRecord, type ChatResourceSummary, type LocalDatasetCheck } from "@openpond/contracts";
import { createTasksetDraft, createTasksetDraftWorkspace, saveTasksetDraftWorkspaceDocument, saveTasksetDraftWorkspaceFile, TasksetDraftSchema, type TasksetDraftWorkspace } from "openpond-sdk/taskset-drafts";
import { TasksetDraftFileMutationSchema } from "openpond-sdk/model-taskset-authoring";
import { compileTasksetDraftWorkspace } from "openpond-sdk/dataset-workspaces";
import { captureTasksetDraftWorkspace } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import { cacheTasksetPackage } from "./taskset-package-files.js";
import { localGraderSummaries } from "./local-grader-resources.js";
import { checkLocalDatasetGraders } from "./local-dataset-checks.js";
import { checkCapturedDatasetSources } from "./chat-dataset-source-checks.js";

export function localDatasetSummary(record: LocalDatasetRecord): ChatResourceSummary {
  const {draft} = record.workspace;
  const checks = record.checks.filter(c => c.workspaceHash === record.workspace.contentHash);
  return {kind:"dataset",id:draft.id,revision:draft.revision,name:draft.name || "Untitled dataset",state:record.packageHash ? "Runnable" : "Saved draft",
    taskCount:draft.datasetArtifact?.rowCount ?? draft.tasks.length,graderCount:draft.graders.length,
    checkState:checks.length ? checks.map(c => `${c.kind}: ${c.status} (${c.checked}/${c.total})`).join(" · ") : record.checks.length ? "Checks stale" : "Not checked",
    syncState:record.sync ? record.sync.paused ? "Paused" : record.sync.acknowledgedHash === record.workspace.contentHash && record.sync.status === "synced" ? "Synced" : record.sync.status === "synced" ? "Sync pending" : record.sync.status : "Local",
    rows:draft.tasks.slice(0,3).map(t => ({id:t.id,label:typeof t.input.prompt === "string" ? t.input.prompt : JSON.stringify(t.input),detail:draft.graders.map(g => g.label).join(", ")}))};
}

export function createLocalDatasetService(deps: {store:SqliteStore;home:string;onSaved?:(record:LocalDatasetRecord)=>void;
  sourceAction?:(action:string,payload:Record<string,unknown>,ownerId:string)=>Promise<unknown>;
  syncAction?:(action:string,record:LocalDatasetRecord,payload:Record<string,unknown>)=>Promise<LocalDatasetRecord>;
}) {
  async function read(id:string, revision?:number) {
    const record = await deps.store.readLocalDataset(id,revision);
    if (!record || record.ownerId !== await deps.store.localResourceOwnerId()) throw new Error("Local Dataset was not found.");
    return record;
  }
  function compile(record:LocalDatasetRecord) {
    return compileTasksetDraftWorkspace({workspace:record.workspace,preparation:null,adapterId:"openpond-desktop-taskset-authoring-v1",now:record.workspace.draft.updatedAt});
  }
  async function packageDataset(id:string,revision?:number) {
    let record = await read(id,revision); const value = compile(record); await cacheTasksetPackage(deps.home,value);
    const latest=await read(id);
    if(latest.workspace.contentHash===record.workspace.contentHash && latest.packageHash!==value.contentHash) {
      try {record=await deps.store.updateLocalDatasetMetadata(id,contentHash(latest),current=>({...current,packageHash:value.contentHash}));}
      catch(error){if(!(error instanceof Error) || !error.message.startsWith("Dataset state changed."))throw error;}
    }
    return {record,package:value};
  }
  async function request(raw:unknown,signal?:AbortSignal) {
    const input = LocalDatasetRequestSchema.parse(raw), ownerId = await deps.store.localResourceOwnerId();
    if (input.action === "schema") {
      const section=z.enum(["task","grader","fixture","draft","file"]).parse(input.payload.kind ?? "task");
      const schema=section === "task" ? TasksetDraftSchema.shape.tasks.unwrap().element : section === "grader" ? TasksetDraftSchema.shape.graders.unwrap().element : section === "fixture" ? TasksetDraftSchema.shape.graderFixtures.unwrap().element : section === "file" ? TasksetDraftFileMutationSchema : TasksetDraftSchema;
      return {kind:section,schema:z.toJSONSchema(schema),...(section === "grader" ? {example:{id:"exact-answer",version:"1",label:"Exact answer",kind:"content",weight:1,hardGate:true,rewardEligible:false,privileged:true,config:{operator:"final_answer_equals_expected"},metadata:{}}} : {})};
    }
    if (input.action === "list") return Promise.all((await deps.store.listLocalDatasets()).map(async record => ({...localDatasetSummary(record),projectId:record.projectId})));
    if (input.action === "inspect_source" || input.action === "import_source") {
      if (!deps.sourceAction) throw new Error("This Dataset source adapter is unavailable.");
      return deps.sourceAction(input.action,input.payload,ownerId);
    }
    if (input.action === "related_chats") {
      const kind=input.payload.kind;
      if(kind !== undefined && !["dataset","grader","experiment"].includes(String(kind)))throw new Error("Select a supported resource kind.");
      const links=await deps.store.chatResourceLinks({kind:typeof kind==="string" ? kind : "dataset",id:input.id});
      const unique=[...new Set(links.map(link=>link.sessionId))];
      return (await Promise.all(unique.map(id=>deps.store.getSession(id)))).filter(session=>session && !session.systemKind && session.workspaceKind!=="sandbox").map(session=>({id:session!.id,title:session!.title}));
    }
    const intentHash = contentHash(input);
    if (["create","save","file","import","save_grader","check_sources"].includes(input.action)) {
      if (!input.operationId) throw new Error("A stable operationId is required. Reuse it after an uncertain response.");
      const prior = await deps.store.recoverLocalDatasetOperation(input.operationId,intentHash);
      if (prior) return {record:prior,summary:localDatasetSummary(prior),summaries:localGraderSummaries(prior)};
      const timestamp = new Date().toISOString();
      let record:LocalDatasetRecord;
      if (input.action === "create" || input.action === "import") {
        const id = `dataset-${contentHash([ownerId,input.operationId]).slice(0,40)}`;
        let workspace:TasksetDraftWorkspace;
        if (input.action === "import") {
          if (typeof input.payload.path !== "string") throw new Error("Import requires a package folder path.");
          const captured = await captureTasksetDraftWorkspace({directory:input.payload.path,teamId:ownerId,datasetId:id,expectedRevision:0});
          workspace = captured.workspace;
        } else {
          const draft = createTasksetDraft({profileId:ownerId,id,name:typeof input.payload.name === "string" ? input.payload.name : "",now:timestamp});
          workspace = createTasksetDraftWorkspace({schemaVersion:"openpond.tasksetDraftWorkspace.v1",draft:{...draft,...input.payload.draft as object,id,profileId:ownerId,modelScope:null,revision:1,status:"draft",publishedTasksetRef:null,createdAt:timestamp,updatedAt:timestamp},files:Array.isArray(input.payload.files) ? input.payload.files : []});
        }
        record = LocalDatasetRecordSchema.parse({schemaVersion:"openpond.localDataset.v1",ownerId,projectId:typeof input.payload.projectId === "string" ? input.payload.projectId : null,workspace,checks:[],packageHash:null,sync:null});
      } else {
        if (!input.id || input.expectedRevision === undefined) throw new Error("Editing requires a Dataset ID and expectedRevision.");
        const current = await read(input.id);
        let patch=input.payload.draft as object;
        if(input.action==="check_sources")patch={sourceRefs:checkCapturedDatasetSources(current.workspace)};
        if(input.action==="save_grader") {
          const grader=TasksetDraftSchema.shape.graders.unwrap().element.parse(input.payload.grader);
          const graders=current.workspace.draft.graders.filter(existing=>existing.id!==grader.id);
          const index=current.workspace.draft.graders.findIndex(existing=>existing.id===grader.id);
          graders.splice(index<0 ? graders.length : index,0,grader);
          patch={graders,...Array.isArray(input.payload.fixtures) ? {graderFixtures:input.payload.fixtures} : {}};
        }
        const workspace = input.action === "file" ? saveTasksetDraftWorkspaceFile({workspace:current.workspace,mutation:TasksetDraftFileMutationSchema.parse({...input.payload,draftId:input.id,expectedDraftRevision:input.expectedRevision}),now:timestamp}) :
          saveTasksetDraftWorkspaceDocument({workspace:current.workspace,expectedDraftRevision:input.expectedRevision,draft:{...current.workspace.draft,...patch},now:timestamp});
        record = {...current,workspace,packageHash:null};
      }
      signal?.throwIfAborted();
      const saved = await deps.store.saveLocalDataset({record,expectedRevision:input.action === "create" || input.action === "import" ? 0 : input.expectedRevision!,operationId:input.operationId,requestHash:intentHash});
      deps.onSaved?.(saved); return {record:saved,summary:localDatasetSummary(saved),summaries:localGraderSummaries(saved)};
    }
    if (!input.id) throw new Error("A Dataset ID is required.");
    const record = await read(input.id, ["read","read_grader","list_graders"].includes(input.action) && input.expectedRevision ? input.expectedRevision : undefined);
    if(input.action==="list_graders")return {summaries:localGraderSummaries(record)};
    if(input.action==="read_grader") {
      const summary=localGraderSummaries(record).find(summary=>summary.graderId===input.payload.graderId);
      if(!summary)throw new Error("The saved grader was not found.");
      return {record,summary,grader:record.workspace.draft.graders.find(grader=>grader.id===summary.graderId)};
    }
    if (input.action === "read") return {record,summary:localDatasetSummary(record)};
    if (["upload","sync","pause_sync","disconnect_sync","publish"].includes(input.action)) {
      if(input.expectedRevision !== record.workspace.draft.revision)throw new Error("Cloud actions require the exact current saved expectedRevision.");
      if (!deps.syncAction) throw new Error("Cloud Dataset synchronization is unavailable.");
      const updated = await deps.syncAction(input.action,record,input.payload); return {record:updated,summary:localDatasetSummary(updated)};
    }
    if (input.expectedRevision !== record.workspace.draft.revision) throw new Error("Checks and packaging require the exact saved expectedRevision.");
    if(input.action==="test_grader" && !record.workspace.draft.graders.some(grader=>grader.id===input.payload.graderId))throw new Error("The saved grader was not found.");
    let value:ReturnType<typeof compile> | null = null;
    let check:LocalDatasetCheck = {kind:"structure",revision:record.workspace.draft.revision,workspaceHash:record.workspace.contentHash,status:"passed",checked:record.workspace.draft.tasks.length,total:record.workspace.draft.datasetArtifact?.rowCount ?? record.workspace.draft.tasks.length,checkedAt:new Date().toISOString(),issues:[]};
    try { value = compile(record); await cacheTasksetPackage(deps.home,value); }
    catch (error) { check = {...check,status:"failed",issues:[{code:"package_invalid",message:error instanceof Error ? error.message : "Package validation failed."}]}; }
    if (["check_graders","test_grader"].includes(input.action) && value) check = await checkLocalDatasetGraders(record,value,signal,input.action==="test_grader" ? input.payload.graderId as string : undefined);
    const updated = await deps.store.updateLocalDatasetMetadata(input.id,contentHash(record),current => ({...current,packageHash:value?.contentHash ?? null,checks:[...current.checks.filter(c => c.kind !== check.kind),check]}));
    return {record:updated,summary:input.action==="test_grader" ? localGraderSummaries(updated).find(summary=>summary.graderId===input.payload.graderId) : localDatasetSummary(updated),summaries:localGraderSummaries(updated),check,...(input.action === "package" && value ? {package:value} : {})};
  }
  return {request,read,packageDataset,compile};
}
