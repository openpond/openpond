import type { ChatExperimentView } from "./chat-cloud-experiments.js";
import { compareExperiments } from "@openpond/evals/experiments";
import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { LocalExperimentRunSchema, type ChatResourceSummary, type LocalExperimentRecord, type LocalExperimentResult } from "@openpond/contracts";
import { createLocalExperimentService } from "./local-experiment-service.js";
import { createLocalInferenceOwner, type LocalInferenceState } from "./local-experiment-local-inference.js";
import { createClaudeCodeOwner } from "./claude-code-owner.js";
import {createCodexExperimentOwner} from "./codex-experiment-owner.js";
import { createLocalExperimentEnvironment } from "./local-experiment-environment.js";
import type { SqliteStore } from "../store/store.js";
import type { createLocalDatasetService } from "../training/local-dataset-service.js";
import { loadOpenPondHostedModels,streamOpenPondHostedChatTurn } from "@openpond/runtime";
import { prepareLocalExperimentModel } from "./local-experiment-model.js";
import {readCachedTasksetPackage} from "../training/taskset-package-files.js";

export function chatExperimentSummary(record:LocalExperimentRecord,result?:LocalExperimentResult):ChatResourceSummary {
  const scored = result?.cases.filter(c => c.status==="completed" && c.grade?.gradingStatus==="scored" && c.grade.score !== null) ?? [];
  const qualityFailureCount=result?.cases.filter(c=>c.status==="completed" && c.grade?.gradingStatus==="scored" && c.grade.passed===false).length ?? 0;
  const executionFailureCount=result?.cases.filter(c=>c.status==="failed" || c.status==="unknown").length ?? record.counts.failed+record.counts.unknown;
  const local = record.configuration.request.taskset;
  return {kind:"experiment",location:"local",scoreLabel:"Mean task score",id:record.id,revision:1,name:record.configuration.request.name ?? record.id,state:record.status,
    datasetId:local.id,datasetRevision:local.revision,model:`${record.model.providerId}/${record.model.modelId}`,
    taskCount:record.configuration.request.population.length,evaluatedCount:scored.length,
    failedCount:qualityFailureCount+executionFailureCount,qualityFailureCount,executionFailureCount,ungradedCount:record.configuration.request.population.length-scored.length,
    score:record.status === "completed" && scored.length === record.configuration.request.population.length ? scored.reduce((sum,c) => sum+c.grade!.score!,0)/scored.length : null,
    costUsd:record.model.providerId === "codex" ? null : record.usage.costUsd,
    rows:(result?.cases ?? []).slice(0,3).map(c => ({id:c.receiptId,label:c.taskId,detail:c.error ?? c.grade?.failureClass ?? c.status,score:c.grade?.score ?? null}))};
}

export const ChatExperimentRun = z.object({datasetId:z.string().min(1),revision:z.number().int().positive(),operationId:z.string().min(1).max(120),
  maximumCostUsd:z.number().positive().max(10000),taskLimit:z.number().int().min(1).max(100).default(10),seed:z.number().int().min(0).max(2147483647).default(0),
  maxOutputTokens:z.number().int().positive().max(262144).default(1024),
  models:z.array(z.object({providerId:z.enum(["openpond","custom-openai-compatible","claude-code","codex"]),modelId:z.string().min(1)}).strict()).min(1).max(8),
}).strict();
const ChatLocalExperimentRun=ChatExperimentRun.extend({maximumCostUsd:ChatExperimentRun.shape.maximumCostUsd.optional()});
export function localExperimentView(evidence:LocalExperimentResult):ChatExperimentView {
  return {contentHash:evidence.contentHash,graders:"graders" in evidence.execution ? evidence.execution.graders : null,scope:"packageHash" in evidence.execution ? evidence.execution.packageHash : "",cases:evidence.cases.map(row=>({id:row.receiptId,taskId:row.taskId,seed:row.seed,status:row.status,error:row.error,output:row.output,score:row.grade?.score ?? null}))};
}
const HostedPin=z.object({actorId:z.string().min(1),teamId:z.string().min(1),apiOrigin:z.url()}).strict();
const Group = z.object({packageHash:z.string().regex(/^[a-f0-9]{64}$/),hosted:HostedPin.nullable(),configurations:z.array(LocalExperimentRunSchema.shape.configuration).min(1).max(8)}).strict();

