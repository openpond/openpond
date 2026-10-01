import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect,test } from "vitest";
import { contentHash } from "@openpond/harness";
import { createEnvironmentRelease,createVerifierSetRelease,bindTasksetExecutionReleases } from "@openpond/evals";
import { TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { createTasksetPackage } from "openpond-sdk/taskset-packages";
import type { loadOpenPondHostedModels,streamOpenPondHostedChatTurn } from "@openpond/runtime";
import { SqliteStore } from "../store/store.js";
import { createLocalExperimentService } from "./local-experiment-service.js";
import { createHttpRequestHandler,type HttpRouteDeps } from "../api/http-routes.js";
import { LocalExperimentExecutionSchema } from "./local-experiment-contract.js";
import { localExperimentAdmissions } from "./local-experiment-admission.js";
import { LocalExperimentRecordSchema,LocalExperimentPublicExecutionSchema,LocalExperimentComparisonSchema } from "@openpond/contracts";
import { compareExperiments, createExperimentManifest, createExperimentResult } from "@openpond/evals/experiments";

const catalog:typeof loadOpenPondHostedModels=async()=>({error:null,models:[{id:"local-qualified-model",displayName:"Local model",ownedBy:"test",streaming:true,
  raw:{id:"local-qualified-model",object:"model",created:0,owned_by:"test",context_window:1000,output_limit:64,
    capabilities:{samplingParameters:true},metadata:{billing:{pricing:{version:"1",source:"owner",effectiveAt:"2026-09-30T00:00:00.000Z",
      inputUsdPerMillionTokens:1,cachedInputUsdPerMillionTokens:1,outputUsdPerMillionTokens:1}}}}}]});

function source() {
  const environment=createEnvironmentRelease({schemaVersion:"openpond.environmentRelease.v1",id:"local-text",revision:1,
    contract:{protocolVersion:"openpond.environment.v1",kind:"text",entrypoint:"text",stateful:false,deterministicSeeds:true,
      lifecycle:["create","reset","step","collect","destroy"],networkPolicy:"none",defaultTimeoutMs:10000},
    actionSchemaRef:null,observationSchemaRef:null,stateSchemaRef:null,artifactCollection:{maxArtifacts:1,maxTotalBytes:1024},adapterConformanceHashes:{},metadata:{}});
  const verifierSet=createVerifierSetRelease({schemaVersion:"openpond.verifierSetRelease.v1",id:"local-verifiers",revision:1,
    graders:[{id:"accuracy",version:"1",kind:"content",weight:1,hardGate:true,rewardEligible:false,privileged:true,
      config:{operator:"final_answer_equals_expected"}}],
    isolation:{processBoundary:"isolated_process",networkPolicy:"none",defaultTimeoutMs:1000},calibrationReceiptRefs:[],metadata:{}});
  const body={schemaVersion:"openpond.tasksetRelease.v2",id:"local-data",revision:1,
    policy:{policyVisibleFields:["input","policyVisibleContext"],privilegedFields:["expectedOutput"],hiddenGraderRefs:["accuracy"],connectedAppScopes:[]},
    environment:environment.contract,tools:[],capabilities:[],graders:verifierSet.graders,
    tasks:[{id:"task-a",clusterKey:"family",split:"test",input:{prompt:"Reply with pond."},expectedOutput:{text:"pond",privateMarker:"GOLD_ONLY_DO_NOT_SEND"},
      policyVisibleContext:{public:true},privilegedContextRef:null,artifactRefs:[],tags:[]}],metadata:{ordinaryAuthoring:{instructions:"Answer the task."}}};
  const taskset=bindTasksetExecutionReleases({taskset:TasksetReleaseSchema.parse({...body,contentHash:contentHash(body)}),environment,verifierSet});
  return createTasksetPackage({schemaVersion:"openpond.tasksetPackage.v1",taskset,environment,verifierSet,files:[]});
}
function savedInput(maximumCostUsd=0.01) {
  const value=source();
  return {package:value,configuration:{operationId:"run-local",maximumCostUsd,
    request:{schemaVersion:"openpond.modelTasksetRunRequest.v1",operationId:"run-local",teamId:"owned-workspace",modelProjectId:null,name:"Local durable evaluation",
      taskset:{id:value.taskset.id,revision:value.taskset.revision,contentHash:value.taskset.contentHash},
      policy:{kind:"hosted_chat",modelId:"local-qualified-model",maxOutputTokens:64,temperature:0,topP:1},
      population:[{receiptId:"receipt-a",taskId:"task-a",seed:"0",fixtureId:null}]}}};
}

// Failure story: one reviewed configuration must atomically own one run across
// lost replies/restart. Duplication creates a new run without editing evidence;
// private grading, scope fences and the CLI must not resurrect a parent API.
test("flat local HTTP/SQLite/CLI admission recovers one run and keeps duplicate evidence independent",async()=> {
  const home=await mkdtemp(path.join(os.tmpdir(),"openpond-flat-local-"));let store=new SqliteStore(home),dispatches=0,actorId="local-proof-actor";
  let block=false,notify:()=>void=()=>{};const entered=new Promise<void>(resolve=>{notify=resolve;});const wire:unknown[]=[];
  const stream:typeof streamOpenPondHostedChatTurn=async function*(request) {
    dispatches++;wire.push(request.messages);
    if(block){notify();await new Promise<void>((_,reject)=>{if(request.signal?.aborted)reject(request.signal.reason);else request.signal?.addEventListener("abort",()=>reject(request.signal?.reason),{once:true});});}
    yield {type:"text_delta",text:"pond",raw:{}};yield {type:"usage",usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11},raw:{}};yield {type:"finish",finishReason:"stop",raw:{}};
  };
  let packageReads=0;
  let service=createLocalExperimentService({store,actorId:async()=>actorId,catalog,stream,ownerId:"owner-one",teamId:async()=>"owned-workspace",resolvePackage:async()=>{packageReads++;return source();}});
  const server=createServer(createHttpRequestHandler({host:"127.0.0.1",getActualPort:()=> (server.address() as AddressInfo).port,token:"local-proof-capability",version:"proof",
    logger:{info(){},warn(){},error(){}},localExperimentPayload:(payload:unknown)=>service.request(payload),trainingPayload:async()=>{throw new Error("Hosted job dispatch forbidden");}} as unknown as HttpRouteDeps));
  server.listen(0,"127.0.0.1");await once(server,"listening");const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/local-experiments`;
  async function command(action:string,payload:unknown){const response=await fetch(url,{method:"POST",headers:{authorization:"Bearer local-proof-capability","content-type":"application/json"},body:JSON.stringify({teamId:"owned-workspace",action,payload})});expect(response.status).toBe(200);return response.json() as Promise<unknown>;}
  const changed=(input:ReturnType<typeof savedInput>,operationId:string,name=input.configuration.request.name)=>({...input,configuration:{...input.configuration,operationId,request:{...input.configuration.request,operationId,name}}});
  const cli=async(args:string[])=>JSON.parse((await promisify(execFile)(process.execPath,["--import","tsx",path.resolve("apps/cli/src/cli/main.ts"),"experiments",...args,"--local","--team","owned-workspace","--server-url",new URL(url).origin],{env:{...process.env,OPENPOND_HOME:home},timeout:30000,maxBuffer:1048576})).stdout) as unknown;
  try {
    await service.recover();const input=savedInput();
    const native=changed(input,"unsupported-native");await expect(service.run({...native,configuration:{...native.configuration,request:{...native.configuration.request,policy:{...native.configuration.request.policy,harness:{harnessRelease:{id:"native-source",contentHash:"a".repeat(64)},agentSnapshot:{id:"native-agent",contentHash:"b".repeat(64)},sourcePackageHash:"c".repeat(64)}}}}})).rejects.toMatchObject({code:"local_harness_not_qualified"});
    expect(dispatches).toBe(0);
    const release={configuration:input.configuration,expectedPackageHash:input.package.contentHash};
    const [first,replay]=(await Promise.all([command("runFromRelease",release),command("runFromRelease",release)])).map(value=>LocalExperimentRecordSchema.parse(value));
    expect(first.id).toBe(replay.id);expect(first).not.toHaveProperty("definition");await service.wait(first.id);expect(dispatches).toBe(1);
    const original=await service.result({teamId:"owned-workspace",id:first.id});
    expect(original.execution).toMatchObject({location:"local",status:"completed",cleanupComplete:true,usage:{costUsd:0.000011,heldUsd:0,uncertainRequests:0}});
    expect(original.cases[0]).toMatchObject({output:"pond",grade:{score:1,passed:true}});expect(JSON.stringify(wire)).not.toContain("GOLD_ONLY_DO_NOT_SEND");expect(JSON.stringify(original)).not.toContain("GOLD_ONLY_DO_NOT_SEND");
    const scalar=await command("feedbackSummary",{id:first.id}) as {experimentId:string;graders:unknown[]};expect(scalar).toMatchObject({experimentId:first.id,graders:[{id:"accuracy",status:"available",mean:1,count:1,total:1}]});expect(JSON.stringify(scalar)).not.toContain("GOLD_ONLY_DO_NOT_SEND");expect(scalar).not.toHaveProperty("cases");
    const trace=await service.inspectCase({teamId:"owned-workspace",id:first.id,receiptId:"receipt-a",limit:2});expect(trace.trace.items.map(item=>item.type)).toEqual(["model.dispatch","model.text_delta"]);
    const more=await service.inspectCase({teamId:"owned-workspace",id:first.id,receiptId:"receipt-a",afterSequence:trace.trace.nextCursor!,limit:2});expect(more.trace.items[0]!.sequence).toBeGreaterThan(trace.trace.items[1]!.sequence);
    await writeFile(path.join(home,"token"),"local-proof-capability",{mode:0o600});const inputFile=path.join(home,"run.json");await writeFile(inputFile,JSON.stringify(release));
    expect(await cli(["run","--input-file",inputFile])).toMatchObject({id:first.id,status:"completed"});expect(dispatches).toBe(1);
    expect(await cli(["list"])).toMatchObject({items:[{id:first.id,configuration:{request:{name:"Local durable evaluation"}}}]});
    expect(await cli(["read",first.id,"--content-hash",first.configurationHash])).toMatchObject({id:first.id,configurationHash:first.configurationHash});
    await expect(service.read({teamId:"owned-workspace",id:first.id,configurationHash:"f".repeat(64)})).rejects.toMatchObject({code:"local_configuration_pin_conflict"});
    for(const action of ["save","saveRelease","start","history","executions"])await expect(service.request({teamId:"owned-workspace",action,payload:{}})).rejects.toThrow();
    await expect(service.request({teamId:"owned-workspace",projectId:"other-project",action:"read",payload:{id:first.id}})).rejects.toMatchObject({code:"local_project_resource_denied"});
    expect(await service.list({teamId:"owned-workspace",projectId:"other-project"})).toMatchObject({items:[]});
    expect(await service.list({teamId:"owned-workspace",datasetHash:"f".repeat(64)})).toMatchObject({items:[]});
    actorId="foreign-actor";expect((await service.list({teamId:"owned-workspace"})).items).toEqual([]);
    for(const action of ["read","status","result","cancel","case","feedbackSummary"])await expect(service.request({teamId:"owned-workspace",action,payload:{id:first.id,...(action==="case"?{receiptId:"receipt-a"}:{})}})).rejects.toMatchObject({code:"local_resource_denied"});
    const foreign=changed(input,"foreign-copy");await expect(service.run({...foreign,configuration:{...foreign.configuration,sourceExperimentId:first.id}})).rejects.toMatchObject({code:"local_resource_denied"});actorId="local-proof-actor";
    const readRecord=store.readLocalExperimentRecord.bind(store);store.readLocalExperimentRecord=async(team,id)=>{const record=await readRecord(team,id);actorId="changed-during-read";return record;};
    await expect(service.request({teamId:"owned-workspace",action:"read",payload:{id:first.id}})).rejects.toMatchObject({code:"local_resource_denied"});store.readLocalExperimentRecord=readRecord;actorId="local-proof-actor";
    await expect(service.result({teamId:"foreign-workspace",id:first.id})).rejects.toMatchObject({code:"local_workspace_denied"});
    const pin=first.graders[0]!;const scored=LocalExperimentPublicExecutionSchema.parse(await command("scoreRetained",{operationId:"score-local",execution:{id:first.id,executionHash:first.executionHash},graders:[{id:pin.id,version:pin.version,contentHash:pin.contentHash,mappings:[]}],maximumCostUsd:0.01}));await service.wait(scored.id);
    expect((await service.result({teamId:"owned-workspace",id:scored.id})).cases[0]?.grade?.score).toBe(1);expect(dispatches).toBe(1);expect(await service.result({teamId:"owned-workspace",id:first.id})).toEqual(original);
    const evidence=LocalExperimentComparisonSchema.parse(await command("compare",{baselineId:first.id,candidateId:scored.id}));expect(evidence.baseline.execution).not.toHaveProperty("definition");expect(evidence.baseline.manifest.lineage?.definition).toBeNull();const comparison=compareExperiments(evidence.baseline,evidence.candidate);expect(comparison).toMatchObject({comparable:true,reasons:[],metrics:[{eligibleCount:1,excludedCount:0,baseline:1,candidate:1,delta:0}]});expect(evidence.baseline.result.cases[0]?.usage).toMatchObject({inputTokens:10,outputTokens:1,totalTokens:11,costUsd:0.000011});expect((await cli(["compare",first.id,scored.id]) as {comparison:unknown}).comparison).toEqual(comparison);
    const {contentHash:_manifestHash,...changedManifest}=evidence.candidate.manifest;const incompatibleManifest=createExperimentManifest({...changedManifest,execution:{...changedManifest.execution!,packageHash:"f".repeat(64)}});const {contentHash:_resultHash,...changedResult}=evidence.candidate.result;const incompatibleResult=createExperimentResult({...changedResult,manifest:{id:incompatibleManifest.id,contentHash:incompatibleManifest.contentHash}},incompatibleManifest);expect(compareExperiments(evidence.baseline,{manifest:incompatibleManifest,result:incompatibleResult})).toMatchObject({comparable:false,reasons:["different_execution_contract"]});
    const copied=changed(input,"duplicate-edited","Edited copy");const duplicate=await service.run({...copied,configuration:{...copied.configuration,sourceExperimentId:first.id}});await service.wait(duplicate.id);expect(duplicate.id).not.toBe(first.id);expect((await service.read({teamId:"owned-workspace",id:first.id})).configuration.request.name).toBe("Local durable evaluation");expect(await service.result({teamId:"owned-workspace",id:first.id})).toEqual(original);expect(dispatches).toBe(2);expect((await service.list({teamId:"owned-workspace",search:"Edited copy",status:"completed",limit:1})).items.map(item=>item.id)).toEqual([duplicate.id]);
    await service.close();await store.close();store=new SqliteStore(home);service=createLocalExperimentService({store,actorId:async()=>actorId,catalog,stream,ownerId:"owner-two",teamId:async()=>"owned-workspace"});await service.recover();const reads=packageReads;expect((await service.runFromRelease(release)).id).toBe(first.id);expect(packageReads).toBe(reads);expect(dispatches).toBe(2);expect(await service.result({teamId:"owned-workspace",id:first.id})).toEqual(original);
    await expect(service.runFromRelease({...release,configuration:{...release.configuration,request:{...release.configuration.request,name:"Substituted same operation"}}})).rejects.toMatchObject({code:"local_operation_conflict"});
    block=true;const cancellable=await service.run(changed(input,"cancel-active-target"));await entered;expect((await service.list({teamId:"owned-workspace",status:"running",limit:1})).items.map(item=>item.id)).toEqual([cancellable.id]);await service.cancel({teamId:"owned-workspace",id:cancellable.id});await service.wait(cancellable.id);expect(await service.status({teamId:"owned-workspace",id:cancellable.id})).toMatchObject({status:"cancelled",cleanupComplete:true,counts:{pending:0,running:0,cancelled:1},usage:{costUsd:null,uncertainRequests:1}});expect(dispatches).toBe(3);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await service.close();await store.close();await rm(home,{recursive:true,force:true});}
});

// Failure story: missing final provider usage cannot release a reservation or
// permit recovery to replay the target; a too-small ceiling dispatches nothing.
test("local ceiling rejects before dispatch and missing usage retains an uncertain charge across restart",async()=> {
  const home=await mkdtemp(path.join(os.tmpdir(),"openpond-local-charge-"));let store=new SqliteStore(home),dispatches=0;
  const stream:typeof streamOpenPondHostedChatTurn=async function*(){dispatches++;yield {type:"text_delta",text:"pond",raw:{}};yield {type:"finish",finishReason:"stop",raw:{}};};
  let service=createLocalExperimentService({store,actorId:async()=>"local-proof-actor",catalog,stream,ownerId:"charge-owner-one",teamId:async()=>"owned-workspace"});
  try {
    await service.recover();const rejected=await service.run(savedInput(0.0001));
    await service.wait(rejected.id);expect(dispatches).toBe(0);
    expect((await service.status({teamId:"owned-workspace",id:rejected.id})).status).toBe("failed");
    const input=savedInput(0.0015);input.configuration.operationId="uncertain-run";input.configuration.request.operationId="uncertain-run";
    const execution=await service.run(input);await service.wait(execution.id);
    const retained=await service.status({teamId:"owned-workspace",id:execution.id});
    expect(retained.usage).toMatchObject({knownCostUsd:0,costUsd:null,heldUsd:0.001064,uncertainRequests:1});
    expect((await service.result({teamId:"owned-workspace",id:execution.id})).cases[0]?.output).toBe("pond");
    const competing=createLocalExperimentService({store,actorId:async()=>"local-proof-actor",catalog,stream,ownerId:"competing-owner",teamId:async()=>"owned-workspace"});
    await expect(competing.recover()).rejects.toMatchObject({code:"local_runtime_already_owned"});
    const internal=(await store.readLocalExecution("owned-workspace",execution.id)).execution;const definition=(await store.readLocalExperiment("owned-workspace",internal.definition.id,internal.definition.revision)).definition;
    const crashStart={definition:internal.definition,operationId:"crashed-start"},crashId=`local-run-${contentHash(["owned-workspace",crashStart.operationId]).slice(0,48)}`;
    const admissions=localExperimentAdmissions(definition,input.package,crashId);
    const crashExecution=LocalExperimentExecutionSchema.parse({...internal,id:crashId,operationId:crashStart.operationId,
      status:"queued",completedAt:null,cleanupComplete:false,error:null,usage:{costUsd:0,knownCostUsd:0,heldUsd:0,uncertainRequests:0},executionHash:contentHash({id:crashId,admissions}),counts:{pending:1,running:0,completed:0,failed:0,cancelled:0,unknown:0}});
    await store.startLocalExperiment({operationId:crashStart.operationId,intentHash:contentHash({ownerActorId:"local-proof-actor",input:crashStart}),ownerId:"charge-owner-one",execution:crashExecution,admissions});
    await store.admitLocalCase("owned-workspace",crashId,admissions[0]!.receiptId,"charge-owner-one");
    await store.reserveLocalCharge({teamId:"owned-workspace",id:crashId,caseId:admissions[0]!.receiptId,requestId:"uncertain-dispatch",ownerId:"charge-owner-one",maximumUsd:0.001064});
    await store.markLocalChargeDispatched("owned-workspace",crashId,"uncertain-dispatch","charge-owner-one");
    await service.close();await store.close();store=new SqliteStore(home);
    service=createLocalExperimentService({store,actorId:async()=>"local-proof-actor",catalog,stream,ownerId:"charge-owner-two",teamId:async()=>"owned-workspace"});
    const recovered=await service.recover();expect(recovered).toContainEqual(expect.objectContaining({id:crashId,status:"interrupted",cleanupComplete:false,
      counts:expect.objectContaining({unknown:1}),usage:expect.objectContaining({heldUsd:0.001064,uncertainRequests:1})}));
    const historical=await service.read({teamId:"owned-workspace",id:crashId});expect(historical.status).toBe("interrupted");expect(historical.retainedConfigurationHash).toBe(definition.contentHash);expect((await store.readLocalExperiment("owned-workspace",definition.id,definition.revision)).definition).toEqual(definition);
    expect(await service.run(input)).toEqual(retained);expect(dispatches).toBe(1);
  } finally {await service.close();await store.close();await rm(home,{recursive:true,force:true});}
});

// Failure story: an invalid provider receipt must stop further dispatch without
// discarding measured spend or turning an immutable known receipt into unknown.
test("local over-bound provider usage is retained and fences subsequent dispatch",async()=> {
  const home=await mkdtemp(path.join(os.tmpdir(),"openpond-local-over-bound-"));
  const store=new SqliteStore(home);let dispatches=0;
  const stream:typeof streamOpenPondHostedChatTurn=async function*(){
    dispatches++;yield {type:"text_delta",text:"pond",raw:{}};
    yield {type:"usage",usage:{prompt_tokens:2000,completion_tokens:1,total_tokens:2001},raw:{}};
    yield {type:"finish",finishReason:"stop",raw:{}};
  };
  const service=createLocalExperimentService({store,actorId:async()=>"local-proof-actor",catalog,stream,ownerId:"bound-owner",teamId:async()=>"owned-workspace"});
  try {
    await service.recover();const execution=await service.run(savedInput());
    await service.wait(execution.id);expect(dispatches).toBe(1);
    expect(await service.status({teamId:"owned-workspace",id:execution.id})).toMatchObject({status:"failed",cleanupComplete:true,
      usage:{knownCostUsd:0.002001,costUsd:0.002001,heldUsd:0,uncertainRequests:0}});
    await expect(store.reserveLocalCharge({teamId:"owned-workspace",id:execution.id,caseId:"receipt-a",requestId:"new-request",ownerId:"bound-owner",maximumUsd:0.001064}))
      .rejects.toMatchObject({code:"local_charge_outside_bound"});
    expect(dispatches).toBe(1);
  } finally {await service.close();await store.close();await rm(home,{recursive:true,force:true});}
});


// A native owner can reject after an uncertain interruption. Pending/running
// counters reaching zero alone must not manufacture a cleanup acknowledgement.
test("unconfirmed native cleanup remains failed in the durable local receipt",async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),"openpond-local-uncertain-cleanup-")),store=new SqliteStore(home);
  const service=createLocalExperimentService({store,catalog,ownerId:"uncertain-owner",actorId:async()=>"actor",teamId:async()=>"owned-workspace",
    nativeHarness:{qualified:true,resolve:async()=>{},execute:async()=>{throw new Error("Native cleanup remains unconfirmed.");}}});
  try{
    await service.recover();const input=savedInput();
    const execution=await service.run({...input,configuration:{...input.configuration,request:{...input.configuration.request,
      policy:{...input.configuration.request.policy,harness:{harnessRelease:{id:"source",contentHash:"a".repeat(64)},agentSnapshot:{id:"agent",contentHash:"b".repeat(64)},sourcePackageHash:"c".repeat(64)}}}}});
    await service.wait(execution.id);const result=await service.result({teamId:"owned-workspace",id:execution.id});
    expect(result.execution).toMatchObject({status:"failed",cleanupComplete:false});
    expect(result.cases[0]?.error).toContain("cleanup remains unconfirmed");
  }finally{await service.close();await store.close();await rm(home,{recursive:true,force:true});}
});
