import {contentHash,sha256,type ImmutableAssetRef} from '@openpond/harness';
import type {TasksetRunManifest} from '@openpond/evals';
import type {CustomVerifierRunner,ModelJudgeRunner} from '@openpond/evals/graders';
import {createBoundModelJudgeRunner,type BoundJudgeRequest,type BoundJudgeResponse} from '@openpond/evals/learning';
import {executeJavaScriptVerifierInWorker} from '@openpond/evals/javascript-verifier/node';
import type {TasksetMetricExecutor} from '@openpond/evals/metrics';
import {executeTasksetMetricWorker} from '@openpond/evals/metrics/node';
import {decodeTasksetPackageFile,validateTasksetPackage,type TasksetPackage} from 'openpond-sdk/taskset-packages';
import {assertWorkbookInspectionAdmission} from '../evaluations/workbook-inspection-admission.js';
export type ProfilePrivateGradingOwner={authorize():Promise<void>;customVerifier:CustomVerifierRunner;modelJudge?:ModelJudgeRunner;metricSource?:string;metricExecutor?:TasksetMetricExecutor};
export type ProfilePrivateGradingFactory=(manifest:TasksetRunManifest,packageValue:TasksetPackage,signal?:AbortSignal)=>Promise<ProfilePrivateGradingOwner>;
/** Package admission checks implementation bytes before target/provider I/O.
 * A model judge additionally requires an actual durable reservation owner. */
export async function preflightProfilePrivateGrading(raw:TasksetPackage,modelJudgeAvailable:boolean){
 const value=validateTasksetPackage(raw);
 assertWorkbookInspectionAdmission(value);
 for(const grader of value.taskset.graders){
  if(grader.kind==='model_judge'&&(!modelJudgeAvailable||grader.calibrationStatus!=='passed'))throw new Error('This Profile requires its current calibrated judge and bounded private provider owner.');
  if(grader.kind==='custom_verifier'&&grader.runtime!=='isolated_javascript')throw new Error('This Profile verifier requires a separately admitted process owner.');
  const ref='verifierRef' in grader?grader.verifierRef:'rubricRef' in grader?grader.rubricRef:null;if(ref)readPrivate(value,ref);
 }
 const metric=value.taskset.metrics?.customAggregator;if(metric){const file=value.files.find(file=>file.asset.path===metric.module);if(!file||file.asset.visibility==='policy'||sha256(decodeTasksetPackageFile(file))!==metric.contentHash)throw new Error('The authored aggregate metric is not its exact private release.');new TextDecoder('utf8',{fatal:true}).decode(decodeTasksetPackageFile(file));}
}
function readPrivate(value:TasksetPackage,reference:ImmutableAssetRef){const file=value.files.find(file=>file.asset.id===reference.id);if(!file||file.asset.visibility==='policy'||contentHash(file.asset)!==contentHash(reference))throw new Error('The exact private grader asset is unavailable.');return new TextDecoder('utf8',{fatal:true}).decode(decodeTasksetPackageFile(file));}
export async function createProfilePrivateGradingOwner(input:{manifest:TasksetRunManifest;packageValue:TasksetPackage;authorize():Promise<void>;executeBudgetedJudge?:(request:BoundJudgeRequest,signal?:AbortSignal)=>Promise<BoundJudgeResponse>;signal?:AbortSignal}):Promise<ProfilePrivateGradingOwner>{
 const value=validateTasksetPackage(input.packageValue);if(value.contentHash!==input.manifest.packageHash||value.taskset.contentHash!==input.manifest.tasksetRelease.contentHash)throw new Error('The private grading package changed its frozen Run identity.');await input.authorize();await preflightProfilePrivateGrading(value,Boolean(input.executeBudgetedJudge));await input.authorize();
 const customVerifier:CustomVerifierRunner=async({grader,task,evidence})=>{const signal=input.signal;await input.authorize();signal?.throwIfAborted();const result=await executeJavaScriptVerifierInWorker({source:readPrivate(value,grader.verifierRef),exportName:grader.exportName,runtime:grader.runtime,timeoutMs:grader.timeoutMs,signal,value:{task,attempt:evidence,input:task.input,output:evidence.output,artifacts:'artifacts' in evidence ? evidence.artifacts : [],expectedOutput:task.expectedOutput,infrastructureError:evidence.infrastructureError??null}});await input.authorize();signal?.throwIfAborted();return{score:result.score,passed:result.passed,rewardEligible:grader.rewardEligible,failureClass:null,feedback:[result.feedback],visibleEvidenceRefs:[],privilegedEvidenceRefs:[...result.evidenceRefs,...('artifacts' in evidence && Array.isArray(evidence.artifacts) ? evidence.artifacts.flatMap(artifact=>artifact.inspectionRef?.id?[artifact.inspectionRef.id]:[]) : [])]};};
 const metric=value.taskset.metrics?.customAggregator,metricSource=metric?new TextDecoder('utf8',{fatal:true}).decode(decodeTasksetPackageFile(value.files.find(file=>file.asset.path===metric.module)!)):undefined;
 return{authorize:input.authorize,customVerifier,...(input.executeBudgetedJudge?{modelJudge:createBoundModelJudgeRunner({readRubric:async reference=>{await input.authorize();const text=readPrivate(value,reference);await input.authorize();return text;},executeBudgeted:async(request,signal)=>{await input.authorize();signal?.throwIfAborted();const result=await input.executeBudgetedJudge!(request,signal);await input.authorize();signal?.throwIfAborted();return result;}})}:{}),...(metricSource!==undefined?{metricSource,metricExecutor:async request=>{await input.authorize();request.signal?.throwIfAborted();const result=await executeTasksetMetricWorker(request);await input.authorize();request.signal?.throwIfAborted();return result;}}:{})};
}
