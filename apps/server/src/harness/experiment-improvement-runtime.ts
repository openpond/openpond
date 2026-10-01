import {createExperimentImprovementBudget} from "./experiment-improvement-budget.js";
import {OpenPondExperimentsClient} from "openpond-sdk/experiments";
import {OpenPondTrainingProjectClient} from "openpond-sdk/training-projects";
import {verifyExperimentEvidence} from "@openpond/evals/experiments";
import {loadOpenPondProfileStateForRef} from "@openpond/cloud";
import type {SqliteStore} from "../store/store.js";
import type {createLocalExperimentService} from "../evaluations/local-experiment-service.js";
import {createLocalProfileOriginAdapter} from "../evaluations/local-experiment-profile-origin.js";
import {resolveLocalProfileExperimentSource} from "../evaluations/local-experiment-profile-source.js";
import {createLocalExperimentCandidateOriginAdapter} from "../evaluations/local-experiment-candidate-origin.js";
import {createLocalExperimentImprovementService,type ImprovementActor,type LocalExperimentImprovementService} from "./experiment-improvement-service.js";
import {createExperimentCandidateTools} from "./experiment-candidate-tools.js";
import {createAcceptedHumanComparisonProjector} from "../human-review/improvement-comparison.js";
import type {createLocalHumanReviewRuntime} from "../human-review/runtime.js";

export interface ExperimentImprovementRuntime {
 service:LocalExperimentImprovementService;
 loadEvidence(actor:ImprovementActor,reference:{id:string;contentHash:string}):Promise<{manifest:import("@openpond/evals/experiments").ExperimentManifest;result:import("@openpond/evals/experiments").ExperimentResult}>;
 tools:ReturnType<typeof createExperimentCandidateTools>;
 candidateOrigins:ReturnType<typeof createLocalExperimentCandidateOriginAdapter>;
 resolveSessionModelStream:ReturnType<typeof createExperimentImprovementBudget>["resolveSessionModelStream"];
 close():Promise<void>;
}
type AdoptionDeps=Pick<Parameters<typeof createLocalExperimentImprovementService>[0],"adopt"|"readAdoption"|"freezeProfile"|"rollback">;
/** Startup-safe lazy dependencies preserve the ordinary Work and Experiment
 * owners. Root supplies actual Git/hosted adoption; no workspace-only fallback. */
export function createExperimentImprovementRuntime(deps:AdoptionDeps&{
  store:SqliteStore;storeDir:string;actorId():Promise<string>;teamId():Promise<string>;
  resolveAccess():Promise<{apiBaseUrl:string;token:string}>;
  localExperiments():ReturnType<typeof createLocalExperimentService>;
  humanReview?():ReturnType<typeof createLocalHumanReviewRuntime>;
  agentRuntime?:{source:string;cliRelativePath:string};loadAgentRuntime?:()=>Promise<{source:string;cliRelativePath:string}>;bwrapPath?:string;
}):ExperimentImprovementRuntime {
  async function current(actor:ImprovementActor){if(await deps.actorId()!==actor.actorId||await deps.teamId()!==actor.teamId)throw new Error("Improvement account or workspace changed.");}
  const origins=createLocalProfileOriginAdapter({store:deps.store,storeDir:deps.storeDir,resolveAccess:async()=>({...await deps.resolveAccess(),actorId:await deps.actorId(),teamId:await deps.teamId()})});
  async function loadEvidence(actor:ImprovementActor,reference:{id:string;contentHash:string}){
    await current(actor);let evidence;
    if(reference.id.startsWith("local-"))evidence=(await deps.localExperiments().compare({teamId:actor.teamId,baselineId:reference.id,candidateId:reference.id})).baseline;
    else{const access=await deps.resolveAccess(),client=new OpenPondExperimentsClient({baseUrl:access.apiBaseUrl,apiKey:access.token,teamId:actor.teamId});evidence=reference.id.startsWith("score_")?await client.scoringResult(reference.id):await client.result(reference.id);}
    const value=verifyExperimentEvidence(evidence);if(value.manifest.id!==reference.id||value.result.contentHash!==reference.contentHash||value.manifest.teamId!==actor.teamId)throw new Error("Improvement evidence differs from its actual owner result.");await current(actor);return value;
  }
  const authorizeOwner:Parameters<typeof createLocalExperimentImprovementService>[0]["authorizeOwner"]=async(actor,workspace,ref,projectId,options)=>{
      await current(actor);
      await resolveLocalProfileExperimentSource(deps.store,workspace.currentChannel.release!,ref,(value,reference,profileRef)=>origins.authority(value,reference,profileRef,{requireCurrentRevision:options.requireCurrentBase}));
      const profile=await loadOpenPondProfileStateForRef(ref);
      if(ref.source==="local"){
        if(profile.error||profile.activeProfile!==ref.profileId||profile.mode!=="local"||!profile.repoPath||!profile.sourcePath)throw new Error("The original Profile is not installed for this owner.");
        const release=await deps.store.getHarnessReleaseRecord(workspace.currentChannel.release!.contentHash);
        const source=release?.harnessRelease.metadata.profile as {sourceRevision?:string}|undefined;
        if(options.requireCurrentBase&&(!profile.git?.head||profile.git.dirty||profile.git.head!==source?.sourceRevision))throw new Error("Commit or reconcile the changed original Profile before authoring this candidate.");
      }
      if(projectId){const access=await deps.resolveAccess(),project=await new OpenPondTrainingProjectClient({apiKey:access.token,baseUrl:access.apiBaseUrl,teamId:actor.teamId}).get(projectId);if(project.archived)throw new Error("The selected Project is archived.");}
      await current(actor);
    };
  const projectHumanComparison=deps.humanReview?createAcceptedHumanComparisonProjector({humanReview:deps.humanReview,authorize:async(actor,state)=>{
    const workspace=await deps.store.getHarnessWorkspace(state.ownerWorkspaceId);
    if(!workspace)throw new Error("The original Human comparison owner is unavailable.");
    await authorizeOwner(actor,workspace,state.profileRef,state.projectId,{requireCurrentBase:false});
  }}):undefined;
  const service=createLocalExperimentImprovementService({...deps,
    authorizeOwner,projectHumanComparison,loadEvidence
  });
  const budget=createExperimentImprovementBudget({...deps,improvements:service});
  const tools=createExperimentCandidateTools({...deps,improvements:service,loadProfile:loadOpenPondProfileStateForRef});
  const candidateOrigins=createLocalExperimentCandidateOriginAdapter({...deps,improvements:service,authorizeBaseOrigin:origins.authority});
  return{service,loadEvidence,tools,candidateOrigins,resolveSessionModelStream:budget.resolveSessionModelStream,close:async()=>{await service.close();budget.close();}};
}
