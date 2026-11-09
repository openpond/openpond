import { describe, expect, it } from "vitest";
import { createTrainingClient, canonicalJson, canonicalSha256, parseAndVerifyWeightSpacePrepare,
  parseAndVerifyWeightSpaceCommandResult, type WeightSpaceRequest, type WeightSpaceCommand } from "../src/training.js";
import { resolveWeightSpaceTasksetPanel } from "../src/weight-space-evaluation.js";
import { ordinaryToolTaskset } from "./fixtures/ordinary-tool-taskset.js";
import { bindTasksetExecutionReleases, createEnvironmentRelease } from "@openpond/evals";
import { contentHash } from "@openpond/harness";
import { createTasksetPackage } from "../src/taskset-packages.js";
const hash="a".repeat(64);
const request:WeightSpaceRequest={schemaVersion:"openpond.weightSpaceRequest.v1",model:{schemaVersion:"openpond.neuronSteeringModel.v1",
  modelId:"Qwen/Qwen3-8B",revision:"b968826d9c46dd6066d109eabc6255188de91218",configHash:hash,weightsHash:hash,tokenizerHash:hash,
  weightIdentity:"torch_state_dict_sha256_v1",architecture:"dense_decoder",dtype:"bfloat16",quantization:"none",adapter:null,
  hiddenSize:4096,intermediateSizes:Array(36).fill(12288)},teacher:{controller:"local_agent",providerId:"fixture",modelId:"teacher",sessionId:"chat"},
  objective:"Inspect and edit parameters",panels:[{id:"practice",source:null,role:"development",prompts:[{id:"one",text:"Practice only"}]}],frozenEvaluation:null,
  generation:{maxOutputTokens:4,seed:0,sampling:"greedy_v1"},limits:{maximumDurationSeconds:60,maximumIdleSeconds:30,maximumCommands:10,
    maximumCandidates:4,maximumPatchColumns:4,maximumTensorElements:65536,maximumReturnedValues:16,maximumArithmeticWork:1000000,
    maximumForwardTokenWork:1000,maximumCheckpointBytes:1048576}};
const seal=async<T extends object>(content:T)=>({...content,contentHash:await canonicalSha256(content)});

