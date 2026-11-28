import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {expect,test} from "vitest";
import {contentHash} from "@openpond/harness";
import {canonicalSha256} from "../../../../packages/sdk/src/protocol.js";
import {genericToolConformance} from "@openpond/evals/conformance";
import {createTasksetRunManifest,tasksetRunMetricPolicy} from "@openpond/evals/metrics";
import {RunExperimentSchema,experimentRunConfigurationHash,type ExperimentRunDetails} from "openpond-sdk/experiments";
import {ExperimentDraftSchema} from "openpond-sdk/training";
import {createTasksetDraftWorkspace} from "openpond-sdk/taskset-drafts";
import type {LocalDatasetRecord} from "@openpond/contracts";
import {SqliteStore} from "../store/store.js";
import {createLocalDatasetService} from "../training/local-dataset-service.js";
import {createChatCloudExperiments} from "./chat-cloud-experiments.js";

// Failure story: cloud compute must use the exact acknowledged publication,
// preserve disjoint model ceilings and recover uncertain submissions without
// changing task membership or dispatching against a switched account.
test("cloud chat runs seal publication and budget before recoverable admission",async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),"openpond-chat-cloud-")),store=new SqliteStore(home);
  let actorId="actor",publicationMismatch=true,publishes=0,lost=true;
  const admitted=new Map<string,ExperimentRunDetails>(),submissions:unknown[]=[];
  const {taskset,manifest:legacy}=genericToolConformance;
  const release={id:taskset.id,revision:1,contentHash:taskset.contentHash};
  let published:LocalDatasetRecord["workspace"];
  const datasets=createLocalDatasetService({store,home,syncAction:async(_action,record)=>{publishes++;return record;}});
  const transport:typeof fetch=async(url,init)=>{
    if(String(url).includes("/dataset-workspaces/"))return Response.json({schemaVersion:"openpond.datasetWorkspaceReceipt.v1",teamId:"team",datasetId:published.draft.id,revision:published.draft.revision,workspace:published,publication:{tasksetId:release.id,release:publicationMismatch ? {...release,contentHash:"f".repeat(64)} : release,packageHash:contentHash("package")}});
    const operation=RunExperimentSchema.parse(JSON.parse(String(init?.body)));submissions.push(operation);
    let details=admitted.get(operation.operationId);
    if(!details){
      const request=operation.request;
      if(request.policy.kind!=="hosted_chat")throw new Error("Expected model policy");
      const snapshot={modelId:request.policy.modelId,provider:"test-provider",upstreamModelId:request.policy.modelId,configurationHash:contentHash("provider")};
      const graders=[{id:"grader",version:"1",contentHash:contentHash("grader"),feedbackKey:"accuracy",release:null}];
      const configurationContent={request,maximumCostUsd:operation.maximumCostUsd,graders,admissionRequestHash:contentHash(operation)};
      const configuration={...configurationContent,configurationHash:experimentRunConfigurationHash(configurationContent)};
      const context={definition:null,configurationHash:configuration.configurationHash,admissionRequestHash:configuration.admissionRequestHash,maximumCostUsd:operation.maximumCostUsd,graders};
      const manifest=createTasksetRunManifest({schemaVersion:"openpond.tasksetRunManifest.v1",id:"run-"+request.policy.modelId,tasksetRelease:legacy.tasksetRelease,packageHash:contentHash("package"),execution:{kind:"harness",harnessRelease:legacy.harnessRelease},
        policy:{kind:"model",model:{provider:snapshot.provider,model:snapshot.upstreamModelId,revision:null,artifactHash:null,tokenizerRevision:null,chatTemplateHash:null},configurationHash:await canonicalSha256({policy:request.policy,snapshot})},
        gradingRole:"evaluation",metricPolicy:tasksetRunMetricPolicy(taskset),population:request.population,runtimeTarget:{...legacy.runtimeTarget,placement:"remote"},limits:{...legacy.limits,maximumSpendUsd:operation.maximumCostUsd},createdAt:legacy.createdAt,metadata:{experimentDefinition:null,experimentConfigurationHash:contentHash(context)}});
      details={request,configuration,manifest,policySnapshot:snapshot,summary:{schemaVersion:"openpond.modelTasksetRunSummary.v1",id:manifest.id,revision:1,teamId:request.teamId,modelProjectId:null,name:request.name,operationId:request.operationId,taskset:request.taskset,policyKind:"hosted_chat",manifestHash:manifest.contentHash,status:"queued",totalCount:request.population.length,counts:{pending:request.population.length,running:0,completed:0,failed:0,cancelled:0},createdAt:manifest.createdAt,startedAt:null,completedAt:null,cleanupComplete:false,resultAvailable:false,score:null,metricName:manifest.metricPolicy.primaryMetric,error:null}};
      admitted.set(operation.operationId,details);
      if(lost){lost=false;throw new Error("Run reply lost after admission");}
    }
    return Response.json(details);
  };
  const cloud=createChatCloudExperiments({store,datasets,fetch:transport,access:async()=>({apiBaseUrl:"https://example.test",token:"test",actorId,teamId:"team"})});
  try{
    const created=await datasets.request({action:"create",operationId:"dataset",payload:{name:"Cloud fixture",draft:{objective:"Check publication",tasks:[{schemaVersion:"openpond.taskData.v1",id:taskset.tasks[0]!.id,clusterKey:"one",split:"validation",input:{prompt:"A task"},expectedOutput:null,policyVisibleContext:{},privilegedContextRef:null,sourceRefs:[],tags:[],metadata:{}}]}}}) as {record:LocalDatasetRecord};
    const id=created.record.workspace.draft.id;
    published=createTasksetDraftWorkspace({schemaVersion:created.record.workspace.schemaVersion,files:[],draft:{...created.record.workspace.draft,profileId:"team",revision:2,status:"published",publishedTasksetRef:release}});
    await store.updateLocalDatasetMetadata(id,contentHash(created.record),record=>({...record,sync:{apiOrigin:"https://example.test",actorId:"actor",teamId:"team",datasetId:id,remoteRevision:2,acknowledgedHash:record.workspace.contentHash,remoteHash:published.contentHash,pendingLocalHash:null,paused:false,status:"synced",error:null,operationId:null,pendingWorkspace:null}}));
    const input={datasetId:id,revision:1,operationId:"cloud-group",maximumCostUsd:0.020001,taskLimit:1,models:[{providerId:"openpond",modelId:"a"},{providerId:"openpond",modelId:"b"}]};
    await expect(cloud.run(input)).rejects.toThrow();expect(submissions).toHaveLength(0);
    publicationMismatch=false;
    const first=await cloud.run(input);expect(first.errors).toHaveLength(1);expect(first.runs).toHaveLength(1);
    const retry=await cloud.run(input);expect(retry.errors).toEqual([]);expect(retry.runs).toHaveLength(2);expect(admitted.size).toBe(2);expect(publishes).toBe(2);
    expect(retry.runs.reduce((total,run)=>total+run.configuration.maximumCostUsd,0)).toBeLessThanOrEqual(input.maximumCostUsd);
    expect(retry.runs.map(run=>run.request.taskset)).toEqual([release,release]);
    expect(retry.runs.map(run=>run.request.population.map(row=>[row.taskId,row.seed]))).toEqual([[[taskset.tasks[0]!.id,"0"]],[[taskset.tasks[0]!.id,"0"]]]);
    await expect(cloud.run({...input,maximumCostUsd:1})).rejects.toThrow(/different inputs/);
    actorId="other";const before=submissions.length;await expect(cloud.run(input)).rejects.toThrow(/linked account/);expect(submissions).toHaveLength(before);
    expect(await cloud.list()).toHaveLength(2);
  }finally{cloud.close();await store.close();await rm(home,{recursive:true,force:true});}
});

