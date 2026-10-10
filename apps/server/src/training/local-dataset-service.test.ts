import { mkdtemp,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect,test } from "vitest";
import { contentHash } from "@openpond/harness";
import { compileTasksetDraftWorkspace } from "openpond-sdk/dataset-workspaces";
import { createTasksetDraftWorkspace,saveTasksetDraftWorkspaceDocument } from "openpond-sdk/taskset-drafts";
import { SqliteStore } from "../store/store.js";
import { createLocalDatasetService } from "./local-dataset-service.js";
import { createLocalDatasetSync } from "./local-dataset-sync.js";
import type { LocalDatasetRecord } from "@openpond/contracts";

// Failure story: an uncertain write must recover the exact saved revision,
// edits must preserve older bytes, and settling a cloud receipt must not block
// or roll back a simultaneous authored edit. No account is needed locally.
test("independent local drafts retain revisions, operation identity and concurrent sync state",async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),"openpond-chat-dataset-"));
  let store=new SqliteStore(home);
  try {
    let service=createLocalDatasetService({store,home});
    const input={action:"create",operationId:"create-local",payload:{name:"Local examples"}};
    const first=await service.request(input) as {record:LocalDatasetRecord};
    expect(first.record.workspace.draft.modelScope).toBeNull();
    expect((await service.request(input) as {record:LocalDatasetRecord}).record).toEqual(first.record);
    await expect(service.request({...input,payload:{name:"Different intent"}})).rejects.toThrow(/different input/);
    const id=first.record.workspace.draft.id;
    const checked=await service.request({action:"validate",id,expectedRevision:1}) as {record:LocalDatasetRecord};
    expect(checked.record.checks[0]?.status).toBe("failed");
    const sync={apiOrigin:"https://example.test",actorId:"actor",teamId:"team",datasetId:"remote",remoteRevision:1,
      acknowledgedHash:first.record.workspace.contentHash,remoteHash:"a".repeat(64),pendingLocalHash:null,paused:false,status:"synced" as const,error:null,operationId:null,pendingWorkspace:null};
    const latest=await store.readLocalDataset(id);
    await store.updateLocalDatasetMetadata(id,contentHash(latest),r=>({...r,sync}));
    const edit={...checked.record,workspace:saveTasksetDraftWorkspaceDocument({workspace:checked.record.workspace,expectedDraftRevision:1,
      draft:{...checked.record.workspace.draft,objective:"Still incomplete"},now:"2026-10-10T18:00:00.000Z"})};
    const saved=await store.saveLocalDataset({record:edit,expectedRevision:1,operationId:"edit-local",requestHash:contentHash(edit)});
    expect(saved.sync).toEqual(sync);
    expect(saved.checks[0]?.workspaceHash).not.toBe(saved.workspace.contentHash);
    expect((await service.read(id,1)).workspace).toEqual(first.record.workspace);
    await expect(store.saveLocalDataset({record:edit,expectedRevision:1,operationId:"stale-edit",requestHash:contentHash(edit)})).rejects.toThrow(/changed/);
    await store.prepareChatExperimentGroup("group","b".repeat(64),{pins:["exact"]});
    await expect(store.prepareChatExperimentGroup("group","c".repeat(64),{})).rejects.toThrow(/different inputs/);
    const owner=saved.ownerId;await store.close();store=new SqliteStore(home);service=createLocalDatasetService({store,home});
    expect(await store.localResourceOwnerId()).toBe(owner);
    expect((await service.request(input) as {record:LocalDatasetRecord}).record).toEqual(first.record);
    expect(await store.readChatExperimentGroup("group","b".repeat(64))).toEqual({pins:["exact"]});
  } finally {await store.close();await rm(home,{recursive:true,force:true});}
});

