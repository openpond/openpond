import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import {runInNewContext} from "node:vm";
import path from "node:path";
import {expect,test} from "vitest";
import {contentHash} from "@openpond/harness";
import {ProviderSettingsSchema,type LocalDatasetRecord,type ChatResourceSummary} from "@openpond/contracts";
import type {loadOpenPondHostedModels,streamOpenPondHostedChatTurn} from "@openpond/runtime";
import {SqliteStore} from "../store/store.js";
import {createLocalDatasetService} from "../training/local-dataset-service.js";
import {createChatExperiments} from "./chat-experiments.js";
import {REPORT_TABS_SCRIPT} from "./chat-experiment-report-presentation.js";
import {chatExperimentReport} from "./chat-experiment-report.js";

// Failure story: a chat comparison must run identical saved tasks under one
// total ceiling, recover lost submissions without duplicate compute, and keep
// private expected answers out of inference and report data.
test("chat authoring, grader checks and bounded multi-model runs retain exact evidence",async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),"openpond-chat-e2e-"));const store=new SqliteStore(home);
  let actorId="actor",dispatches=0,switchDuringRun=false;const wire:unknown[]=[];
  const catalog:typeof loadOpenPondHostedModels=async()=>({error:null,models:["model-a","model-b"].map(id=>({id,displayName:id,ownedBy:"test",streaming:true,
    raw:{id,object:"model",created:0,owned_by:"test",context_window:1000,output_limit:64,capabilities:{samplingParameters:true},
      metadata:{billing:{pricing:{version:"1",source:"owner",effectiveAt:"2026-10-10T00:00:00.000Z",inputUsdPerMillionTokens:1,cachedInputUsdPerMillionTokens:1,outputUsdPerMillionTokens:1}}}}}))});
  const stream:typeof streamOpenPondHostedChatTurn=async function*(request){dispatches++;wire.push(request.messages);if(switchDuringRun)actorId="switched-before-next-dispatch";
    yield {type:"text_delta",text:request.model==="model-a" ? "pond" : "wrong <script>",raw:{}};
    yield {type:"usage",usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11},raw:{}};
    yield {type:"finish",finishReason:"stop",raw:{}};
  };
  const datasets=createLocalDatasetService({store,home});
  await store.claimLocalExperimentOwner("chat-proof-owner");
  const experiments=await createChatExperiments({store,home,ownerId:"chat-proof-owner",datasets,
    state:async()=>({settings:ProviderSettingsSchema.parse({}),secrets:{version:1,providers:{}}}),
    hosted:{access:async()=>({apiBaseUrl:"https://example.test",actorId,teamId:"team"}),catalog,stream}});
  try {
    const created=await datasets.request({action:"create",operationId:"author",payload:{name:"Chat <examples>",draft:{objective:"Check exact answers",
      tasks:["one","two"].map(id=>({schemaVersion:"openpond.taskData.v1",id,clusterKey:id,split:"validation",input:{prompt:"Reply with pond."},expectedOutput:{text:"pond",privateMarker:"GOLD_CANARY"},policyVisibleContext:{},privilegedContextRef:null,sourceRefs:[],tags:[],metadata:{}})),
      graders:[{id:"accuracy",version:"1",label:"Exact answer",kind:"content",weight:1,hardGate:true,rewardEligible:false,privileged:true,config:{operator:"final_answer_equals_expected"},metadata:{}}],
      graderFixtures:[{id:"good",taskId:"one",label:"positive",output:{text:"pond"},infrastructureError:null,expectedPassed:true,expectedRewardEligible:false,metadata:{}},{id:"bad",taskId:"one",label:"negative",output:{text:"wrong"},infrastructureError:null,expectedPassed:false,expectedRewardEligible:false,metadata:{}}]}}}) as {record:LocalDatasetRecord;summaries:ChatResourceSummary[]};
    const id=created.record.workspace.draft.id;expect(created.summaries[0]).toMatchObject({kind:"grader",state:"Not tested"});
    const checked=await datasets.request({action:"check_graders",id,expectedRevision:1}) as {record:LocalDatasetRecord};
    expect(checked.record.checks[0]).toMatchObject({status:"passed",checked:2,total:2,scopes:[{graderId:"accuracy",checked:2,total:2,status:"passed"}]});
    const input={datasetId:id,revision:1,operationId:"comparison",maximumCostUsd:0.02,taskLimit:2,maxOutputTokens:64,models:[{providerId:"openpond",modelId:"model-a"},{providerId:"openpond",modelId:"model-b"}]};
    const admitted=await experiments.run(input);expect(admitted.errors).toEqual([]);expect(admitted.runs).toHaveLength(2);
    expect(admitted.runs.reduce((sum,run)=>sum+run.configuration.maximumCostUsd,0)).toBeLessThanOrEqual(input.maximumCostUsd);
    await Promise.all(admitted.runs.map(run=>experiments.service.wait(run.id)));
    const results=await Promise.all(admitted.runs.map(async run=>{const evidence=await experiments.service.result({teamId:experiments.scope,id:run.id});const reply=await experiments.request({action:"result",payload:{id:run.id}}) as {summary:ChatResourceSummary};return {evidence,summary:{...reply.summary,datasetId:id,datasetRevision:1}};}));
    expect(results.map(result=>result.summary.score)).toEqual([1,0]);expect(results.map(result=>result.summary.qualityFailureCount)).toEqual([0,2]);
    expect(results.map(result=>result.evidence.cases.map(row=>[row.taskId,row.seed]))[0]).toEqual(results[1]!.evidence.cases.map(row=>[row.taskId,row.seed]));
    expect(JSON.stringify(wire)).not.toContain("GOLD_CANARY");expect(dispatches).toBe(4);
    const replay=await experiments.run(input);expect(replay.runs.map(run=>run.id)).toEqual(admitted.runs.map(run=>run.id));expect(dispatches).toBe(4);
    await expect(experiments.run({...input,maximumCostUsd:0.03})).rejects.toThrow(/different inputs/);expect(dispatches).toBe(4);
    // Discovery must preserve the same completed grades as result/replay;
    // otherwise reopening or listing silently replaces passed rows with null.
    const listed=await experiments.request({action:"list",payload:{}}) as {summaries:ChatResourceSummary[]};
    for(const result of results)expect(listed.summaries.find(summary=>summary.id===result.summary.id)).toMatchObject({
      datasetId:id,datasetRevision:1,score:result.summary.score,evaluatedCount:2,ungradedCount:0,qualityFailureCount:result.summary.qualityFailureCount});
    const html=chatExperimentReport(results);expect(html).toContain("100.0%");expect(html).toContain("wrong &lt;script&gt;");expect(html).not.toContain("GOLD_CANARY");expect([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1])).toEqual([REPORT_TABS_SCRIPT]);
    const largeRuns=Array.from({length:8},(_,index)=>({...results[0]!,summary:{...results[0]!.summary,id:`retained-run-${index}`,model:"<".repeat(10000)},view:{contentHash:contentHash(["retained",index]),scope:"same",graders:[],cases:Array.from({length:3},(_,i)=>({id:String(i),taskId:"<".repeat(240),seed:"0",status:"completed",output:"<".repeat(10000),error:null,score:1}))}}));
    const largeReport=chatExperimentReport(largeRuns);expect(largeReport.length).toBeLessThan(64000);
    // Bounded presentation must retain exact evidence identities even when
    // every label/output exhausts its text allowance. These are not UI labels.
    for(const run of largeRuns){expect(largeReport).toContain(run.summary.id);expect(largeReport).toContain(run.view.contentHash);}
    const changedScope=chatExperimentReport([results[0]!,{...results[1]!,summary:{...results[1]!.summary,datasetRevision:2,score:null,costUsd:null}}]);expect(changedScope).toContain("does not establish a winner");expect(changedScope).toContain("Unavailable");
    switchDuringRun=true;const before=dispatches;
    const fenced=await experiments.run({...input,operationId:"new-after-account-switch"});await Promise.all(fenced.runs.map(run=>experiments.service.wait(run.id)));
    expect(dispatches-before).toBe(1);
    expect((await experiments.service.list({teamId:experiments.scope})).items.some(run=>run.status === "failed")).toBe(true);
  } finally {await experiments.service.close();await store.releaseLocalExperimentOwner("chat-proof-owner");await store.close();await rm(home,{recursive:true,force:true});}
},30_000);

