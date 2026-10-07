import {readLocalProfileArtifacts} from "./local-profile-artifacts.js";
import {ExperimentScoringRequestSchema} from "openpond-sdk/experiments";
import {verifySelectedRewardClosure,type LocalRewardGradingResolver} from "./local-reward-grading.js";
import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { validateTasksetPackage } from "openpond-sdk/taskset-packages";
import type { streamOpenPondHostedChatTurn, loadOpenPondHostedModels } from "@openpond/runtime";
import type { LocalExperimentStorage } from "../store/store-local-experiments.js";
import { LocalExperimentScoreSchema, LocalExperimentExecutionSchema, LocalExperimentError, type LocalExperimentExecution } from "./local-experiment-contract.js";
import { selectLocalPackageGraders } from "./local-experiment-admission.js";
import { gradeLocalExperimentCase } from "./local-experiment-grading.js";
import { localRetainedCase, sealLocalRetainedCase, localEvaluatorContext } from "./local-experiment-output.js";
import { createLearningHostedJudgeProvider } from "../training/learning-hosted-judge-provider.js";

export function createLocalExperimentScoring(deps:{runtimeEventsForTurn?:(id:string)=>Promise<import("@openpond/contracts").RuntimeEvent[]>;storeDir?:string;store:LocalExperimentStorage;ownerId:string;requireTeam:(teamId:string)=>Promise<void>;
  requireActor:(actorId:string)=>Promise<void>;
  requireExecution:(teamId:string,id:string)=>Promise<void>;
  streamForActor:(actorId:string,teamId:string)=>typeof streamOpenPondHostedChatTurn;
  resolveSelectedRewards?:LocalRewardGradingResolver;active:Map<string,Promise<void>>;controllers:Map<string,AbortController>;stream?:typeof streamOpenPondHostedChatTurn;catalog?:typeof loadOpenPondHostedModels}) {
  async function score(raw:unknown,teamId:string,selected=false) {
    await deps.requireTeam(teamId);
    const selectedSchema=LocalExperimentScoreSchema.omit({graderPackage:true,graders:true}).extend({graders:ExperimentScoringRequestSchema.shape.graders,mappings:ExperimentScoringRequestSchema.shape.mappings});
    const input=selected?selectedSchema.parse(raw):LocalExperimentScoreSchema.parse(raw);
    await deps.requireExecution(teamId,input.execution.id);
    const source=await deps.store.readLocalExecution(teamId,input.execution.id);await deps.requireActor(source.execution.ownerActorId);
    const intentHash=contentHash({ownerActorId:source.execution.ownerActorId,input});
    const prior=await deps.store.recoverLocalExperimentOperation(teamId,input.operationId,"score",intentHash);
    if(prior)return (await deps.store.readLocalExecution(teamId,LocalExperimentExecutionSchema.parse(prior).id)).execution;
    if(source.execution.executionHash!==input.execution.executionHash || source.execution.kind!=="target")throw new LocalExperimentError("local_scoring_source_conflict","Select the exact original local execution.");
    const independent=selected?await deps.resolveSelectedRewards?.(teamId,source.execution.ownerActorId,selectedSchema.parse(input)):undefined;
    if(selected&&!independent)throw new Error("This owner cannot resolve the exact selected Reward closure.");
    const value=independent?.closure??validateTasksetPackage("graderPackage" in input?input.graderPackage:null),graders=independent?.graders??selectLocalPackageGraders(validateTasksetPackage(value),LocalExperimentScoreSchema.parse(input).graders);
    const id=`local-score-${contentHash([teamId,input.operationId]).slice(0,48)}`;
    const execution=LocalExperimentExecutionSchema.parse({...source.execution,id,operationId:input.operationId,kind:"scoring",
      sourceExecution:input.execution,executionHash:contentHash({id,source:input.execution,graderPackage:value.contentHash,graders,maximumCostUsd:input.maximumCostUsd}),
      maximumCostUsd:input.maximumCostUsd,status:"queued",createdAt:new Date().toISOString(),completedAt:null,
      counts:{pending:source.cases.length,running:0,completed:0,failed:0,cancelled:0,unknown:0},usage:{knownCostUsd:0,costUsd:0,heldUsd:0,uncertainRequests:0},cleanupComplete:false,error:null});
    const admitted=await deps.store.startLocalScoringPass({operationId:input.operationId,intentHash,ownerId:deps.ownerId,execution,
      admissions:source.cases.map(row=>row.admission),package:value,graders});
    if(!deps.active.has(id)) {
      const work=run(admitted).finally(()=>{deps.active.delete(id);deps.controllers.delete(id);});deps.active.set(id,work);
    }
    return admitted;
  }
  async function run(execution:LocalExperimentExecution) {
    const controller=new AbortController();deps.controllers.set(execution.id,controller);
    let error:string|null=null;
    try {
      const selection=await deps.store.readLocalScoringSelection(execution.teamId,execution.id);
      const independent=typeof selection.package==="object"&&selection.package!==null&&"schemaVersion" in selection.package&&selection.package.schemaVersion==="openpond.localSelectedRewardClosure.v1"?verifySelectedRewardClosure(selection.package).closure:null;
      const value=independent?null:validateTasksetPackage(selection.package),source=await deps.store.readLocalExecution(execution.teamId,selection.sourceExecutionId);
      const original=await deps.store.readLocalExperiment(execution.teamId,source.execution.definition.id,source.execution.definition.revision);
      const originalPackage=validateTasksetPackage(original.package);
      const pins=independent?{graders:independent.rewards.map(reward=>({id:reward.id,revision:reward.revision,contentHash:reward.contentHash})),mappings:selection.graders.map(pin=>({graderId:pin.id,fields:pin.mappings??[]}))}:null;
      async function current(){controller.signal.throwIfAborted();const actual=await deps.store.readLocalExecution(execution.teamId,execution.id);if(!["queued","running"].includes(actual.execution.status))throw new Error("The actual local grading pass is no longer active.");await deps.requireTeam(execution.teamId);await deps.requireActor(execution.ownerActorId);await deps.requireExecution(execution.teamId,selection.sourceExecutionId);if(independent){const actual=await deps.resolveSelectedRewards?.(execution.teamId,execution.ownerActorId,pins!);if(!actual||contentHash(actual.closure)!==contentHash(independent))throw new Error("The selected Reward source changed during grading.");await actual.authorize();}controller.signal.throwIfAborted();}
      await current();
      for(const row of source.cases) {
        if(!await deps.store.admitLocalCase(execution.teamId,execution.id,row.receiptId,deps.ownerId))break;
        try {
          controller.signal.throwIfAborted();
          if(!row.result)throw new LocalExperimentError("local_scoring_evidence_missing","This original case has no retained target output.",422);
          const retained=localRetainedCase(row.result),task=originalPackage.taskset.tasks.find(task=>task.id===row.admission.taskId)!;
          const artifacts=await readLocalProfileArtifacts({storeDir:deps.storeDir,attempt:retained.attempt,signal:controller.signal,events:async id=>{if(!deps.runtimeEventsForTurn)throw new Error("The actual artifact trace owner is unavailable.");return deps.runtimeEventsForTurn(id);},authorize:current});
          const grade=await gradeLocalExperimentCase({store:deps.store,ownerId:deps.ownerId,teamId:execution.teamId,executionId:execution.id,caseId:row.receiptId,
            ...(independent?{selectedRewards:independent}:{package:value!}),beforeDispatch:current,task,evidence:{output:{text:retained.attempt.output??"",...(artifacts.length?{artifacts}:{})},runtimeEventRefs:retained.attempt.native?.runtimeEventRefs??retained.attempt.profileNative?.runtimeEventRefs??[],artifactRefs:Array.isArray(retained.attempt.artifactRefs)?retained.attempt.artifactRefs.map(ref=>{if(!ref||typeof ref!=="object"||!("id" in ref)||typeof ref.id!=="string")throw new Error("The retained artifact identity changed.");return ref.id;}):[],
              infrastructureError:row.status==="completed"?null:row.error??row.status},
            evaluatorContext:localEvaluatorContext(retained.attempt),
            graders:selection.graders,signal:controller.signal,judgeProvider:createLearningHostedJudgeProvider({stream:deps.streamForActor(execution.ownerActorId,execution.teamId),catalog:deps.catalog})});
          await current();
          await deps.store.settleLocalCase({teamId:execution.teamId,id:execution.id,receiptId:row.receiptId,ownerId:deps.ownerId,status:"completed",result:sealLocalRetainedCase(retained.attempt,grade),error:null});
        } catch(cause) {
          error=(cause instanceof Error?cause.message:"Local scoring failed.").slice(0,2000);
          await deps.store.settleLocalCase({teamId:execution.teamId,id:execution.id,receiptId:row.receiptId,ownerId:deps.ownerId,
            status:controller.signal.aborted?"cancelled":"failed",result:row.result?sealLocalRetainedCase(localRetainedCase(row.result).attempt,null):null,error});
          break;
        }
      }
      await deps.store.finishLocalExecution(execution.teamId,execution.id,deps.ownerId,error);
    } catch(cause) {
      error=(cause instanceof Error?cause.message:"Local scoring failed.").slice(0,2000);
      await deps.store.finishLocalExecution(execution.teamId,execution.id,deps.ownerId,error).catch(()=>{});
    }
  }
  async function passes(raw:unknown) {
    const input=z.object({teamId:z.string().min(1),executionId:z.string().min(1),afterId:z.string().optional(),limit:z.number().int().min(1).max(100).default(30)}).strict().parse(raw);
    await deps.requireTeam(input.teamId);await deps.requireActor((await deps.store.readLocalExecution(input.teamId,input.executionId)).execution.ownerActorId);
    await deps.requireExecution(input.teamId,input.executionId);
    return deps.store.listLocalScoringPasses(input.teamId,input.executionId,input.afterId,input.limit);
  }
  async function pass(raw:unknown) {
    const input=z.object({teamId:z.string().min(1),id:z.string().min(1)}).strict().parse(raw);await deps.requireTeam(input.teamId);
    const execution=(await deps.store.readLocalExecution(input.teamId,input.id)).execution,selection=await deps.store.readLocalScoringSelection(input.teamId,input.id);
    await deps.requireExecution(input.teamId,input.id);
    await deps.requireActor(execution.ownerActorId);
    return {execution,graders:selection.graders,graderPackageHash:typeof selection.package==="object"&&selection.package!==null&&"schemaVersion" in selection.package&&selection.package.schemaVersion==="openpond.localSelectedRewardClosure.v1"?verifySelectedRewardClosure(selection.package).closure.contentHash:validateTasksetPackage(selection.package).contentHash};
  }
  return {score,scoreSelected:(raw:unknown,teamId:string)=>score(raw,teamId,true),passes,pass};
}
