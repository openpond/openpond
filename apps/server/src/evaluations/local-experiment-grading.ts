import {verifySelectedRewardClosure,type SelectedRewardClosure} from "./local-reward-grading.js";
import { ScheduledTransportNotInvokedError } from "./evaluation-schedule-admission-guard.js";
import { contentHash, type ImmutableAssetRef } from "@openpond/harness";
import { gradeTaskEvidence, aggregateGraderScores, type AttemptEvidence } from "@openpond/evals/graders";
import { createBoundModelJudgeRunner, createBudgetedJudgeExecutor, type BoundJudgeProvider } from "@openpond/evals/learning";
import { executeJavaScriptVerifierInWorker } from "@openpond/evals/javascript-verifier/node";
import { mapExperimentGradingFields, ExperimentAttemptGradeSchema } from "openpond-sdk/experiments";
import { decodeTasksetPackageFile, type TasksetPackage } from "openpond-sdk/taskset-packages";
import type { TaskRecord } from "@openpond/evals/tasksets";
import type { SqliteLocalExperimentStore } from "../store/store-local-experiments.js";
import { LocalExperimentError, type LocalExperimentDefinition } from "./local-experiment-contract.js";
import { createLearningHostedJudgeProvider } from "../training/learning-hosted-judge-provider.js";

/** Evals owns grading semantics; the local owner supplies private bytes and its
 * existing durable judge budget. No policy/target executor is reachable here. */
export async function gradeLocalExperimentCase(input:{store:SqliteLocalExperimentStore;ownerId:string;teamId:string;executionId:string;caseId:string;
  package?:TasksetPackage;selectedRewards?:SelectedRewardClosure;beforeDispatch?:()=>Promise<void>;task:TaskRecord;evidence:AttemptEvidence;evaluatorContext:Record<string,unknown>|null;
  graders:LocalExperimentDefinition["graders"];signal:AbortSignal;judgeProvider?:BoundJudgeProvider}) {
  const provider=input.judgeProvider??createLearningHostedJudgeProvider();
  const readPrivate=async(reference:ImmutableAssetRef)=> {
    if(input.selectedRewards){const asset=input.selectedRewards.assets.find(asset=>asset.id===reference.id);if(!asset)throw new Error("The exact selected Reward asset is unavailable.");return import("@openpond/evals/learning").then(module=>module.verifyLearningTextAsset(asset,reference));}
    const file=input.package?.files.find(file=>file.asset.id===reference.id);
    if(!file||contentHash(file.asset)!==contentHash(reference)||file.asset.visibility==="policy")
      throw new LocalExperimentError("local_private_grader_asset_missing","The exact private grader asset is unavailable.",422);
    return new TextDecoder("utf-8",{fatal:true}).decode(decodeTasksetPackageFile(file));
  };
  const available=input.selectedRewards?verifySelectedRewardClosure(input.selectedRewards).specs:input.package!.taskset.graders;
  const specs=input.graders.map(pin=> {
    const spec=available.find(spec=>spec.id===pin.id&&spec.version===pin.version&&contentHash(spec)===pin.contentHash);
    if(!spec)throw new LocalExperimentError("local_grader_pin_unavailable","The scoring pass requires the exact retained grader release.",422);
    return spec;
  });
  const artifacts=input.evidence.output && typeof input.evidence.output==="object" && Array.isArray(input.evidence.output.artifacts) ? input.evidence.output.artifacts : [];
  const grades=[];
  for(const [index,spec] of specs.entries()) {
    input.signal.throwIfAborted();
    const pin=input.graders[index]!,fields=mapExperimentGradingFields({input:input.task.input,expectedOutput:input.task.expectedOutput,
      output:input.evidence.output,evaluatorContext:input.evaluatorContext},pin.mappings??[]);
    const mappedTask={...input.task,input:fields.input,expectedOutput:fields.expectedOutput},evidence={...input.evidence,output:fields.output};
    await input.beforeDispatch?.();
    const grade=await gradeTaskEvidence({task:mappedTask,evidence,evaluatorContext:fields.evaluatorContext,graders:[spec],signal:input.signal,
      modelJudge:createBoundModelJudgeRunner({readRubric:readPrivate,async executeBudgeted(request,signal) {
        const prepared=await provider.prepare(request,{scope:input.teamId,run:{id:input.executionId,requestedBy:"local-capability-owner"}});
        const execute=createBudgetedJudgeExecutor({maximumCharge:()=>prepared.maximumChargeUsd,dispatch:async(_request,signal)=>{await input.beforeDispatch?.();signal?.throwIfAborted();return prepared.dispatch(signal);},
          store:{transaction:(intent,update)=>input.store.localJudgeBudgetTransaction({teamId:input.teamId,id:input.executionId,ownerId:input.ownerId,caseId:input.caseId,intent},update)}});
        const callId=`local-judge-${contentHash([input.executionId,input.caseId,pin,request]).slice(0,48)}`;
        try { return await execute(callId,request,signal); }
        catch(error) {
          if(error instanceof ScheduledTransportNotInvokedError&&error.executionId===input.executionId) {
            await input.store.localJudgeBudgetTransaction({teamId:input.teamId,id:input.executionId,ownerId:input.ownerId,caseId:input.caseId,intent:"settle"},state=> {
              const retained=state.calls.find(call=>call.id===callId);
              if(!retained||retained.requestHash!==contentHash(request)||retained.status!=="reserved"||retained.response!==null)
                throw new LocalExperimentError("local_judge_no_dispatch_conflict","The unused judge reservation changed before settlement.");
              return {calls:state.calls.map(call=>call.id===callId?{...call,status:"not_dispatched" as const}:call),result:null};
            });
          }
          throw error;
        }
      }}),
      customVerifier:async({grader,task,evidence})=> {
        await input.beforeDispatch?.();
        const result=await executeJavaScriptVerifierInWorker({source:await readPrivate(grader.verifierRef),exportName:grader.exportName,
          runtime:grader.runtime,timeoutMs:grader.timeoutMs,signal:input.signal,
          value:{task,attempt:evidence,input:task.input,output:evidence.output,artifacts,expectedOutput:task.expectedOutput,evaluatorContext:fields.evaluatorContext,
            infrastructureError:evidence.infrastructureError??null}});
        await input.beforeDispatch?.();
        return {score:result.score,passed:result.passed,rewardEligible:grader.rewardEligible,failureClass:null,
          feedback:[result.feedback],visibleEvidenceRefs:[],privilegedEvidenceRefs:[...result.evidenceRefs,...artifacts.flatMap(artifact=>artifact.inspectionRef?.id?[artifact.inspectionRef.id]:[])]};
      },
    });
    await input.beforeDispatch?.();
    grades.push(grade);
  }
  const summary=aggregateGraderScores({graders:specs,components:grades.flatMap(grade=>grade.components)});
  const content={schemaVersion:"openpond.experimentAttemptGrade.v1" as const,selectionHash:contentHash(input.graders),grades,...summary};
  return ExperimentAttemptGradeSchema.parse({...content,contentHash:contentHash(content)});
}