// Failure story: local storage and inference must remain usable without any
// cloud identity; missing provider usage must remain unavailable, not $0.
test("account-independent configured loopback inference completes a saved local evaluation",async()=>{
  const {createServer}=await import("node:http");
  const server=createServer((_request,response)=>{response.writeHead(200,{"Content-Type":"text/event-stream"});response.end('data: {"choices":[{"delta":{"content":"pond"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address || typeof address==="string")throw new Error("Missing loopback listener");
  const home=await mkdtemp(path.join(os.tmpdir(),"openpond-chat-loopback-")),store=new SqliteStore(home);
  const settings=ProviderSettingsSchema.parse({providers:{"custom-openai-compatible":{id:"custom-openai-compatible",enabled:true,baseUrl:`http://127.0.0.1:${address.port}/v1`,defaultModel:"local-model"}},modelCaches:{"custom-openai-compatible":{providerId:"custom-openai-compatible",source:"manual",models:[{id:"local-model",providerId:"custom-openai-compatible",displayName:"Loopback fixture",source:"manual",contextWindow:4096,outputLimit:256,capabilities:{streaming:true}}]}}});
  const datasets=createLocalDatasetService({store,home});await store.claimLocalExperimentOwner("loopback-owner");
  const experiments=await createChatExperiments({store,home,ownerId:"loopback-owner",datasets,state:async()=>({settings,secrets:{version:1,providers:{"custom-openai-compatible":{source:"local_secret",value:"loopback-test",envVar:null,oauth:null,createdAt:"2026-10-10T00:00:00.000Z",updatedAt:"2026-10-10T00:00:00.000Z",lastValidatedAt:null,lastError:null}}}})});
  try{
    const created=await datasets.request({action:"create",operationId:"local",payload:{name:"No account",draft:{objective:"Check local output",tasks:[{schemaVersion:"openpond.taskData.v1",id:"one",clusterKey:"one",split:"validation",input:{prompt:"Reply with pond"},expectedOutput:{text:"pond"},policyVisibleContext:{},privilegedContextRef:null,sourceRefs:[],tags:[],metadata:{}}],graders:[{id:"accuracy",version:"1",label:"Exact answer",kind:"content",weight:1,hardGate:true,rewardEligible:false,privileged:true,config:{operator:"final_answer_equals_expected"},metadata:{}}]}}}) as {record:LocalDatasetRecord};
    const run=await experiments.run({datasetId:created.record.workspace.draft.id,revision:1,operationId:"no-account-run",maximumCostUsd:0.01,taskLimit:1,maxOutputTokens:64,models:[{providerId:"custom-openai-compatible",modelId:"local-model"}]});
    expect(run.errors).toEqual([]);await experiments.service.wait(run.runs[0]!.id);
    const result=await experiments.request({action:"result",payload:{id:run.runs[0]!.id}}) as {summary:ChatResourceSummary};
    expect(result.summary).toMatchObject({state:"completed",score:1,costUsd:null,evaluatedCount:1,taskCount:1});
  }finally{await experiments.service.close();await store.releaseLocalExperimentOwner("loopback-owner");await store.close();await rm(home,{recursive:true,force:true});await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()));}
});

// Failure story: switching a retained report must reveal exactly one panel,
// and keyboard users must reach every panel without invisible focus stops.
test("retained report tabs support clicks, keyboard wrap and roving focus",()=>{
  let focused=-1;
  const tabs=Array.from({length:3},(_,index)=>({
    selected:String(index===0),tabIndex:index===0 ? 0 : -1,
    listeners:new Map<string,(event:any)=>void>(),
    setAttribute(_name:string,value:string){this.selected=value;},
    addEventListener(name:string,handler:(event:any)=>void){this.listeners.set(name,handler);},
    focus(){focused=index;},
  }));
  const panels=tabs.map((_,index)=>({hidden:index!==0}));
  const root={querySelectorAll:(selector:string)=>selector==='[role="tab"]' ? tabs : panels};
  runInNewContext(REPORT_TABS_SCRIPT,{document:{currentScript:{previousElementSibling:root}}});
  const selected=(index:number)=>{
    expect(tabs.map(tab=>tab.selected)).toEqual(tabs.map((_,i)=>String(i===index)));
    expect(tabs.map(tab=>tab.tabIndex)).toEqual(tabs.map((_,i)=>i===index ? 0 : -1));
    expect(panels.map(panel=>panel.hidden)).toEqual(panels.map((_,i)=>i!==index));
  };
  const key=(index:number,value:string)=>{
    let prevented=false;
    tabs[index]!.listeners.get('keydown')!({key:value,preventDefault(){prevented=true;}});
    return prevented;
  };
  selected(0);
  tabs[1]!.listeners.get('click')!({});selected(1);
  expect(key(1,'ArrowRight')).toBe(true);selected(2);expect(focused).toBe(2);
  expect(key(2,'ArrowRight')).toBe(true);selected(0);expect(focused).toBe(0);
  expect(key(0,'ArrowLeft')).toBe(true);selected(2);
  expect(key(2,'Home')).toBe(true);selected(0);
  expect(key(0,'End')).toBe(true);selected(2);
  expect(key(2,'Tab')).toBe(false);selected(2);
});
