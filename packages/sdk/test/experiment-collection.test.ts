import { describe, expect, it } from "vitest";
import { contentHash } from "@openpond/harness";
import { genericToolConformance } from "@openpond/evals/conformance";
import { createTasksetRunManifest, tasksetRunMetricPolicy } from "@openpond/evals/metrics";
import { OpenPondExperimentsClient, RunExperimentSchema, experimentRunConfigurationHash } from "../src/experiments.js";

describe("flat Experiment collection boundary", () => {
  // A workspace catalog must never accept another tenant's source, private
  // bytes, ambiguous duplicates or a non-advancing continuation as selectable.
  it("fences published Harness catalog scope, projection and paging",async()=> {
    const source={harnessRelease:{id:"harness-a",contentHash:"a".repeat(64)},agentSnapshot:{id:"agent-a",contentHash:"b".repeat(64)},sourcePackageHash:"c".repeat(64)};
    const item={name:"Released helper",source,ready:true,reason:null};
    let value:unknown={teamId:"team-a",items:[item],nextCursor:"next-page"};
    const client=new OpenPondExperimentsClient({baseUrl:"https://example.test",apiKey:"test",teamId:"team-a",fetch:async()=>Response.json(value)});
    await expect(client.harnessSources()).resolves.toMatchObject({items:[item]});
    for(const page of [
      {teamId:"team-b",items:[item],nextCursor:null},
      {teamId:"team-a",items:[{...item,sourceBytes:"private"}],nextCursor:null},
      {teamId:"team-a",items:[item,item],nextCursor:null},
      {teamId:"team-a",items:[{...item,ready:false}],nextCursor:null},
      {teamId:"team-a",items:[item],nextCursor:"current-page"},
    ]){value=page;await expect(client.harnessSources({cursor:"current-page"})).rejects.toThrow();}
  });
  // A retained collection must not leak private fields or accept foreign,
  // substituted, repeated or out-of-scope runs and continuations.
  it("binds retained rows and paging to the selected workspace and scope", async () => {
    const {taskset,manifest:legacy}=genericToolConformance;
    const operation=RunExperimentSchema.parse({operationId:"operation-a",maximumCostUsd:1,request:{
      schemaVersion:"openpond.modelTasksetRunRequest.v1",operationId:"operation-a",teamId:"team-a",modelProjectId:null,name:"Accuracy",
      taskset:{id:taskset.id,revision:1,contentHash:taskset.contentHash},policy:{kind:"fixture"},
      population:[{receiptId:"case-a",taskId:taskset.tasks[0]!.id,seed:"0",fixtureId:"correct"}],
    }});
    const request=operation.request;
    const graders=[{id:"grader",version:"1",contentHash:contentHash("grader"),feedbackKey:"accuracy",release:null}];
    const configurationContent={request,maximumCostUsd:1,graders,admissionRequestHash:contentHash(operation)};
    const configuration={...configurationContent,configurationHash:experimentRunConfigurationHash(configurationContent)};
    const context={definition:null,configurationHash:configuration.configurationHash,admissionRequestHash:configuration.admissionRequestHash,maximumCostUsd:1,graders};
    const manifest=createTasksetRunManifest({
      schemaVersion:"openpond.tasksetRunManifest.v1",id:"run-a",tasksetRelease:legacy.tasksetRelease,
      packageHash:contentHash("package"),execution:{kind:"harness",harnessRelease:legacy.harnessRelease},policy:{kind:"fixture"},
      gradingRole:"evaluation",metricPolicy:tasksetRunMetricPolicy(taskset),population:request.population,
      runtimeTarget:{...legacy.runtimeTarget,placement:"remote"},limits:{...legacy.limits,maximumSpendUsd:1},createdAt:legacy.createdAt,
      metadata:{experimentDefinition:null,experimentConfigurationHash:contentHash(context)},
    });
    const item={request,manifest,policySnapshot:null,configuration,summary:{
      schemaVersion:"openpond.modelTasksetRunSummary.v1",id:manifest.id,revision:1,teamId:request.teamId,modelProjectId:null,name:request.name,
      operationId:request.operationId,taskset:request.taskset,policyKind:"fixture",manifestHash:manifest.contentHash,
      status:"queued",totalCount:1,counts:{pending:1,running:0,completed:0,failed:0,cancelled:0},
      createdAt:manifest.createdAt,startedAt:null,completedAt:null,cleanupComplete:false,resultAvailable:false,
      score:null,metricName:manifest.metricPolicy.primaryMetric,error:null,
    }};
    let value:unknown={items:[item],nextCursor:null};
    const urls:URL[]=[];
    const client=new OpenPondExperimentsClient({baseUrl:"https://example.test",apiKey:"test",teamId:"team-a",fetch:async input=>{
      urls.push(new URL(String(input)));return Response.json(value);
    }});
    await expect(client.list({projectId:undefined,afterId:undefined,search:undefined,limit:30})).resolves.toMatchObject({items:[item]});
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({limit:"30"});
    for (const page of [
      {items:[{...item,expectedOutput:{answer:"private"}}],nextCursor:null},
      {items:[{...item,summary:{...item.summary,teamId:"team-b"}}],nextCursor:null},
      {items:[{...item,summary:{...item.summary,policyKind:"hosted_chat"}}],nextCursor:null},
      {items:[item,item],nextCursor:null},
      {items:[item],nextCursor:"other-run"},
    ]) {value=page;await expect(client.list()).rejects.toThrow();}
    value={items:[item],nextCursor:null};
    await expect(client.list({status:"failed"})).rejects.toThrow();
    await expect(client.list({datasetHash:"b".repeat(64)})).rejects.toThrow();
    await expect(client.list({projectId:"foreign-project"})).rejects.toThrow();
  });
});
