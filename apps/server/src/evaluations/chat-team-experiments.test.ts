import { expect, test, vi } from "vitest";
import type { ChatResourceSummary, LocalExperimentRecord, LocalExperimentResult } from "@openpond/contracts";
import { createChatTeamExperiments } from "./chat-team-experiments.js";

// The adapter must never turn a signed chat association into execution
// authority, or publish results after the existing team owner denies access.
test("team CLI attachment preserves canonical replies and revalidates owner access", async () => {
  const record = {
    id:"run",kind:"target",teamId:"team-a",ownerActorId:"actor-a",configurationHash:"a".repeat(64),
    configuration:{request:{name:"RFQ evaluation",taskset:{id:"rfq",revision:3,contentHash:"b".repeat(64)},population:[{taskId:"quote"}]}},
    model:{providerId:"codex",modelId:"model"},status:"completed",counts:{failed:0,unknown:0},usage:{costUsd:null},
    graders:[{id:"accuracy",version:"v2",contentHash:"c".repeat(64),name:"Accuracy"}],
  } as unknown as LocalExperimentRecord;
  const evidence = {execution:record,contentHash:"d".repeat(64),cases:[{receiptId:"case",taskId:"quote",seed:"0",status:"completed",error:null,output:"answer",grade:{gradingStatus:"scored",score:1,passed:true}}]} as unknown as LocalExperimentResult;
  let admitted = true, readable = true;
  const request=vi.fn(async()=>record);
  const read=vi.fn(async()=>{if(!readable)throw new Error("account changed");return record;});
  const result=vi.fn(async()=>evidence);
  const attach=vi.fn(async(_context:{sessionId:string;turnId:string},_resources:ChatResourceSummary[])=>{});
  const runtime=createChatTeamExperiments({service:{request,read,result},
    resolveInvocation:async()=>{if(!admitted)throw new Error("invalid context");return {sessionId:"chat",turnId:"turn"};},attach});
  expect(await runtime.request({teamId:"team-a",action:"run",payload:{},invocationToken:"signed"})).toBe(record);
  expect(request).toHaveBeenCalledWith({teamId:"team-a",action:"run",payload:{}});
  const resources=attach.mock.calls[0]![1];
  expect(resources).toMatchObject([
    {kind:"dataset",id:"rfq",revision:3,contentHash:"b".repeat(64),owner:{teamId:"team-a",actorId:"actor-a"}},
    {kind:"grader",graderId:"accuracy",contentHash:"c".repeat(64),rows:[]},
    {kind:"experiment",id:"run",datasetRevision:3,owner:{teamId:"team-a",actorId:"actor-a"},costUsd:null,score:1},
  ]);
  attach.mockClear(); read.mockClear(); request.mockClear();
  await runtime.request({teamId:"team-a",action:"list",payload:{},invocationToken:"signed"});
  expect(attach).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
  request.mockClear();admitted=false;
  await expect(runtime.request({teamId:"team-a",action:"run",payload:{},invocationToken:"bad"})).rejects.toThrow("invalid context");
  expect(request).not.toHaveBeenCalled();
  admitted=true;readable=false;
  await expect(runtime.request({teamId:"team-a",action:"read",payload:{id:"run"},invocationToken:"signed"})).rejects.toThrow("account changed");
  expect(attach).not.toHaveBeenCalled();
  readable=true;
  await expect(runtime.inspect({teamId:"team-a",actorId:"actor-b"},"run")).rejects.toThrow("owner changed");
});
