import { localPackageGraders } from "./local-experiment-admission.js";
import type { TasksetRunManifest } from "@openpond/evals";
import { z } from "zod";
import { contentHash } from "@openpond/harness";
import type { ChatResourceSummary, OpenPondProfileRef } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import type { LocalProfileEvaluationRun } from "../store/profile-evaluation-record.js";
import { inspectProfileEvaluationRun } from "../harness/profile-evaluation-run-inspection.js";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";
import { localDatasetSummary } from "../training/local-dataset-service.js";
import { localGraderSummaries } from "../training/local-grader-resources.js";

/** A Profile run retains its own source and private grader owner. Chat
 * association neither substitutes a text evaluator nor changes that source. */
export function createChatProfileExperiments(deps:{
  store:SqliteStore;
  loadPackage(run:Pick<LocalProfileEvaluationRun,"manifest"|"profileRef">):Promise<TasksetPackage>;
  selectedProfile():Promise<{ref:OpenPondProfileRef;sourceRevision:string}>;
  selectedProfileRef():Promise<OpenPondProfileRef|null>;
  execute(request:unknown):Promise<LocalProfileEvaluationRun>;
  discover(params?:unknown):Promise<unknown>;
  prepare(request:unknown):Promise<{manifest:TasksetRunManifest}>;
  resolveInvocation(token:string):Promise<{sessionId:string;turnId:string}>;
  attach(context:{sessionId:string;turnId:string},resources:ChatResourceSummary[]):Promise<void>;
}) {
  async function authorize(ref:OpenPondProfileRef) {
    const selected=await deps.selectedProfileRef();
    if(!selected || contentHash(selected)!==contentHash(ref))throw new Error("Select the Profile that owns this saved experiment.");
    return selected;
  }
  async function inputs(run:Pick<LocalProfileEvaluationRun,"manifest"|"profileRef">) {
    const value=await deps.loadPackage(run);
    const source=value.taskset.metadata;
    const local=typeof source.sourceTasksetId==="string" && typeof source.sourcePackageHash==="string"
      ? await deps.store.readLocalDatasetByWorkspaceHash(source.sourceTasksetId,source.sourcePackageHash) : null;
    if(local && local.ownerId===await deps.store.localResourceOwnerId())return [localDatasetSummary(local),...localGraderSummaries(local).map(grader=>({...grader,rows:[]}))];
    const pin=value.taskset;
    const dataset:ChatResourceSummary={kind:"dataset",id:pin.id,revision:pin.revision,name:pin.id,state:"Pinned",profileRef:run.profileRef,
      contentHash:pin.contentHash,taskCount:run.manifest.population.length,graderCount:pin.graders.length,rows:[]};
    return [dataset,...pin.graders.map(grader=>({kind:"grader" as const,id:`grader-${contentHash([pin.id,grader.id]).slice(0,40)}`,
      revision:pin.revision,name:localPackageGraders(value).find(pin=>pin.id===grader.id)?.name ?? grader.id,state:"Pinned",profileRef:run.profileRef,contentHash:contentHash(grader),
      graderId:grader.id,graderType:grader.kind,datasetId:pin.id,datasetRevision:pin.revision,description:`Version ${grader.version}`,rows:[]}))];
  }
  async function inspect(id:string,expectedProfile?:OpenPondProfileRef) {
    const run=await deps.store.getProfileEvaluationRun(id);
    if(!run || expectedProfile && contentHash(run.profileRef)!==contentHash(expectedProfile))throw new Error("Saved Profile experiment was not found for this owner.");
    await authorize(run.profileRef);
    const evidence=await inspectProfileEvaluationRun({store:deps.store,profileRef:run.profileRef,runId:run.manifest.id});
    const resources=await inputs(run),dataset=resources.find(resource=>resource.kind==="dataset")!;
    const scored=evidence.cases.filter(row=>row.gradingStatus==="scored" && row.score!==null);
    const failed=evidence.cases.filter(row=>row.passed===false);
    const summary:ChatResourceSummary={kind:"experiment",id:run.manifest.id,revision:1,name:run.manifest.profileEvaluation!.definitionId,
      state:"completed",location:"local",profileRef:run.profileRef,contentHash:run.contentHash,
      model:run.manifest.policy.kind==="model" ? `${run.manifest.policy.model.provider}/${run.manifest.policy.model.model}` : undefined,
      datasetId:dataset.id,datasetRevision:dataset.revision,taskCount:run.manifest.population.length,graderCount:resources.length-1,
      scoreLabel:run.metric.policy.aggregation==="pass_rate" ? "Pass rate" : "Task metric",score:run.metric.value,
      evaluatedCount:scored.length,failedCount:failed.length,ungradedCount:evidence.cases.length-scored.length,
      costUsd:run.manifest.policy.kind==="model" && run.manifest.policy.model.provider==="codex" ? null : evidence.cases.every(row=>row.costUsd!==null) ? evidence.cases.reduce((sum,row)=>sum+row.costUsd!,0) : null,
      rows:evidence.cases.slice(0,3).map(row=>({id:row.receiptId,label:row.taskId,detail:row.failureClass ?? row.gradingStatus,score:row.score}))};
    // Receipt/case inspection remains the real Profile evidence path. A compact
    // chart does not invent a text answer for an artifact-producing workflow.
    const view={contentHash:run.contentHash,scope:run.manifest.contentHash,graders:null,cases:evidence.cases.map(row=>({id:row.receiptId,
      taskId:row.taskId,seed:row.seed,status:row.gradingStatus,output:null,error:row.failureClass,score:row.score}))};
    await authorize(run.profileRef);
    return {summary,inputs:resources,evidence,view};
  }
  async function request(raw:unknown) {
    const {invocationToken,...command}=z.object({invocationToken:z.string().optional()}).passthrough().parse(raw);
    const context=invocationToken ? await deps.resolveInvocation(invocationToken) : null;
    const run=await deps.execute(command);
    if(context) {
      await authorize(run.profileRef);
      const selected=await deps.selectedProfile();
      if(contentHash(selected.ref)!==contentHash(run.profileRef) || selected.sourceRevision!==run.manifest.profileEvaluation!.sourceRevision)throw new Error("Profile source changed before chat attachment.");
      const result=await inspect(run.manifest.id,run.profileRef);
      await deps.attach(context,[...result.inputs,result.summary]);
    }
    return run;
  }
  async function discover(raw?:unknown) {
    if(raw===undefined)return deps.discover();
    const {invocationToken,...command}=z.object({invocationToken:z.string().optional()}).passthrough().parse(raw);
    const context=invocationToken ? await deps.resolveInvocation(invocationToken) : null;
    const result=await deps.discover(command);
    if(context && typeof command.runId==="string" && await deps.store.getProfileEvaluationRun(command.runId)) {
      const saved=await inspect(command.runId);
      await deps.attach(context,[...saved.inputs,saved.summary]);
    }
    return result;
  }
  async function prepare(raw:unknown) {
    const {invocationToken,...command}=z.object({invocationToken:z.string().optional()}).passthrough().parse(raw);
    const context=invocationToken ? await deps.resolveInvocation(invocationToken) : null;
    const result=await deps.prepare(command);
    if(context) {
      const selected=await deps.selectedProfile(),source=result.manifest.profileEvaluation;
      await authorize(selected.ref);
      if(!source || source.profileId!==selected.ref.profileId || source.sourceRevision!==selected.sourceRevision
        || command.profileRef && contentHash(command.profileRef)!==contentHash(selected.ref))throw new Error("Prepared inputs belong to another Profile source.");
      await deps.attach(context,await inputs({profileRef:selected.ref,manifest:result.manifest}));
    }
    return result;
  }
  return {request,inspect,authorize,discover,prepare};
}