// Failure story: testing one grader must not execute or qualify its siblings.
// Checks of another grader can be retained only for the exact authored bytes;
// otherwise an edit could inherit a whole-dataset passed badge from old tests.
test("individual grader checks retain exact sibling scopes and invalidate them after an edit",async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),"openpond-grader-scope-"));const store=new SqliteStore(home);
  try {
    const service=createLocalDatasetService({store,home});
    const graders=["first","second"].map(id=>({id,version:"1",label:id,kind:"state",weight:1,hardGate:true,rewardEligible:false,privileged:true,config:{fields:["text"]},metadata:{}}));
    const fixtures=graders.flatMap(grader=>[true,false].map(good=>({id:`${grader.id}-${good}`,taskId:"one",label:good ? "positive" : "negative",output:{text:good ? "pond" : "wrong"},infrastructureError:null,expectedPassed:good,expectedRewardEligible:false,metadata:{graderIds:[grader.id]}})));
    const created=await service.request({action:"create",operationId:"scoped",payload:{name:"Scoped checks",draft:{objective:"Test each grader independently",graders,graderFixtures:fixtures,tasks:[{schemaVersion:"openpond.taskData.v1",id:"one",clusterKey:"one",split:"validation",input:{prompt:"Reply with pond."},expectedOutput:{text:"pond"},policyVisibleContext:{},privilegedContextRef:null,sourceRefs:[],tags:[],metadata:{}}]}}}) as {record:LocalDatasetRecord};
    const id=created.record.workspace.draft.id;
    const check=async(graderId:string,expectedRevision:number)=>(await service.request({action:"test_grader",id,expectedRevision,payload:{graderId}}) as {record:LocalDatasetRecord}).record.checks.find(check=>check.kind==="graders")!;
    const first=await check("first",1);
    expect(first).toMatchObject({status:"unavailable",checked:2,total:4});
    expect(first.scopes).toEqual(expect.arrayContaining([{graderId:"first",status:"passed",checked:2,total:2},{graderId:"second",status:"unavailable",checked:0,total:2}]));
    expect(await check("first",1)).toMatchObject({status:"unavailable",checked:2,total:4});
    const second=await check("second",1);
    expect(second).toMatchObject({status:"passed",checked:4,total:4});
    expect(second.scopes?.every(scope=>scope.status==="passed")).toBe(true);
    await service.request({action:"save",id,expectedRevision:1,operationId:"edited",payload:{draft:{objective:"Check the new revision"}}});
    const edited=await check("second",2);
    expect(edited).toMatchObject({status:"unavailable",checked:2,total:4});
    expect(edited.scopes).toEqual(expect.arrayContaining([{graderId:"first",status:"unavailable",checked:0,total:2},{graderId:"second",status:"passed",checked:2,total:2}]));
  } finally {await store.close();await rm(home,{recursive:true,force:true});}
});