describe("weight-space command authority",()=>{
  // A private dataset package must not expose its answers, verifier source or
  // held-out tasks when the same projection prepares iterative agent feedback.
  it("projects exact text inputs without private answers or held-out feedback",()=>{
    const original=ordinaryToolTaskset();
    const {contentHash:_environmentHash,...environmentBody}=original.environment;
    const environment=createEnvironmentRelease({...environmentBody,
      contract:{...original.environment.contract,kind:"text",entrypoint:"openpond.text.v1",stateful:false},metadata:{}});
    const {contentHash:_hash,...source}=original.taskset;
    const task={...source.tasks[0]!,privilegedContextRef:null,expectedOutput:{answer:"private-gold-answer"}};
    const release=bindTasksetExecutionReleases({environment,verifierSet:original.verifierSet,
      taskset:{...source,environment:environment.contract,tools:[],tasks:[task,{...task,id:"practice",clusterKey:"practice",split:"validation"}],
        contentHash:contentHash({...source,environment:environment.contract,tools:[],tasks:[task,{...task,id:"practice",clusterKey:"practice",split:"validation"}]})}});
    const {contentHash:_package,...body}=original;
    const value=createTasksetPackage({...body,taskset:release,environment});
    const sourceRef={id:release.id,revision:release.revision,contentHash:release.contentHash};
    const {panel}=resolveWeightSpaceTasksetPanel(value,{source:sourceRef,role:"frozen"});
    expect(panel.prompts.map(row=>row.id)).toEqual([task.id]);
    expect(panel.prompts[0]!.text).toBe(JSON.stringify({input:task.input,policyVisibleContext:task.policyVisibleContext}));
    expect(JSON.stringify(panel)).not.toContain("private-gold-answer");
    expect(JSON.stringify(panel)).not.toContain("export function verify");
    expect(()=>resolveWeightSpaceTasksetPanel(value,{source:sourceRef,role:"development",taskIds:[task.id]})).toThrow();
    expect(()=>resolveWeightSpaceTasksetPanel(value,{source:{...sourceRef,revision:2},role:"frozen"})).toThrow();
    const practice=resolveWeightSpaceTasksetPanel(value,{source:sourceRef,role:"development",taskIds:["practice"]});
    expect(practice.panel.prompts.map(row=>row.id)).toEqual(["practice"]);
  });
  // A correctly hashed response is still unsafe if it binds another tenant, price or candidate.
  it("binds preparation and queued/recovered commands to exact scope and retained IDs",async()=>{
    const input=await parseAndVerifyWeightSpacePrepare({teamId:"team",operationId:"prepare",projectId:null,name:"Weight study",method:"weight_space_programming",
      query:{teamId:"team",source:"managed",modelId:request.model.modelId,revision:request.model.revision,tokenizerRevision:request.model.revision,chatTemplateHash:hash},request,maximumSpendUsd:"1"});
    expect(input.maximumSpendUsd).toBe("1.000000");
    const id=`modification-${await canonicalSha256({teamId:"team",ownerUserId:"actor",operationId:"prepare"})}`;
    const metadata={id,teamId:"team",ownerUserId:"actor",projectId:null,name:input.name,method:input.method,phase:"prepared",revision:1,
      sourceContentHash:hash,plan:{contentHash:hash,inputHash:await canonicalSha256(request),runtimeHash:hash,maximumSpendUsd:input.maximumSpendUsd,
        createdAt:"2026-11-08T12:00:00.000Z",expiresAt:"2026-11-08T12:05:00.000Z"},session:null,updatedAt:"2026-11-08T12:00:00.000Z"};
    const prepared=await seal({schemaVersion:"openpond.weightSpaceExecutionReceipt.v1",operationId:input.operationId,
      requestHash:await canonicalSha256({action:"prepare",command:input}),execution:metadata});
    const command:WeightSpaceCommand={teamId:"team",sessionId:id,operationId:"inspect-once",expectedRevision:1,candidateHash:hash,
      action:"inspect",layer:0,columns:[0]};
    const queued=await seal({schemaVersion:"openpond.weightSpaceCommandReceipt.v1",teamId:"team",ownerUserId:"actor",command,
      requestHash:await canonicalSha256(command),state:"queued",result:null});
    const paths:string[]=[],bodies:string[]=[];
    let altered=false;
    const client=createTrainingClient({baseUrl:"https://fixture.invalid",fetch:async(url,init)=>{
      paths.push(new URL(String(url)).pathname);if(init?.body)bodies.push(String(init.body));
      const value=paths.at(-1)!.endsWith("/prepare")?prepared:altered?await seal({...queued,teamId:"other-team",contentHash:undefined}):queued;
      return new Response(JSON.stringify(value),{headers:{"content-type":"application/vnd.openpond.training+json;version=2"}});
    }});
    expect((await client.prepareWeightSpaceSession(input)).execution.id).toBe(id);
    expect((await client.commandWeightSpaceSession(command)).state).toBe("queued");
    expect((await client.getWeightSpaceCommand("team",id,command.operationId)).command).toEqual(command);
    expect(paths).toEqual(["/v1/training/weight-space-sessions/prepare",`/v1/training/weight-space-sessions/${id}/commands`,
      `/v1/training/weight-space-sessions/${id}/commands/${command.operationId}`]);
    expect(bodies).toEqual([canonicalJson(input),canonicalJson(command)]);
    altered=true;
    await expect(client.commandWeightSpaceSession(command)).rejects.toThrow();
  });
  it("rejects candidate substitution, frozen feedback and unsupported executable instructions",async()=>{
    const command:WeightSpaceCommand={teamId:"team",sessionId:"session",operationId:"inspect",expectedRevision:1,candidateHash:hash,action:"inspect",layer:0,columns:[0]};
    const forged=await seal({schemaVersion:"openpond.weightSpaceCommandResult.v1",sessionId:"session",operationId:"inspect",requestHash:await canonicalSha256(command),
      revision:2,parentCandidateHash:hash,candidateHash:"b".repeat(64),changedColumns:[],status:"succeeded",code:null,catalog:null,tensors:{},evaluation:null,
      usage:{commands:1,candidates:0,arithmeticWork:1,forwardTokenWork:0}});
    await expect(parseAndVerifyWeightSpaceCommandResult(forged,command)).rejects.toThrow();
    const frozen={id:"dataset",revision:1,contentHash:hash};
    const {WeightSpaceRequestSchema,WeightSpaceProgramSchema}=await import("../src/training.js");
    expect(WeightSpaceRequestSchema.safeParse({...request,frozenEvaluation:frozen,panels:[{...request.panels[0]!,source:frozen}]}).success).toBe(false);
    expect(WeightSpaceProgramSchema.safeParse({instructions:[{op:"python",code:"import os"}],returns:[]}).success).toBe(false);
    const finalEvaluation={panelId:frozen.id,source:frozen,role:"frozen",candidateHash:hash,sampling:"greedy_v1",seed:0,
      rows:[{id:"hidden",inputHash:hash,outputIds:[1],outputText:"held-out output",reachedTokenLimit:false,forwardTokenWork:2}],
      baseline:{candidateHash:"c".repeat(64),rows:[{id:"hidden",inputHash:hash,outputIds:[2],outputText:"base output",reachedTokenLimit:false,forwardTokenWork:2}]}};
    const {contentHash:_old,...original}=forged;
    // Even an internally consistent hash cannot turn held-out output into
    // iterative inspection feedback or bind it to a different final candidate.
    await expect(parseAndVerifyWeightSpaceCommandResult(await seal({...original,candidateHash:hash,finalEvaluation}),command)).rejects.toThrow();
    const finalCommand={...command,action:"finalize" as const};
    const final=await seal({...original,candidateHash:hash,requestHash:await canonicalSha256(finalCommand),finalEvaluation});
    expect((await parseAndVerifyWeightSpaceCommandResult(final,finalCommand)).finalEvaluation).toEqual(finalEvaluation);
    await expect(parseAndVerifyWeightSpaceCommandResult(await seal({...original,candidateHash:hash,
      requestHash:await canonicalSha256(finalCommand),finalEvaluation:{...finalEvaluation,candidateHash:"b".repeat(64)}}),finalCommand)).rejects.toThrow();
    const {ExperimentScoringRequestSchema}=await import("../src/experiments.js");
    const scoring={operationId:"score",execution:{id:"session",contentHash:hash},executionKind:"weight_space",
      weightSpaceOperationId:"final",weightSpaceTarget:"baseline",graders:[{id:"grader",revision:1,contentHash:hash}],maximumCostUsd:1};
    expect(ExperimentScoringRequestSchema.safeParse(scoring).success).toBe(true);
    expect(ExperimentScoringRequestSchema.safeParse({...scoring,weightSpaceTarget:undefined}).success).toBe(false);
    expect(ExperimentScoringRequestSchema.safeParse({...scoring,executionKind:undefined}).success).toBe(false);
  });
});
