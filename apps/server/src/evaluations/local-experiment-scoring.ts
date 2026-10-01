import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { validateTasksetPackage } from "openpond-sdk/taskset-packages";
import type { streamOpenPondHostedChatTurn, loadOpenPondHostedModels } from "@openpond/runtime";
import type { SqliteLocalExperimentStore } from "../store/store-local-experiments.js";
import { LocalExperimentScoreSchema, LocalExperimentExecutionSchema, LocalExperimentError, type LocalExperimentExecution } from "./local-experiment-contract.js";
import { selectLocalPackageGraders } from "./local-experiment-admission.js";
import { gradeLocalExperimentCase } from "./local-experiment-grading.js";
import { localRetainedCase, sealLocalRetainedCase, localEvaluatorContext } from "./local-experiment-output.js";
import { createLearningHostedJudgeProvider } from "../training/learning-hosted-judge-provider.js";

export function createLocalExperimentScoring(deps:{store:SqliteLocalExperimentStore;ownerId:string;requireTeam:(teamId:string)=>Promise<void>;
  requireActor:(actorId:string)=>Promise<void>;
  requireExecution:(teamId:string,id:string)=>Promise<void>;
  streamForActor:(actorId:string,teamId:string)=>typeof streamOpenPondHostedChatTurn;
  active:Map<string,Promise<void>>;controllers:Map<string,AbortController>;stream?:typeof streamOpenPondHostedChatTurn;catalog?:typeof loadOpenPondHostedModels}) {
  async function score(raw:unknown,teamId:string) {
    await deps.requireTeam(teamId);
    const input=LocalExperimentScoreSchema.parse(raw);
    await deps.requireExecution(teamId,input.execution.id);
    const source=await deps.store.readLocalExecution(teamId,input.execution.id);await deps.requireActor(source.execution.ownerActorId);
    const intentHash=contentHash({ownerActorId:source.execution.ownerActorId,input});
    const prior=await deps.store.recoverLocalExperimentOperation(teamId,input.operationId,"score",intentHash);
    if(prior)return (await deps.store.readLocalExecution(teamId,LocalExperimentExecutionSchema.parse(prior).id)).execution;
    if(source.execution.executionHash!==input.execution.executionHash || source.execution.kind!=="target")throw new LocalExperimentError("local_scoring_source_conflict","Select the exact original local execution.");
    const value=validateTasksetPackage(input.graderPackage),graders=selectLocalPackageGraders(value,input.graders);
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
      const value=validateTasksetPackage(selection.package),source=await deps.store.readLocalExecution(execution.teamId,selection.sourceExecutionId);
      const original=await deps.store.readLocalExperiment(execution.teamId,source.execution.definition.id,source.execution.definition.revision);
      const originalPackage=validateTasksetPackage(original.package);
      for(const row of source.cases) {
        if(!await deps.store.admitLocalCase(execution.teamId,execution.id,row.receiptId,deps.ownerId))break;
        try {
          controller.signal.throwIfAborted();
          if(!row.result)throw new LocalExperimentError("local_scoring_evidence_missing","This original case has no retained target output.",422);
          const retained=localRetainedCase(row.result),task=originalPackage.taskset.tasks.find(task=>task.id===row.admission.taskId)!;
          const grade=await gradeLocalExperimentCase({store:deps.store,ownerId:deps.ownerId,teamId:execution.teamId,executionId:execution.id,caseId:row.receiptId,
            package:value,task,evidence:{output:{text:retained.attempt.output??""},runtimeEventRefs:retained.attempt.native?.runtimeEventRefs??retained.attempt.profileNative?.runtimeEventRefs??[],artifactRefs:[],
              infrastructureError:row.status==="completed"?null:row.error??row.status},
            evaluatorContext:localEvaluatorContext(retained.attempt),
            graders:selection.graders,signal:controller.signal,judgeProvider:createLearningHostedJudgeProvider({stream:deps.streamForActor(execution.ownerActorId,execution.teamId),catalog:deps.catalog})});
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
    return {execution,graders:selection.graders,graderPackageHash:validateTasksetPackage(selection.package).contentHash};
  }
  return {score,passes,pass};
}