// A prepared candidate can complete after the local draft changes. Its result
// must retain the original revision and refuse a different artifact or owner.
test("binds a hosted candidate Benchmark to its original saved revision and immutable version",async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),"openpond-benchmark-candidate-"));
  const store=new SqliteStore(home);
  const {taskset,manifest:legacy}=genericToolConformance;
  const at=legacy.createdAt, hash=contentHash("fixture"), jobId="training-job", teamId="team";
  const task={id:taskset.id,revision:1,contentHash:taskset.contentHash};
  const release={id:"source-release",contentHash:hash};
  const versionArtifact={id:"trained-output",contentHash:contentHash("adapter")};
  const registryArtifact={id:"registry-artifact",contentHash:contentHash("registry")};
  const source={modelProject:{id:"model",portableProjectId:"portable",revision:1,contentHash:hash},
    harnessRunManifest:release,harnessRelease:release,taskset:task,tasksetRelease:release,dataset:release,evidenceSets:[]};
  const base={schemaVersion:"openpond.baseModelPreference.v1",modelId:"fixture/model",revision:"base-pin",tokenizerRevision:"tokenizer-pin",
    chatTemplateHash:hash,modelAssetId:null,source:"managed"};
  const trainingRequest={submissionHash:hash,source,baseModel:base,recipe:{method:"sft"}};
  const adapter={artifact:versionArtifact,checkpointId:"checkpoint",composition:"base",parent:null};
  const versionContent={schemaVersion:"openpond.trainingModelVersion.v1",teamId,modelProjectId:"model",portableProjectId:"portable",jobId,
    request:trainingRequest,candidate:adapter,executionReceipt:release,createdAt:at};
  const version={...versionContent,contentHash:await canonicalSha256(versionContent)};
  const grader={id:"grader",version:"1",contentHash:contentHash("grader"),mappings:[]};
  const population=[{receiptId:"case-receipt",taskId:taskset.tasks[0]!.id,seed:"17",fixtureId:null}];
  const name="Reviewed Benchmark",maximumCostUsd=0.01;
  const configuration=RunExperimentSchema.parse({operationId:"configuration",maximumCostUsd,graders:[grader],request:{
    schemaVersion:"openpond.modelTasksetRunRequest.v1",operationId:"configuration",teamId,modelProjectId:null,name,taskset:task,
    policy:{kind:"hosted_chat",modelId:base.modelId,maxOutputTokens:64,temperature:0,topP:1},population}});
  const draft=ExperimentDraftSchema.parse({schemaVersion:"openpond.experimentDraft.v1",id:"benchmark",operationType:"evaluate",name,
    startingModel:{source:"trained",label:"Exact Model",inferenceModelId:null,baseModel:base,trainedVersion:version},
    evaluationForm:{executionLocation:"hosted",selection:{release:task,mode:"subset",ids:[taskset.tasks[0]!.id]},source:null,
      form:{mode:"model",sourceId:"",profileChoiceId:"",name,release:task,
      modelId:"",budget:maximumCostUsd,outputTokens:64,prompt:"",targetId:"model",seed:"17",graderChoices:{[task.contentHash]:[grader]}}}});
  let actorId="actor",experimentId:string|null=null,swapArtifact=false;
  const request={teamId,operationId:"candidate-save",artifact:registryArtifact,configuration};
  const runtime={poolId:"pool",endpointId:"endpoint",baseProfileId:"base-profile",workerImageDigest:`sha256:${hash}`,modelId:`candidate:${registryArtifact.id}`};
  const preparationId="preparation",dispatchId="dispatch",sessionId="source-chat",revision=4;
  const trainingResult={schemaVersion:"openpond.trainingResult.v1",teamId,name:"Training result",model:null,savedVersion:null,request:trainingRequest,
    job:{schemaVersion:"openpond.trainingJob.v2",id:jobId,teamId,kind:"policy_optimize",modelProjectId:"model",portableProjectId:"portable",
      sourceProjectRevision:1,submissionHash:hash,state:"succeeded",phase:"completed",version:3,progress:1,rolloutProgress:{groupsCompleted:0,
        groupsTarget:0,optimizerUpdatesApplied:0,optimizerUpdatesSkipped:0},accruedSpendUsd:null,terminalReason:null,createdAt:at,updatedAt:at,completedAt:at},
    outputs:{schemaVersion:"openpond.trainingJobOutputs.v2",outputs:[{schemaVersion:"openpond.trainingJobOutput.v2",...versionArtifact,jobId,
      kind:"adapter",artifactRef:"retained",sizeBytes:10,metadata:{checkpointId:adapter.checkpointId},createdAt:at}],
      receipt:{schemaVersion:"openpond.trainingExecutionReceipt.v2",id:"receipt",teamId,jobId,submissionHash:hash,manifestHash:release.contentHash,
        recipeHash:hash,capabilityHash:hash,runtimeRelease:release,inputs:[release],outputs:[versionArtifact],spendUsd:0,durationSeconds:1,
        cleanupComplete:true,issuer:"fixture",issuedAt:at,signature:null}},candidate:{...adapter,registryArtifactId:registryArtifact.id},candidateState:"retained"};
  async function details() {
    const artifactHash=swapArtifact ? contentHash("substitute") : registryArtifact.contentHash;
    const runRequest={...configuration.request,operationId:dispatchId,policy:{kind:"hosted_chat" as const,modelId:runtime.modelId,
      maxOutputTokens:64,temperature:0,topP:1,candidate:{artifactId:registryArtifact.id,contentHash:artifactHash,preparationId,dispatchId,
        baseProfileId:runtime.baseProfileId,workerImageDigest:runtime.workerImageDigest}}};
    const policySnapshot={modelId:runtime.modelId,provider:"fixture",upstreamModelId:runtime.modelId,configurationHash:hash};
    const graders=[{id:grader.id,version:grader.version,contentHash:grader.contentHash,feedbackKey:"accuracy",release:null}];
    const admissionRequestHash=contentHash(runRequest);
    const content={request:runRequest,maximumCostUsd,graders,admissionRequestHash};
    const runConfiguration={...content,configurationHash:experimentRunConfigurationHash(content)};
    const manifest=createTasksetRunManifest({schemaVersion:"openpond.tasksetRunManifest.v1",id:experimentId!,tasksetRelease:legacy.tasksetRelease,
      packageHash:hash,execution:{kind:"harness",harnessRelease:legacy.harnessRelease},policy:{kind:"model",model:{provider:"fixture",model:runtime.modelId,
        revision:null,artifactHash,tokenizerRevision:null,chatTemplateHash:null},configurationHash:await canonicalSha256({policy:runRequest.policy,snapshot:policySnapshot})},
      gradingRole:"evaluation",metricPolicy:tasksetRunMetricPolicy(taskset),population,runtimeTarget:{...legacy.runtimeTarget,placement:"remote"},
      limits:{...legacy.limits,maximumSpendUsd:maximumCostUsd},createdAt:at,metadata:{experimentDefinition:null,
        experimentConfigurationHash:contentHash({definition:null,configurationHash:runConfiguration.configurationHash,admissionRequestHash,maximumCostUsd,graders})}});
    return {request:runRequest,configuration:runConfiguration,manifest,policySnapshot,summary:{schemaVersion:"openpond.modelTasksetRunSummary.v1",
      id:manifest.id,revision:1,teamId,modelProjectId:null,name,operationId:dispatchId,taskset:task,policyKind:"hosted_chat",manifestHash:manifest.contentHash,
      status:"queued",totalCount:1,counts:{pending:1,running:0,completed:0,failed:0,cancelled:0},createdAt:at,startedAt:null,completedAt:null,
      cleanupComplete:false,resultAvailable:false,score:null,metricName:manifest.metricPolicy.primaryMetric,error:null}};
  }
  const transport:typeof fetch=async(url,init)=>{
    expect(init?.method??"GET").toBe("GET");
    const pathname=new URL(String(url)).pathname;
    if(pathname.endsWith(`/candidate-evaluations/${preparationId}`))return Response.json({schemaVersion:"openpond.candidateEvaluationPreparation.v1",
      teamId,ownerUserId:"actor",id:preparationId,revision:1,requestHash:contentHash(request),request,trainingJobId:jobId,dispatchId,
      lastOperationId:null,runtime,state:experimentId ? "submitted" : "ready",experimentId,authorizedAt:at,cancelledAt:null,reason:null,createdAt:at,updatedAt:at});
    if(pathname.endsWith(`/jobs/${jobId}/result`))return Response.json({...trainingResult,contentHash:await canonicalSha256(trainingResult)});
    if(experimentId && pathname.endsWith(`/experiments/${experimentId}`))return Response.json(await details());
    throw new Error(`Unexpected read ${pathname}`);
  };
  const service=()=>createChatCloudExperiments({store,datasets:createLocalDatasetService({store,home}),fetch:transport,
    access:async()=>({apiBaseUrl:"https://example.test",token:"test",actorId,teamId})});
  let cloud=service();
  try{
    const binding={sessionId,preparationId,revision};
    const bound=await cloud.bindBenchmark({...binding,draft});
    expect(bound.benchmark).toMatchObject({id:draft.id,revision,draftHash:contentHash(draft),setupHash:contentHash(configuration),
      modelVersion:{versionHash:version.contentHash,jobId,artifact:versionArtifact}});
    cloud.close();cloud=service();
    experimentId="candidate-execution";swapArtifact=true;
    await expect(cloud.bindBenchmark(binding)).rejects.toThrow(/exact Benchmark candidate/i);
    expect(await cloud.list()).toHaveLength(0);
    swapArtifact=false;
    await expect(cloud.bindBenchmark({...binding,revision:revision+1})).rejects.toThrow("another Benchmark revision");
    const completed=await cloud.bindBenchmark(binding);
    expect(completed.summary).toMatchObject({id:experimentId,benchmark:bound.benchmark});
    expect(await cloud.request("status",{id:experimentId})).toMatchObject({summary:{benchmark:bound.benchmark}});
    actorId="other";
    await expect(cloud.bindBenchmark(binding)).rejects.toThrow(/linked account/);
  }finally{cloud.close();await store.close();await rm(home,{recursive:true,force:true});}
});