/** Same durable evaluation service and accounting as the workspace path, with
 * an explicit installation scope and locally retained package source. */
export async function createChatExperiments(deps:{store:SqliteStore;home:string;ownerId:string;state:LocalInferenceState;datasets:ReturnType<typeof createLocalDatasetService>;
  codexStatus?:()=>Promise<import("@openpond/contracts").CodexStatus>;
  hosted?:{access:()=>Promise<{apiBaseUrl:string;actorId:string;teamId:string}>;catalog?:typeof loadOpenPondHostedModels;stream?:typeof streamOpenPondHostedChatTurn};
}) {
  const scope = await deps.store.localResourceOwnerId();
  const identity = {actorId:async()=>scope,teamId:async()=>scope};
  const loopback = createLocalInferenceOwner(deps.state);
  const claude = createClaudeCodeOwner({state:deps.state,store:deps.store,ownerId:deps.ownerId,...identity});
  const codex = createCodexExperimentOwner({state:deps.state,status:deps.codexStatus});
  const prepareNative=(configuration:Parameters<typeof loopback.prepare>[0])=>configuration.request.policy.kind === "hosted_chat" && configuration.request.policy.localRuntime?.providerId === "codex" ? codex.prepare(configuration) : configuration.request.policy.kind === "hosted_chat" && configuration.request.policy.localRuntime?.providerId === "claude-code" ? claude.prepare(configuration) : loopback.prepare(configuration);
  async function hostedPin() {
    if(!deps.hosted)throw new Error("This installation has no hosted inference provider.");
    const access=await deps.hosted.access();
    return HostedPin.parse({actorId:access.actorId,teamId:access.teamId,apiOrigin:new URL(access.apiBaseUrl).origin});
  }
  async function groupForOperation(operationId:string) {
    const parent=operationId.slice(0,operationId.lastIndexOf(":"));
    const retained=await deps.store.readChatExperimentGroup(parent);
    if(!retained)throw new Error("The retained Experiment group is unavailable.");
    return Group.parse(retained);
  }
  async function requireHosted(group:z.infer<typeof Group>) {
    if(!group.hosted || contentHash(await hostedPin())!==contentHash(group.hosted))throw new Error("Select the account and workspace pinned to this Experiment before inference.");
  }
  async function summary(record:LocalExperimentRecord,evidence?:LocalExperimentResult) {
    const value=await readCachedTasksetPackage(deps.home,record.packageHash);
    const source=z.object({sourceTasksetId:z.string().min(1),sourcePackageHash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(value.taskset.metadata);
    const dataset=await deps.store.readLocalDatasetByWorkspaceHash(source.sourceTasksetId,source.sourcePackageHash);
    if(!dataset || dataset.ownerId!==scope)throw new Error("The Experiment's exact authored Dataset source is unavailable.");
    const retained=evidence ?? await service.result({teamId:scope,id:record.id});
    return {...chatExperimentSummary(record,retained),datasetId:dataset.workspace.draft.id,datasetRevision:dataset.workspace.draft.revision};
  }
  async function hostedChoices() {
    try {
      const pin=await hostedPin();
      const catalog=await (deps.hosted?.catalog ?? loadOpenPondHostedModels)();
      if(contentHash(await hostedPin())!==contentHash(pin))throw new Error("Hosted account changed while loading models.");
      const models=[];
      for(const model of catalog.models) {
        try {
          const raw=model.raw as {output_limit?:number};
          const outputLimit=raw.output_limit ?? 0;
          const admission=await prepareLocalExperimentModel({kind:"hosted_chat",modelId:model.id,maxOutputTokens:Math.min(1024,outputLimit),temperature:0,topP:1},async()=>catalog);
          models.push({id:model.id,name:model.displayName,providerId:"openpond" as const,configurationHash:admission.model.configurationHash,outputLimit});
        } catch {/* Only models with qualified pricing and bounds can be run. */}
      }
      return {models,status:catalog.error ?? "Ready"};
    } catch(error) {return {models:[],status:error instanceof Error ? error.message : "Hosted models unavailable."};}
  }
  async function choices() {
    const [local,readiness,hosted,codexReadiness] = await Promise.all([loopback.choices(),claude.readiness(),hostedChoices(),codex.readiness()]);
    return {models:[...local,...codexReadiness.choices,...readiness.choices.map(c => ({...c,providerId:"claude-code" as const,executableHash:readiness.ready ? readiness.executableHash : undefined,capabilityHash:readiness.ready ? readiness.capabilityHash : undefined,version:readiness.ready ? readiness.version : undefined})),...hosted.models],codexStatus:codexReadiness.ready ? "Ready" : codexReadiness.reason,claudeStatus:readiness.ready ? "Ready" : readiness.reason,hostedStatus:hosted.status};
  }
  const service = createLocalExperimentService({store:deps.store,storeDir:deps.home,ownerId:deps.ownerId,managesRuntimeLease:false,...identity,
    catalog:deps.hosted?.catalog,
    stream:deps.hosted?.stream,
    prepareModel:async configuration=>{
      const policy=configuration.request.policy;
      if(policy.kind==="hosted_chat" && policy.localRuntime)return prepareNative(configuration);
      const group=await groupForOperation(configuration.operationId);await requireHosted(group);
      return prepareLocalExperimentModel(policy,deps.hosted?.catalog ?? loadOpenPondHostedModels);
    },
    authorizeTransport:async id=>{
      const record=await deps.store.readLocalExperimentRecord(scope,id);
      const group=await groupForOperation(record.operationId);
      if(group.hosted)await requireHosted(group);
    },
    runtimeEventsForTurn:id=>deps.store.runtimeEventsForTurn(id),environment:createLocalExperimentEnvironment(),
    localInference:{choices:async()=> (await choices()).models,claudeReadiness:claude.readiness,claudeControl:claude.control,
      prepare:prepareNative},
    authorizeProject:async configuration => {
      if (configuration.request.project || configuration.request.modelProjectId || configuration.request.policy.kind !== "hosted_chat") throw new Error("Independent local experiments require a configured model provider and locally pinned inputs.");
    }});
  async function run(raw:unknown) {
    const parsed = ChatLocalExperimentRun.parse(raw);
    const {record,package:value} = await deps.datasets.packageDataset(parsed.datasetId,parsed.revision);
    const subscriptionOnly=parsed.models.every(model=>model.providerId==="codex") && !record.workspace.draft.graders.some(grader=>grader.kind==="model_judge");
    if(parsed.maximumCostUsd===undefined && !subscriptionOnly)throw new Error("Select a positive total budget for metered model calls or model-judge grading.");
    // The shared durable owner reserves uncertain provider requests. Its
    // internal ceiling is not a subscription price or a measured dollar cost.
    const input={...parsed,maximumCostUsd:parsed.maximumCostUsd ?? 10000};
    if (new Set(input.models.map(m => `${m.providerId}/${m.modelId}`)).size !== input.models.length) throw new Error("Select each evaluated model once.");
    const perRunBudget = Math.floor(input.maximumCostUsd*1_000_000/input.models.length)/1_000_000;
    if (perRunBudget < 0.000001) throw new Error("The total budget is too small for the selected models.");
    const requestHash = contentHash({scope,input});
    let retained = await deps.store.readChatExperimentGroup(input.operationId,requestHash);
    if (!retained) {
      const catalog = await choices();
      const hosted=input.models.some(model=>model.providerId==="openpond") || record.workspace.draft.graders.some(grader=>grader.kind==="model_judge") ? await hostedPin() : null;
      const configurations = input.models.map((selected,index) => {
        const model = catalog.models.find(m => m.providerId === selected.providerId && m.id === selected.modelId);
        if (!model) throw new Error("The selected evaluated model is unavailable: "+selected.providerId+"/"+selected.modelId+".");
        const operationId = input.operationId+":"+index;
        const population = value.taskset.tasks.slice(0,input.taskLimit).map(task => ({receiptId:"case-"+contentHash([operationId,task.id,input.seed]).slice(0,40),taskId:task.id,seed:String(input.seed),fixtureId:null}));
        if (!population.length) throw new Error("This saved Dataset has no runnable tasks.");
        const requestBudget = Math.floor(perRunBudget*1_000_000/population.length)/1_000_000;
        if (requestBudget < 0.000001) throw new Error("The total budget cannot cover a positive allocation for every selected task.");
        const common = {configurationHash:model.configurationHash,maximumRequestCostUsd:requestBudget,requestTimeoutMs:120_000};
        const localRuntime = selected.providerId === "codex" && "accountHash" in model ? {providerId:"codex",...common,accountHash:model.accountHash,reasoningEffort:model.reasoningEffort} : selected.providerId === "claude-code" && "executableHash" in model ? {providerId:"claude-code",...common,executableHash:model.executableHash,capabilityHash:model.capabilityHash,version:model.version,maximumTurns:1,holdOpen:false} : {providerId:"custom-openai-compatible",...common};
        return LocalExperimentRunSchema.shape.configuration.parse({operationId,maximumCostUsd:perRunBudget,request:{schemaVersion:"openpond.modelTasksetRunRequest.v1",operationId,teamId:scope,modelProjectId:null,
          name:record.workspace.draft.name+" · "+selected.modelId,taskset:{id:value.taskset.id,revision:value.taskset.revision,contentHash:value.taskset.contentHash},population,
          policy:{kind:"hosted_chat",modelId:selected.modelId,maxOutputTokens:Math.min(input.maxOutputTokens,model.outputLimit!),temperature:0,topP:1,...selected.providerId==="openpond" ? {} : {localRuntime}}}});
      });
      retained = await deps.store.prepareChatExperimentGroup(input.operationId,requestHash,{packageHash:value.contentHash,hosted,configurations});
    }
    const group = Group.parse(retained);
    if (group.packageHash !== value.contentHash) throw new Error("The retained group requires its exact saved Dataset package.");
    const runs:LocalExperimentRecord[] = [];
    const errors:{modelId:string;message:string}[]=[];
    // Disjoint allocations bound the whole group, including every run's judges,
    // retries and unresolved reservations. No turn owns the execution lifetime.
    for (const configuration of group.configurations) {
      try {runs.push(await service.run({configuration,package:value}));}
      catch(error){errors.push({modelId:configuration.request.policy.kind === "fixture" ? "fixture" : configuration.request.policy.modelId,message:error instanceof Error ? error.message : "Run admission failed."});}
    }
    if(!runs.length && errors.length)throw new Error(errors.map(error=>error.modelId+": "+error.message).join("\n"));
    return {runs,errors,summaries:await Promise.all(runs.map(async record=>summary(record,
      record.status === "completed" ? await service.result({teamId:scope,id:record.id}) : undefined))),maximumCostUsd:input.maximumCostUsd};
  }
  async function request(raw:unknown) {
    const input = z.object({action:z.enum(["models","run","list","read","status","cancel","result","compare","case"]),payload:z.record(z.string(),z.unknown()).default({})}).strict().parse(raw);
    if (input.action === "models") return choices();
    if (input.action === "run") return run(input.payload);
    const result = await service.request({teamId:scope,action:input.action,payload:input.payload});
    if(input.action === "list") {
      const page=result as Awaited<ReturnType<typeof service.list>>;
      return {...page,summaries:await Promise.all(page.items.map(record=>summary(record)))};
    }
    if(input.action === "compare") {const evidence=result as Awaited<ReturnType<typeof service.compare>>;return {...evidence,comparison:compareExperiments(evidence.baseline,evidence.candidate)};}
    if (["read","status","cancel","result"].includes(input.action) && typeof input.payload.id === "string") {
      const record = await service.read({teamId:scope,id:input.payload.id});
      const evidence = await service.result({teamId:scope,id:record.id});
      return {result,summary:await summary(record,evidence),evidence,view:localExperimentView(evidence)};
    }
    return result;
  }
  return {service,request,run,scope,summary};
}