// Failure story: a cloud server may commit an upload before its reply is lost.
// Restart must recover its receipt and upload a later edit exactly once, rather
// than create duplicate datasets or overwrite the original acknowledged bytes.
test("cloud sync recovers a lost upload reply and coalesces later saved revisions",async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),"openpond-chat-sync-"));const store=new SqliteStore(home);
  let actorId="actor";
  const access=async()=>({apiBaseUrl:"https://example.test",token:"test-token",actorId,teamId:"team"});
  let remote:Record<string,unknown>|null=null,lost=true,writes=0,publishes=0,begins=0,losePublish=true,loseBegin=true;
  const operations=new Map<string,unknown>();
  const transport:typeof fetch=async(url,init)=>{
    const target=new URL(String(url));
    if(target.pathname.includes("/operations/"))return Response.json(operations.get(decodeURIComponent(target.pathname.split("/").at(-1)!))??null);
    if(target.pathname.endsWith("/validate")) {
      const workspace=remote!.workspace as LocalDatasetRecord["workspace"];
      const value=compileTasksetDraftWorkspace({workspace,preparation:null,adapterId:"openpond-desktop-taskset-authoring-v1",now:workspace.draft.updatedAt});
      return Response.json({teamId:"team",datasetId:workspace.draft.id,revision:workspace.draft.revision,workspaceHash:workspace.contentHash,packageHash:value.contentHash,release:{id:value.taskset.id,revision:value.taskset.revision,contentHash:value.taskset.contentHash}});
    }
    if(target.pathname.endsWith("/publish") || target.pathname.endsWith("/begin-version")) {
      const body=JSON.parse(String(init!.body)) as {operationId:string;expectedRevision:number;packageHash?:string},prior=remote;
      const base=remote!.workspace as LocalDatasetRecord["workspace"];
      const publishing=target.pathname.endsWith("/publish");
      expect(body.expectedRevision).toBe(base.draft.revision);
      const value=compileTasksetDraftWorkspace({workspace:base,preparation:null,adapterId:"openpond-desktop-taskset-authoring-v1",now:base.draft.updatedAt});
      const ref={id:value.taskset.id,revision:value.taskset.revision,contentHash:value.taskset.contentHash};
      const workspace=createTasksetDraftWorkspace({schemaVersion:base.schemaVersion,files:base.files,draft:{...base.draft,revision:base.draft.revision+1,status:publishing ? "published" : "draft",publishedTasksetRef:publishing ? ref : base.draft.publishedTasksetRef}});
      remote={...remote,revision:workspace.draft.revision,workspace,publication:publishing ? {tasksetId:ref.id,release:ref,packageHash:value.contentHash} : remote!.publication};
      operations.set(body.operationId,{operationId:body.operationId,kind:publishing ? "publish" : "begin_version",requestHash:contentHash(body),receipt:remote,base:prior});
      if(publishing){publishes++;if(losePublish){losePublish=false;throw new Error("Publication reply lost");}}
      else{begins++;if(loseBegin){loseBegin=false;throw new Error("Begin version reply lost");}}
      return Response.json(remote);
    }
    if(init?.method==="PUT"){
      writes++;const body=JSON.parse(String(init.body)) as {operationId:string;workspace:LocalDatasetRecord["workspace"]};
      const prior=remote;
      remote={schemaVersion:"openpond.datasetWorkspaceReceipt.v1",teamId:"team",datasetId:body.workspace.draft.id,revision:body.workspace.draft.revision,workspace:body.workspace,publication:null};
      operations.set(body.operationId,{operationId:body.operationId,kind:prior?"save":"create",requestHash:contentHash(body),receipt:remote,base:prior});
      if(lost){lost=false;throw new Error("Reply lost after commit");}
      return Response.json(remote);
    }
    return Response.json(remote);
  };
  let sync=createLocalDatasetSync({store,access,fetch:transport});
  try {
    const service=createLocalDatasetService({store,home});
    const created=await service.request({action:"create",operationId:"source",payload:{name:"Cloud sync examples",draft:{objective:"Check exact answers",tasks:[{schemaVersion:"openpond.taskData.v1",id:"one",clusterKey:"one",split:"validation",input:{prompt:"Reply with pond."},expectedOutput:{text:"pond"},policyVisibleContext:{},privilegedContextRef:null,sourceRefs:[],tags:[],metadata:{}}],graders:[{id:"accuracy",version:"1",label:"Exact answer",kind:"content",weight:1,hardGate:true,rewardEligible:false,privileged:true,config:{operator:"final_answer_equals_expected"},metadata:{}}]}}}) as {record:LocalDatasetRecord};
    const id=created.record.workspace.draft.id;
    const failed=await sync.action("upload",created.record,{});
    expect(failed.sync?.status).toBe("retry");expect(writes).toBe(1);
    await sync.close();sync=createLocalDatasetSync({store,access,fetch:transport});
    const edit=createTasksetDraftWorkspace({schemaVersion:failed.workspace.schemaVersion,files:failed.workspace.files,draft:{...failed.workspace.draft,revision:2,objective:"A newer local edit"}});
    await store.saveLocalDataset({record:{...failed,workspace:edit},expectedRevision:1,operationId:"newer",requestHash:contentHash(edit)});
    const recovered=await sync.action("sync",(await store.readLocalDataset(id))!,{});
    expect(writes).toBe(2);expect(recovered.sync).toMatchObject({status:"synced",remoteRevision:2,acknowledgedHash:edit.contentHash,pendingWorkspace:null});
    expect((remote!.workspace as LocalDatasetRecord["workspace"]).draft.objective).toBe("A newer local edit");
    expect((await store.readLocalDataset(id,1))!.workspace.draft.objective).toBe("Check exact answers");
    await expect(sync.action("publish",recovered,{})).rejects.toThrow(/Publication reply lost/);
    await sync.close();sync=createLocalDatasetSync({store,access,fetch:transport});
    const published=await sync.action("publish",(await store.readLocalDataset(id))!,{});
    expect(publishes).toBe(1);expect(published.sync?.remoteRevision).toBe(3);
    const frozen=remote!.workspace as LocalDatasetRecord["workspace"];
    const newer=await service.request({action:"save",id,expectedRevision:2,operationId:"after-publication",payload:{draft:{objective:"An edit after immutable publication"}}}) as {record:LocalDatasetRecord};
    const interrupted=await sync.action("sync",newer.record,{});expect(interrupted.sync?.beginVersionOperationId).toBeTruthy();
    await sync.close();sync=createLocalDatasetSync({store,access,fetch:transport});
    const settled=await sync.action("sync",(await store.readLocalDataset(id))!,{});
    expect(begins).toBe(1);expect(writes).toBe(3);expect(settled.sync?.remoteRevision).toBe(5);expect(frozen.draft.status).toBe("published");
    expect(frozen.draft.objective).toBe("A newer local edit");
    actorId="changed-account";const fenced=await sync.action("sync",settled,{});expect(fenced.sync?.status).toBe("retry");expect(writes).toBe(3);actorId="actor";
    const diverged=remote!.workspace as LocalDatasetRecord["workspace"];
    const remoteEdit=createTasksetDraftWorkspace({schemaVersion:diverged.schemaVersion,files:diverged.files,draft:{...diverged.draft,revision:diverged.draft.revision+1,objective:"Remote edit"}});remote={...(remote as unknown as Record<string,unknown>),revision:remoteEdit.draft.revision,workspace:remoteEdit};
    const conflict=await sync.action("sync",(await store.readLocalDataset(id))!,{});expect(conflict.sync?.status).toBe("conflict");expect(writes).toBe(3);
    await sync.action("disconnect_sync",conflict,{});expect((await store.readLocalDataset(id))!.sync).toBeNull();
    expect((await store.readLocalDataset(id))!.workspace.draft.objective).toBe("An edit after immutable publication");
  } finally {await sync.close();await store.close();await rm(home,{recursive:true,force:true});}
});
