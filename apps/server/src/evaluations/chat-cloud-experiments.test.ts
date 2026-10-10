import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {expect,test} from "vitest";
import {contentHash} from "@openpond/harness";
import {canonicalSha256} from "../../../../packages/sdk/src/protocol.js";
import {genericToolConformance} from "@openpond/evals/conformance";
import {createTasksetRunManifest,tasksetRunMetricPolicy} from "@openpond/evals/metrics";
import {RunExperimentSchema,experimentRunConfigurationHash,type ExperimentRunDetails} from "openpond-sdk/experiments";
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
