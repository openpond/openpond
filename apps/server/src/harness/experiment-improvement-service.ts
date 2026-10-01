import {verifyHumanComparisonProjection,type HumanComparisonSelections,type HumanComparisonProjection} from "@openpond/evals/human-review";
import { promises as fs } from "node:fs";
import path from "node:path";
import { contentHash, ProfileWorkflowActionsSchema, type ImmutableReleaseRef } from "@openpond/harness";
import { HarnessWorkspaceSchema, type HarnessWorkspace, type OpenPondProfileRef } from "@openpond/contracts";
import { verifyExperimentEvidence, compareExperiments, type ExperimentManifest, type ExperimentResult } from "@openpond/evals/experiments";
import type { HarnessStateStore } from "../store/harness-state-store.js";
import type { LocalHarnessReleaseRecord } from "../store/store-harness-release-record.js";
import { createExperimentImprovementStore } from "./experiment-improvement-store.js";
import { sealExperimentImprovementState, type ExperimentImprovementState } from "./experiment-improvement-state.js";
import { materializeExperimentCandidateSource, writeManualCandidateInstructions, freezeExperimentCandidateSource, readExperimentCandidatePartition } from "./experiment-candidate-source.js";
import { compileLocalHarnessSource, localHarnessWorkspacePaths } from "./local-harness-workspace-service.js";

