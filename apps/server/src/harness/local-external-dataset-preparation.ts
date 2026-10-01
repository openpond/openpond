import path from "node:path";
import {contentHash} from "@openpond/harness";
import {loadOpenPondProfileLibrary,loadOpenPondProfileStateForRef} from "@openpond/cloud";
import {OpenPondTasksetPackageClient} from "openpond-sdk/taskset-packages";
import {ConnectedEvidenceClient,ConnectedCaseRefSchema} from "openpond-sdk/connected-evidence";
import {OpenPondExperimentsClient,verifyExternalDatasetPackage} from "openpond-sdk/experiments";
import {createLocalProfileOriginAdapter} from "../evaluations/local-experiment-profile-origin.js";
import {localPackageGraders} from "../evaluations/local-experiment-admission.js";
import {ExperimentCandidateOriginSchema} from "../evaluations/local-experiment-candidate-origin.js";
import type {SqliteStore} from "../store/store.js";
import {compileLocalHarnessSource} from "./local-harness-workspace-service.js";
import {compiledCandidateExecutableIdentity} from "./experiment-candidate-equivalence.js";
import type {createProfileEvaluationRunPreparationService} from "./profile-evaluation-run-preparation.js";

type Resolver=NonNullable<Parameters<typeof createProfileEvaluationRunPreparationService>[0]["resolveExternalDataset"]>;

/** Owner-authorized private packages stay in the evaluator. Re-reading the
 * actual Dataset and recorded source prevents a hash supplied by the browser
 * from granting access or substituting a historical answer for a new run. */
export function createLocalExternalDatasetPreparation(deps:{store:SqliteStore;storeDir:string;
  identity():Promise<{actorId:string;teamId:string}>;resolveAccess():Promise<{apiBaseUrl:string;token:string}>;
}):Resolver{
  return async(binding,selected)=>{
    const owner=await deps.identity(),access=await deps.resolveAccess();
    const options={baseUrl:access.apiBaseUrl,apiKey:access.token,teamId:owner.teamId};
    const packages=new OpenPondTasksetPackageClient(options),connected=new ConnectedEvidenceClient(options),experiments=new OpenPondExperimentsClient(options);
    const origin=createLocalProfileOriginAdapter({...deps,resolveAccess:async()=>({...await deps.resolveAccess(),...await deps.identity()})});
    async function current(){
      if(contentHash(await deps.identity())!==contentHash(owner))throw new Error("The external Dataset account or workspace changed.");
      const next=await deps.resolveAccess();
      if(next.apiBaseUrl.replace(/\/$/,"")!==access.apiBaseUrl.replace(/\/$/,"")||next.token!==access.token)throw new Error("The external Dataset connection changed.");
    }
    async function read(){
      await current();
      if(binding.profileId!==selected.profileRef.profileId)throw new Error("The external Dataset recipe names another Profile.");
      const release=await deps.store.getHarnessReleaseRecord(selected.harnessRelease.contentHash);
      if(!release||release.harnessRelease.id!==selected.harnessRelease.id)throw new Error("The exact released Profile is unavailable.");
      const workspace=await deps.store.getHarnessWorkspace(release.workspaceId);
      if(!workspace)throw new Error("The released Profile owner is unavailable.");
      const candidate=workspace.metadata.experimentCandidateOrigin===undefined?null:ExperimentCandidateOriginSchema.parse(workspace.metadata.experimentCandidateOrigin);
      if(candidate&&(candidate.actorId!==owner.actorId||candidate.teamId!==owner.teamId||workspace.ownerScope.kind!=="personal"||workspace.ownerScope.id!==owner.actorId||workspace.metadata.selectionEligible!==false||contentHash(candidate.baseProfileRef)!==contentHash(selected.profileRef)))throw new Error("The candidate source belongs to another owner or Profile.");
      if(selected.profileRef.source==="local"){
        const library=await loadOpenPondProfileLibrary(),profile=await loadOpenPondProfileStateForRef(selected.profileRef);
        if(!library.profiles.some(entry=>contentHash(entry.ref)===contentHash(selected.profileRef))||profile.error||!profile.sourcePath||profile.activeProfile!==selected.profileRef.profileId)throw new Error("The original Profile is no longer installed for this owner.");
      }else{
        if(candidate){
          const base=await deps.store.getHarnessWorkspace(candidate.baseWorkspaceId);
          if(!base)throw new Error("The candidate's original Profile is unavailable.");
          await origin.authority(base,candidate.baseRelease,selected.profileRef);
        }else await origin.authority(workspace,selected.harnessRelease,selected.profileRef);
      }
      const compiled=await compileLocalHarnessSource({workspaceId:typeof release.agentSnapshot.metadata.workspaceId==="string"?release.agentSnapshot.metadata.workspaceId:release.workspaceId,sourceDir:path.join(release.bundlePath,"source")});
      if(compiled.harnessRelease.contentHash!==selected.harnessRelease.contentHash||compiledCandidateExecutableIdentity(compiled).protectedClosureHash!==binding.protectedProfileClosureHash)throw new Error("The original Profile's protected evaluator closure changed.");
      await current();
      const value=await packages.getByRelease(binding.dataset,{expectedPackageHash:binding.packageHash});
      await current();
      if(binding.recordedOrigin){
        const source=binding.recordedOrigin,recorded=await connected.recordedExecution(source.execution.id),pass=await experiments.scoringPass(source.originalEvidence.id),evidence=await experiments.scoringResult(source.originalEvidence.id);
        await current();
        if(recorded.contentHash!==source.execution.contentHash||contentHash(recorded.request.dataset)!==contentHash(binding.dataset)||evidence.manifest.population.length!==source.members.length
          ||pass.request.executionKind!=="recorded_evidence"||pass.request.execution.id!==recorded.id||evidence.result.contentHash!==source.originalEvidence.contentHash||contentHash(evidence.manifest.evaluators)!==contentHash(binding.evaluators))throw new Error("The original recorded grading evidence differs from this rerun recipe.");
        for(const[index,member]of source.members.entries()){
          const matches=recorded.sources.filter(actual=>actual.boundaryId===member.caseId);
          if(matches.length!==1)throw new Error("The original recorded case has no unique retained source cutoff.");
          const actual=matches[0]!,task=value.taskset.tasks.find(task=>task.id===member.caseId),ref=task&&ConnectedCaseRefSchema.parse(task.input.connectedEvidenceRef);
          if(!ref||actual.boundaryId!==member.caseId||actual.id!==member.sourceId||actual.snapshotHash!==member.snapshotHash||actual.boundaryRevisionHash!==member.boundaryRevisionHash
            ||contentHash(ref)!==contentHash({id:actual.id,snapshotHash:actual.snapshotHash,boundaryId:actual.boundaryId,boundaryRevisionHash:actual.boundaryRevisionHash})
            ||contentHash(evidence.manifest.population[index])!==contentHash({caseId:member.caseId,seed:member.seed,fixtureId:member.fixtureId}))throw new Error("The rerun changed an original ordered source cutoff.");
        }
      }
      const actualGrading=binding.gradingSource?{pass:await experiments.scoringPass(binding.gradingSource.pass.id),evidence:await experiments.scoringResult(binding.gradingSource.evidence.id)}:undefined;await current();
      const packageValue=verifyExternalDatasetPackage({binding,packageValue:value,graders:localPackageGraders(value),actualGrading});
      await current();return packageValue;
    }
    const packageValue=await read();
    return{binding,packageValue,authorize:async()=>{if(contentHash(await read())!==contentHash(packageValue))throw new Error("The external Dataset authority changed during preparation.");}};
  };
}