export {StartExperimentImprovementSchema} from "openpond-sdk/experiment-improvements";
import {ExperimentImprovementTestRecipeSchema,StartExperimentImprovementSchema} from "openpond-sdk/experiment-improvements";
export type ImprovementActor={actorId:string;teamId:string};
export type ImprovementAdoptionReadback={receipt:ImmutableReleaseRef;activeRelease:ImmutableReleaseRef;testedCandidateRelease:ImmutableReleaseRef;executableSourceHash:string;protectedClosureHash:string};
export interface LocalExperimentImprovementService {
 read(actor:ImprovementActor,id:string):Promise<ExperimentImprovementState>;
 list(actor:ImprovementActor,limit?:number,cursor?:string):Promise<{states:ExperimentImprovementState[];nextCursor:string|null}>;
 start(actor:ImprovementActor,raw:unknown):Promise<ExperimentImprovementState>;
 edit(actor:ImprovementActor,id:string,revision:number,expectedFileHash:string,text:string):Promise<ExperimentImprovementState>;
 setMode(actor:ImprovementActor,id:string,revision:number,mode:ExperimentImprovementState["mode"]):Promise<ExperimentImprovementState>;
 queueAuthoringTurn(actor:ImprovementActor,id:string,revision:number,sessionId:string,turnId:string,createdAt:string):Promise<ExperimentImprovementState>;
 bindAuthoringTurn(actor:ImprovementActor,id:string,revision:number,sessionId:string,turnId:string):Promise<ExperimentImprovementState>;
 beginTestDispatch(actor:ImprovementActor,id:string,revision:number,dispatch:NonNullable<NonNullable<ExperimentImprovementState["test"]>["dispatching"]>):Promise<ExperimentImprovementState>;
 endTestDispatch(actor:ImprovementActor,id:string,revision:number,token:string):Promise<ExperimentImprovementState>;
 beginTesting(actor:ImprovementActor,id:string,revision:number,rawRecipe:unknown):Promise<ExperimentImprovementState>;
 failTesting(actor:ImprovementActor,id:string,revision:number,error:string,cancelled?:boolean):Promise<ExperimentImprovementState>;
 completeComparison(actor:ImprovementActor,id:string,revision:number,baseline:{manifest:ExperimentManifest;result:ExperimentResult},candidate:{manifest:ExperimentManifest;result:ExperimentResult},humanSelections?:HumanComparisonSelections):Promise<ExperimentImprovementState>;
 discard(actor:ImprovementActor,id:string,revision:number,cancelled?:boolean):Promise<ExperimentImprovementState>;
 partition(actor:ImprovementActor,id:string):ReturnType<typeof readExperimentCandidatePartition>;
 states:ReturnType<typeof createExperimentImprovementStore>;
 close():Promise<void>;
 cancelQueuedAuthoring(actor:ImprovementActor,id:string,revision:number):Promise<ExperimentImprovementState>;
 authoringStep(actor:ImprovementActor,id:string,revision:number):Promise<ExperimentImprovementState>;
 cancelTesting(actor:ImprovementActor,id:string,revision:number):Promise<ExperimentImprovementState>;
 finishAuthoring(actor:ImprovementActor,id:string,revision:number):Promise<ExperimentImprovementState>;
 freeze(actor:ImprovementActor,id:string,revision:number):Promise<ExperimentImprovementState>;
 beginAdoption(actor:ImprovementActor,id:string,revision:number):Promise<ExperimentImprovementState>;
 useCandidate(actor:ImprovementActor,id:string,revision:number):Promise<ExperimentImprovementState>;
 rollback(actor:ImprovementActor,id:string,revision:number):Promise<ExperimentImprovementState>;
}
export function createLocalExperimentImprovementService(deps:{store:HarnessStateStore;storeDir:string;
  authorizeOwner(actor:ImprovementActor,workspace:HarnessWorkspace,profile:OpenPondProfileRef,projectId:string|null,options:{requireCurrentBase:boolean}):Promise<void>;
  loadEvidence(actor:ImprovementActor,reference:ImmutableReleaseRef):Promise<{manifest:ExperimentManifest;result:ExperimentResult}>;
  projectHumanComparison?(actor:ImprovementActor,state:ExperimentImprovementState,selections:HumanComparisonSelections,baseline:{manifest:ExperimentManifest;result:ExperimentResult},candidate:{manifest:ExperimentManifest;result:ExperimentResult}):Promise<HumanComparisonProjection>;
  rollback(actor:ImprovementActor,state:ExperimentImprovementState,operationId:string):Promise<ImprovementAdoptionReadback>;
  readAdoption(actor:ImprovementActor,state:ExperimentImprovementState,operationId:string):Promise<ImprovementAdoptionReadback|null>;
  freezeProfile?(actor:ImprovementActor,state:ExperimentImprovementState,result:Awaited<ReturnType<typeof freezeExperimentCandidateSource>>):Promise<Awaited<ReturnType<typeof freezeExperimentCandidateSource>>>;
  adopt(actor:ImprovementActor,state:ExperimentImprovementState,release:LocalHarnessReleaseRecord,operationId:string):Promise<ImprovementAdoptionReadback>;
}):LocalExperimentImprovementService {
  const states=createExperimentImprovementStore(deps.storeDir),now=()=>new Date().toISOString();
  async function owner(actor:ImprovementActor,state:ExperimentImprovementState,authorize=false){const workspace=await deps.store.getHarnessWorkspace(state.ownerWorkspaceId);
    if(!workspace)throw new Error("Improvement owner is unavailable.");if(authorize)await deps.authorizeOwner(actor,workspace,state.profileRef,state.projectId,{requireCurrentBase:true});
    if(workspace.revision!==state.ownerRevision||workspace.sourceRevision!==state.ownerSourceRevision||contentHash(workspace.currentChannel.release)!==contentHash(state.baseRelease))throw new Error("The live owner changed; reconcile and qualify against its new base before adoption.");return workspace;}
  async function base(state:ExperimentImprovementState){const release=await deps.store.getHarnessReleaseRecord(state.baseRelease.contentHash);if(!release||release.harnessRelease.id!==state.baseRelease.id||release.workspaceId!==state.ownerWorkspaceId)throw new Error("Improvement baseline release is unavailable.");return release;}
  async function humanProjection(actor:ImprovementActor,state:ExperimentImprovementState,selections:HumanComparisonSelections,baseline:{manifest:ExperimentManifest;result:ExperimentResult},candidate:{manifest:ExperimentManifest;result:ExperimentResult}){
    if(!deps.projectHumanComparison||!state.projectId)throw new Error("The current accepted Human comparison owner is unavailable.");
    const projection=verifyHumanComparisonProjection(await deps.projectHumanComparison(actor,state,selections,baseline,candidate),{baseline,candidate});
    if(projection.teamId!==actor.teamId||projection.projectId!==state.projectId||contentHash(projection.selections)!==contentHash(selections)||projection.original.baseline.id!==baseline.manifest.id||projection.original.baseline.manifestHash!==baseline.manifest.contentHash||projection.original.baseline.resultHash!==baseline.result.contentHash||projection.original.candidate.id!==candidate.manifest.id||projection.original.candidate.manifestHash!==candidate.manifest.contentHash||projection.original.candidate.resultHash!==candidate.result.contentHash)throw new Error("The accepted Human projection changed its original receipts.");
    return projection;
  }
  async function reauthorizeHuman(actor:ImprovementActor,state:ExperimentImprovementState){const previous=state.comparison?.humanProjection;if(!previous)return;
    const baseline=verifyExperimentEvidence(await deps.loadEvidence(actor,{id:previous.original.baseline.id,contentHash:previous.original.baseline.resultHash})),candidate=verifyExperimentEvidence(await deps.loadEvidence(actor,{id:previous.original.candidate.id,contentHash:previous.original.candidate.resultHash}));
    const current=await humanProjection(actor,state,previous.selections,baseline,candidate);if(current.contentHash!==previous.contentHash)throw new Error("The accepted Human comparison changed; requalify before adoption.");
  }
  async function read(actor:ImprovementActor,id:string){const state=await states.read(id,actor.actorId,actor.teamId);const workspace=await deps.store.getHarnessWorkspace(state.ownerWorkspaceId);if(!workspace)throw new Error("Improvement owner is unavailable.");await deps.authorizeOwner(actor,workspace,state.profileRef,state.projectId,{requireCurrentBase:false});await deps.loadEvidence(actor,{id:state.evidence.manifest.id,contentHash:state.evidence.result.contentHash});await reauthorizeHuman(actor,state);return state;}
  async function mutateOwned(actor:ImprovementActor,id:string,revision:number,fn:(state:ExperimentImprovementState)=>Promise<ExperimentImprovementState>){
    const admitted=await read(actor,id);await owner(actor,admitted,true);return states.mutate(id,actor.actorId,actor.teamId,revision,fn);
  }
  const transition=(state:ExperimentImprovementState,patch:Partial<ExperimentImprovementState>)=>{const {contentHash:_hash,...body}=state;return sealExperimentImprovementState({...body,...patch,revision:state.revision+1,updatedAt:now()});};
  const service={
    read,
    list:async(actor:ImprovementActor,limit=30,cursor?:string)=>{const values=await states.list(actor.actorId,actor.teamId,limit,cursor);const available=[];for(const value of values){try{available.push(await read(actor,value.id));}catch{/* Revoked owners are absent from discovery. */}}return {states:available,nextCursor:values.length===limit?values.at(-1)!.id:null};},
    async start(actor:ImprovementActor,raw:unknown){const request=StartExperimentImprovementSchema.parse(raw),requestHash=contentHash(request),id=`improve-${contentHash([actor.actorId,actor.teamId,request.operationId]).slice(0,40)}`,retained=await states.find(id,actor.actorId,actor.teamId);if(retained){if(retained.requestHash!==requestHash)throw new Error("The original creation operation was reused with another request.");return read(actor,retained.id);}if(request.mode==="manual"&&request.component.kind==="agent")throw new Error("Manual Improve edits instruction-bearing components; use ordinary Work authoring for Agent code.");const workspace=await deps.store.getHarnessWorkspace(request.ownerWorkspaceId);if(!workspace||workspace.location!=="local")throw new Error("Select an admitted local Profile owner.");
      await deps.authorizeOwner(actor,workspace,request.profileRef,request.projectId,{requireCurrentBase:true});
      if(workspace.revision!==request.expectedOwnerRevision||contentHash(workspace.currentChannel.release)!==contentHash(request.baseRelease))throw new Error("Improvement base owner changed.");
      const evidence=verifyExperimentEvidence(await deps.loadEvidence(actor,request.evidence));if(evidence.result.contentHash!==request.evidence.contentHash||evidence.manifest.id!==request.evidence.id)throw new Error("Improvement evidence identity changed.");
      const admittedBase=await deps.store.getHarnessReleaseRecord(request.baseRelease.contentHash),profileSource=admittedBase?.harnessRelease.metadata.profile as {sourceRevision?:string}|undefined;
      if(profileSource?.sourceRevision!==request.profileSourceRevision)throw new Error("Improvement source revision differs from its exact owner Profile release.");
      const createdAt=now();
      const state=await states.create(sealExperimentImprovementState({schemaVersion:"openpond.experimentImprovement.v1",id,operationId:request.operationId,requestHash,...actor,projectId:request.projectId,
        ownerWorkspaceId:workspace.id,ownerRevision:workspace.revision,ownerSourceRevision:workspace.sourceRevision,baseRelease:request.baseRelease,profileRef:request.profileRef,baseProfileSourceRevision:request.profileSourceRevision,
        evidence,component:request.component,mode:request.mode,status:"draft",revision:1,limits:request.limits,authoringSteps:0,work:null,frozen:null,test:null,comparison:null,adoptionIntent:null,acceptance:null,rollback:null,error:null,createdAt,updatedAt:createdAt}));
      await materializeExperimentCandidateSource({storeDir:deps.storeDir,candidateId:id,base:await base(state),component:state.component});await owner(actor,state);return state;},
    async edit(actor:ImprovementActor,id:string,revision:number,expectedFileHash:string,text:string){return mutateOwned(actor,id,revision,async state=>{await owner(actor,state);if(["authoring_queued","authoring","testing","adopting","accepted","rolled_back","declined","cancelled"].includes(state.status))throw new Error("Stop active authoring/evaluation before editing this candidate.");
      await writeManualCandidateInstructions({storeDir:deps.storeDir,candidateId:id,expectedHash:expectedFileHash,text});return transition(state,{status:"draft",frozen:null,test:null,comparison:null,error:null});});},
    async setMode(actor:ImprovementActor,id:string,revision:number,mode:ExperimentImprovementState["mode"]){return mutateOwned(actor,id,revision,async state=>{if(state.status!=="draft")throw new Error("Change mode only in a settled authoring draft.");if(mode==="manual"&&state.component.kind==="agent")throw new Error("Use ordinary Work for Agent source authoring.");return state.mode===mode?state:transition(state,{mode});});},
    /** Private host-only queue admission. The actual PG turn exists before this
     * checkpoint; it grants no tool/model authority until bindAuthoringTurn. */
    async queueAuthoringTurn(actor:ImprovementActor,id:string,revision:number,sessionId:string,turnId:string,createdAt:string){return mutateOwned(actor,id,revision,async state=>{if(state.mode!=="llm_assisted"||state.status!=="draft")throw new Error("Queue only a settled LLM authoring draft.");return transition(state,{status:"authoring_queued",work:{sessionId,turnId,revision:state.revision+2,startedAt:createdAt},frozen:null,test:null,comparison:null,error:null});});},
    async cancelQueuedAuthoring(actor:ImprovementActor,id:string,revision:number){return mutateOwned(actor,id,revision,async state=>{if(state.status!=="authoring_queued")throw new Error("Cancel only a queued candidate turn after actual host cancellation.");return transition(state,{status:"cancelled",error:"The owner cancelled queued candidate Work before provider dispatch."});});},
    async bindAuthoringTurn(actor:ImprovementActor,id:string,revision:number,sessionId:string,turnId:string){return mutateOwned(actor,id,revision,async state=>{await owner(actor,state);if(state.mode!=="llm_assisted"||state.status!=="draft"&&state.status!=="authoring_queued"||state.status==="authoring_queued"&&(state.work?.sessionId!==sessionId||state.work.turnId!==turnId))throw new Error("An explicit LLM authoring action is required.");
      const session=await deps.store.getSession(sessionId),turn=await deps.store.getTurn(turnId);if(!session||session.experience!=="work"||!turn||turn.sessionId!==sessionId||turn.status!=="in_progress")throw new Error("Candidate authoring requires its actual ordinary Work session and turn.");
      const marker={candidateId:id,authoringRevision:revision+1,actorId:actor.actorId,teamId:actor.teamId};
      if(contentHash(turn.metadata.refinementCandidate)!==contentHash(marker)||turn.metadata.source!=="experiment-improvement")throw new Error("The Work turn has no trusted candidate admission marker.");
      return transition(state,{status:"authoring",work:{sessionId,turnId,revision:revision+1,startedAt:now()},authoringSteps:0,frozen:null,test:null,comparison:null,error:null});});},
    async authoringStep(actor:ImprovementActor,id:string,revision:number){return mutateOwned(actor,id,revision,async state=>{await owner(actor,state);if(state.status!=="authoring"||!state.work)throw new Error("Candidate Work is not authoring.");
      if(state.authoringSteps>=state.limits.maximumAuthoringSteps||Date.now()-Date.parse(state.work.startedAt)>state.limits.maximumDurationMs)throw new Error("Candidate authoring reached its admitted step or time limit.");
      return transition(state,{authoringSteps:state.authoringSteps+1});});},
    async beginTestDispatch(actor:ImprovementActor,id:string,revision:number,dispatch:NonNullable<NonNullable<ExperimentImprovementState["test"]>["dispatching"]>){return mutateOwned(actor,id,revision,async state=>{if(state.status!=="testing"||!state.test||state.test.cancelRequestedAt||state.test.dispatching)throw new Error("The test is cancelled or another exact dispatch owns admission.");return transition(state,{test:{...state.test,dispatching:dispatch}});});},
    async endTestDispatch(actor:ImprovementActor,id:string,revision:number,token:string){return mutateOwned(actor,id,revision,async state=>{if(state.status!=="testing"||!state.test||state.test.dispatching?.token!==token)throw new Error("The test dispatch ownership changed.");return transition(state,{test:{...state.test,dispatching:null}});});},
    async cancelTesting(actor:ImprovementActor,id:string,revision:number){return mutateOwned(actor,id,revision,async state=>{if(state.status!=="testing"||!state.test)throw new Error("Cancel only an admitted candidate test.");return state.test.cancelRequestedAt?state:transition(state,{test:{...state.test,cancelRequestedAt:now()}});});},
    async finishAuthoring(actor:ImprovementActor,id:string,revision:number){return mutateOwned(actor,id,revision,async state=>{await owner(actor,state);if(state.status!=="authoring"||!state.work)throw new Error("Candidate is not authoring.");const turn=await deps.store.getTurn(state.work.turnId);if(!turn||turn.status==="in_progress")throw new Error("Wait for the admitted Work turn to finish or cancel it.");return transition(state,{status:turn.status==="completed"?"draft":"failed",error:turn.status==="completed"?null:"Candidate Work did not complete successfully."});});},
    async freeze(actor:ImprovementActor,id:string,revision:number){return mutateOwned(actor,id,revision,async state=>{await owner(actor,state);if(state.status!=="draft")throw new Error("Freeze a settled draft before testing.");
      const workspaceId=`candidate-${contentHash([id,state.revision]).slice(0,40)}`;let result=await freezeExperimentCandidateSource({storeDir:deps.storeDir,candidateId:id,base:await base(state),workspaceId,createdAt:now()});
      if(deps.freezeProfile)result=await deps.freezeProfile(actor,state,result);
      const frozen={release:{id:result.release.harnessRelease.id,contentHash:result.release.harnessRelease.contentHash},sourceRevision:result.release.sourceRevision,profileSourceRevision:result.profileSourceRevision,
        authoringHash:result.authoringHash,partitionHash:result.partitionHash,executableSourceHash:result.executableIdentity.contentHash,protectedClosureHash:result.executableIdentity.protectedClosureHash,candidateRevision:state.revision+1,diff:result.diff};
      const origin={schemaVersion:"openpond.experimentCandidateOrigin.v1",candidateId:id,actorId:actor.actorId,teamId:actor.teamId,baseWorkspaceId:state.ownerWorkspaceId,baseProfileRef:state.profileRef,
        baseProfileSourceRevision:state.baseProfileSourceRevision,baseRelease:state.baseRelease,frozenRevision:frozen.candidateRevision,frozenHash:contentHash(frozen)};
      const existing=await deps.store.getHarnessWorkspace(workspaceId);
      if(existing){if(contentHash(existing.currentChannel.release)!==contentHash(frozen.release)||contentHash(existing.metadata.experimentCandidateOrigin)!==contentHash(origin))throw new Error("Candidate workspace identity conflict.");}
      else {const paths=localHarnessWorkspacePaths(deps.storeDir,workspaceId);await fs.mkdir(paths.root,{recursive:true,mode:0o700});const priorSource=await fs.stat(paths.source).catch(()=>null);
        if(priorSource){const recovered=await compileLocalHarnessSource({workspaceId:typeof result.release.agentSnapshot.metadata.workspaceId==="string"?result.release.agentSnapshot.metadata.workspaceId:workspaceId,sourceDir:paths.source});if(recovered.harnessRelease.contentHash!==frozen.release.contentHash)throw new Error("Interrupted candidate workspace source differs from its frozen release.");}
        else {const temporary=`${paths.source}.install-${contentHash(frozen).slice(0,20)}`;await fs.rm(temporary,{recursive:true,force:true});await fs.cp(path.join(result.release.bundlePath,"source"),temporary,{recursive:true,errorOnExist:true,force:false});await fs.rename(temporary,paths.source);}
        await deps.store.createHarnessWorkspaceWithRelease({workspace:HarnessWorkspaceSchema.parse({schemaVersion:"openpond.harnessWorkspace.v1",id:workspaceId,ownerScope:{kind:"personal",id:actor.actorId},name:`Candidate ${id}`,location:"local",sourceRevision:result.release.sourceRevision,revision:0,dirty:false,
          currentChannel:{name:"candidate",release:frozen.release,revision:1},createdAt:now(),updatedAt:now(),metadata:{sourceLayout:"openpond.harnessSourceManifest.v1",selectionEligible:false,experimentCandidateOrigin:origin}}),release:result.release});}
      await owner(actor,state,true);return transition(state,{status:"frozen",frozen,test:null,comparison:null,error:null});});},
    async beginTesting(actor:ImprovementActor,id:string,revision:number,rawRecipe:unknown){return mutateOwned(actor,id,revision,async state=>{await owner(actor,state);const recipe=ExperimentImprovementTestRecipeSchema.parse(rawRecipe),binding=recipe.externalDatasetBinding;
      if(state.status==="testing"&&state.test){if(contentHash(recipe)!==state.test.recipeHash)throw new Error("The admitted test recipe cannot change during execution.");return state;}
      if(state.status!=="frozen"||!state.frozen)throw new Error("Test a frozen candidate revision.");
      const original=state.evidence.manifest;if(binding.profileId!==state.profileRef.profileId||contentHash(binding.dataset)!==contentHash(original.dataset)||(!recipe.scoring&&contentHash(binding.evaluators)!==contentHash(original.evaluators)||recipe.scoring&&recipe.scoring.sourcePass.id!==original.lineage?.scoringPassId))throw new Error("The qualification changed the original Dataset or evaluator selection.");
      const population=binding.recordedOrigin?binding.recordedOrigin.members.map(row=>({caseId:row.caseId,seed:row.seed,fixtureId:row.fixtureId})):binding.population.map(row=>({caseId:row.taskId,seed:row.seed,fixtureId:row.fixtureId}));
      if(contentHash(population)!==contentHash(original.population)||binding.recordedOrigin&&(binding.recordedOrigin.originalEvidence.id!==original.id||binding.recordedOrigin.originalEvidence.contentHash!==state.evidence.result.contentHash))throw new Error("The qualification changed the exact original ordered population or recorded cutoff.");
      if(binding.protectedProfileClosureHash!==state.frozen.protectedClosureHash)throw new Error("The test recipe changed the protected Profile evaluator closure.");
      const target=binding.target;if(state.component.kind==="workflow"?(target.kind!=="workflow"||target.workflowId!==state.component.workflowId):state.component.kind==="skill"?(target.kind!=="skill"||target.skillPath!==state.component.path):state.component.kind==="instruction"?target.kind!=="profile":target.kind!=="agent_action")throw new Error("Test the selected authored Profile component.");
      if(state.component.kind==="agent"){const release=await base(state),compiled=await compileLocalHarnessSource({workspaceId:typeof release.agentSnapshot.metadata.workspaceId==="string"?release.agentSnapshot.metadata.workspaceId:release.workspaceId,sourceDir:path.join(release.bundlePath,"source")}),bytes=compiled.sourceFiles.find(row=>row.path==="workflows/actions.json")?.bytes,action=bytes&&ProfileWorkflowActionsSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8"))).actions.find(row=>target.kind==="agent_action"&&row.id===target.actionId);if(!action||!state.component.path.startsWith(`agents/${action.agentId}/`))throw new Error("The tested Agent action belongs to a different authored component.");}
      const recipeHash=contentHash(recipe),operation=(kind:string)=>`improve-${kind}-${contentHash([id,state.frozen,recipeHash]).slice(0,40)}`;
      return transition(state,{status:"testing",test:{recipe,recipeHash,baselineOperationId:operation("base"),candidateOperationId:operation("candidate"),cancelRequestedAt:null,dispatching:null}});});},
    async failTesting(actor:ImprovementActor,id:string,revision:number,error:string,cancelled=false){return mutateOwned(actor,id,revision,async state=>{if(state.status!=="testing")throw new Error("The candidate has no active test.");return transition(state,{status:cancelled?"cancelled":"failed",error:error.slice(0,2000)});});},
    async completeComparison(actor:ImprovementActor,id:string,revision:number,baselineEvidence:{manifest:ExperimentManifest;result:ExperimentResult},candidateEvidence:{manifest:ExperimentManifest;result:ExperimentResult},humanSelections?:HumanComparisonSelections){
      const retained=await read(actor,id),previous=retained.comparison?.humanProjection;
      if(humanSelections&&retained.status==="ready_for_review"&&retained.revision===revision+1&&previous){
        if(contentHash(previous.selections)!==contentHash(humanSelections)||previous.original.baseline.id!==baselineEvidence.manifest.id||previous.original.baseline.resultHash!==baselineEvidence.result.contentHash||previous.original.candidate.id!==candidateEvidence.manifest.id||previous.original.candidate.resultHash!==candidateEvidence.result.contentHash)throw new Error("The original Human comparison command changed.");
        const fresh=await read(actor,id);if(fresh.contentHash!==retained.contentHash)throw new Error("The retained comparison changed during recovery.");return fresh;
      }
      return mutateOwned(actor,id,revision,async state=>{await owner(actor,state);if(state.status!=="testing"||!state.frozen||state.test?.cancelRequestedAt||state.test?.dispatching)throw new Error("Candidate has no settled uncancelled admitted test.");
      const originalBaseline=verifyExperimentEvidence(await deps.loadEvidence(actor,{id:baselineEvidence.manifest.id,contentHash:baselineEvidence.result.contentHash})),originalCandidate=verifyExperimentEvidence(await deps.loadEvidence(actor,{id:candidateEvidence.manifest.id,contentHash:candidateEvidence.result.contentHash}));
      if(!state.test)throw new Error("The comparison has no retained test operations.");
      for(const [kind,evidence]of [["baseline",originalBaseline],["candidate",originalCandidate]] as const){const expected=state.test.recipe.scoring?`improve-grade-${contentHash([state.id,state.test.recipeHash,kind]).slice(0,40)}`:kind==="baseline"?state.test.baselineOperationId:state.test.candidateOperationId;if(evidence.manifest.operationId!==expected)throw new Error("Compare only the exact originally admitted baseline and candidate operations.");}
      const projection=humanSelections?await humanProjection(actor,state,humanSelections,originalBaseline,originalCandidate):undefined;
      const baseline=projection?.baseline??originalBaseline,candidate=projection?.candidate??originalCandidate;
      const releaseOf=(manifest:ExperimentManifest)=>manifest.target.kind==="harness"||manifest.target.kind==="agent"?manifest.target.source.harnessRelease:null;
      if(contentHash(releaseOf(baseline.manifest))!==contentHash(state.baseRelease)||contentHash(releaseOf(candidate.manifest))!==contentHash(state.frozen.release))throw new Error("The comparison did not execute the exact baseline and frozen candidate releases.");
      if(baseline.result.status!=="completed"||candidate.result.status!=="completed"||[...baseline.result.cases,...candidate.result.cases].some(row=>row.status!=="completed"||row.feedback.some(item=>item.status!=="scored")))throw new Error("Complete all admitted case execution and grading before adopting this candidate.");
      if(!compareExperiments(baseline,candidate).comparable)throw new Error("Candidate and baseline require a matched population, environment and graders.");
      if(!state.test)throw new Error("The comparison has no admitted immutable rerun recipe.");
      const binding=state.test.recipe.externalDatasetBinding,expectedPopulation=binding.population.map(row=>({caseId:row.taskId,seed:row.seed,fixtureId:row.fixtureId}));
      if(contentHash(baseline.manifest.dataset)!==contentHash(binding.dataset)||contentHash(baseline.manifest.population)!==contentHash(expectedPopulation)||contentHash(originalBaseline.manifest.evaluators)!==contentHash(state.test.recipe.scoring?state.evidence.manifest.evaluators:binding.evaluators))throw new Error("The qualification changed its admitted rerun population or evaluator selection.");
      for(const run of [baseline,candidate])if((run.manifest.target.kind!=="harness"&&run.manifest.target.kind!=="agent")||!("profileId" in run.manifest.target.source)||contentHash(run.manifest.target.source.externalDatasetBinding)!==contentHash(binding))throw new Error("The executed Profile omitted its actual immutable external Dataset recipe.");
      return transition(state,{status:"ready_for_review",comparison:{baseline,candidate,frozenHash:contentHash(state.frozen),...(projection?{humanProjection:projection}:{})}});});},
    async beginAdoption(actor:ImprovementActor,id:string,revision:number){const state=await read(actor,id);if(state.status==="adopting"||state.status==="accepted")return state;
      return mutateOwned(actor,id,revision,async current=>{await owner(actor,current);if(current.status!=="ready_for_review"||!current.frozen||!current.comparison)throw new Error("Use candidate requires its complete exact tested revision.");
        return transition(current,{status:"adopting",adoptionIntent:{operationId:`adopt-${contentHash([id,current.frozen]).slice(0,40)}`,expectedOwnerRevision:current.ownerRevision,frozenHash:contentHash(current.frozen)}});});
    },
    async useCandidate(actor:ImprovementActor,id:string,revision:number){
      let state=await read(actor,id);
      if(state.status==="accepted")return state;
      if(state.status!=="adopting")state=await this.beginAdoption(actor,id,revision);
      if(!state.frozen||!state.adoptionIntent)throw new Error("Adoption has no durable tested intent.");
      const release=await deps.store.getHarnessReleaseRecord(state.frozen.release.contentHash);if(!release||release.harnessRelease.id!==state.frozen.release.id)throw new Error("Tested candidate release is unavailable.");
      await reauthorizeHuman(actor,state);
      // The intent commits before owner I/O. A lost reply resumes the same owner receipt.
      const receipt=await deps.readAdoption(actor,state,state.adoptionIntent.operationId)??await deps.adopt(actor,state,release,state.adoptionIntent.operationId);
      if(contentHash(receipt.testedCandidateRelease)!==contentHash(state.frozen.release)||receipt.executableSourceHash!==state.frozen.executableSourceHash||receipt.protectedClosureHash!==state.frozen.protectedClosureHash)throw new Error("Owner adoption differs from tested executable source or protected closure.");
      await reauthorizeHuman(actor,state);
      return states.mutate(id,actor.actorId,actor.teamId,state.revision,async current=>{if(current.status!=="adopting"||contentHash(current.adoptionIntent)!==contentHash(state.adoptionIntent))throw new Error("Adoption intent changed during owner readback.");return transition(current,{status:"accepted",acceptance:receipt.receipt});});
    },
    async rollback(actor:ImprovementActor,id:string,revision:number){const state=await read(actor,id);if(state.status==="rolled_back")return state;if(state.status!=="accepted"||state.revision!==revision||!state.acceptance)throw new Error("Rollback requires the current accepted Profile adoption.");
      const receipt=await deps.rollback(actor,state,`rollback-${state.acceptance.contentHash.slice(0,40)}`);if(contentHash(receipt.testedCandidateRelease)!==contentHash(state.baseRelease))throw new Error("Profile rollback did not restore the original executable release.");
      return states.mutate(id,actor.actorId,actor.teamId,revision,async current=>transition(current,{status:"rolled_back",rollback:receipt.receipt}));},
    async discard(actor:ImprovementActor,id:string,revision:number,cancelled=false){return mutateOwned(actor,id,revision,async state=>{await owner(actor,state);if(["authoring_queued","authoring","testing"].includes(state.status))throw new Error("Cancel the actual Work/evaluation execution before discarding the candidate.");if(state.status==="accepted"||state.status==="rolled_back"||state.status==="adopting")throw new Error("Recover adoption or use the owner rollback operation for an adopted release.");return transition(state,{status:cancelled?"cancelled":"declined"});});},
    async partition(actor:ImprovementActor,id:string){const state=await read(actor,id);await owner(actor,state);return readExperimentCandidatePartition(deps.storeDir,id);},
    states,close:()=>states.close()
  };
  return service;
}
