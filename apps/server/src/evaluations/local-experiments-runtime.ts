import {createLocalRewardGradingResolver} from "./local-reward-grading.js";
import {createLocalExternalDatasetPreparation} from "../harness/local-external-dataset-preparation.js";
import {createClaudeCodeOwner} from "./claude-code-owner.js";
import {resolveLocalHumanPublishedPackage} from "../human-review/published-package.js";
import {createLocalInferenceOwner,type LocalInferenceState} from "./local-experiment-local-inference.js";
import {OpenPondTasksetPackageClient} from "openpond-sdk/taskset-packages";
import {OpenPondTrainingProjectClient} from "openpond-sdk/training-projects";
import { createLocalProfileOriginAdapter } from "./local-experiment-profile-origin.js";
import { contentHash } from "@openpond/harness";
import { streamOpenPondHostedChatTurn } from "@openpond/runtime";
import type { SqliteStore } from "../store/store.js";
import { createLocalExperimentService } from "./local-experiment-service.js";
import { createLocalExperimentEnvironment } from "./local-experiment-environment.js";
import { createLocalProfileExperimentOwner } from "./local-experiment-profile.js";
import { createLocalNativeExperimentOwner } from "./local-experiment-native.js";
import { createLocalExperimentSourceChoices } from "./local-experiment-source-choices.js";
import { createLocalExperimentRemoteSourceAuthority, createLocalExperimentRemoteSourceLookup } from "./local-experiment-source-hosting.js";
import { createLocalExperimentPackageResolver, createLocalExperimentProjectAuthorizer } from "./local-experiment-package.js";
import { profileEvaluationsForRelease } from "../harness/local-profile-evaluation-runtime.js";
import { loadLocalProfileEvaluationTaskset } from "../harness/local-profile-evaluation-taskset.js";

import type { LocalExperimentCandidateOriginAdapter } from "./local-experiment-candidate-origin.js";
type ProfileDeps=Parameters<typeof createLocalProfileExperimentOwner>[0];
type SourceDeps=Parameters<typeof createLocalExperimentSourceChoices>[0];
/** Compose the ordinary owners after startup without acquiring unrestricted
 * native inference. Session dispatch remains lazy until the turn runner exists. */
export function createLocalExperimentsRuntime(deps: {
  store:SqliteStore;storeDir:string;ownerId:string;localInferenceState?:LocalInferenceState;candidateOrigins?:LocalExperimentCandidateOriginAdapter;
  actorId:ProfileDeps["actorId"];teamId:ProfileDeps["teamId"];
  createSession:ProfileDeps["createSession"];sendTurn:ProfileDeps["sendTurn"];interruptSessionTurn:ProfileDeps["interruptSessionTurn"];
  saveOutput:ProfileDeps["saveOutput"];recordOutput:ProfileDeps["recordOutput"];
  prepare:ProfileDeps["prepare"];workflows:SourceDeps["workflows"];
  resolveAccess:()=>Promise<{apiBaseUrl:string;token:string}>;
}) {
  const {store,storeDir}=deps;
  const sourceAccess=async()=>({...await deps.resolveAccess(),teamId:await deps.teamId(),actorId:await deps.actorId()});
  const origins=createLocalProfileOriginAdapter({store,storeDir,resolveAccess:sourceAccess});
  const candidate = deps.candidateOrigins;
  const authorizeOrigin:ProfileDeps["authorizeOrigin"]=async(workspace,reference,ref)=>workspace.metadata.experimentCandidateOrigin!==undefined
    ? candidate ? candidate.authority(workspace,reference,ref) : Promise.reject(new Error("Candidate origin authority is unavailable.")) : origins.authority(workspace,reference,ref);
  const resolveProfileRef:NonNullable<ProfileDeps["resolveProfileRef"]>=async(repositoryId,profileId,reference)=>candidate&&await candidate.hasOrigin(reference)
    ? candidate.resolveRef(repositoryId,profileId,reference):origins.resolveRef(repositoryId,profileId,reference);
  const workflows:SourceDeps["workflows"]=async(ref,source)=>ref&&source&&candidate&&await candidate.hasOrigin(source.harnessRelease)
    ? candidate.workflows(ref,source):ref?.source==="openpond_git"?origins.workflows(ref,source):deps.workflows(ref,source);
  const prepare:ProfileDeps["prepare"]=async(raw,options)=> {
    const ref=(raw as {profileRef?:import("@openpond/contracts").OpenPondProfileRef}).profileRef;
    const source=(raw as {profileSource?:{sourceRevision:string;harnessRelease:{id:string;contentHash:string}}}).profileSource;
    if(ref&&source&&candidate&&await candidate.hasOrigin(source.harnessRelease))return deps.prepare(raw,{...options,selectedWorkflows:await candidate.workflows(ref,source)});
    if(ref?.source!=="openpond_git")return deps.prepare(raw,options);
    return deps.prepare(raw,{...options,selectedWorkflows:await origins.workflows(ref,source)});
  };
  const localNativeOwner=createLocalNativeExperimentOwner({...deps,authorizeRemote:createLocalExperimentRemoteSourceAuthority({resolveAccess:sourceAccess})});
  const resolveExternalDataset=createLocalExternalDatasetPreparation({store,storeDir,resolveAccess:deps.resolveAccess,identity:async()=>({actorId:await deps.actorId(),teamId:await deps.teamId()})});
  const localProfileOwner=createLocalProfileExperimentOwner({...deps,prepare,authorizeOrigin,resolveProfileRef,resolveExternalDataset,loadPackage:async prepared=> {
    const source=prepared.manifest.profileEvaluation!;
    if(source.externalDatasetBinding){
      const admitted=await resolveExternalDataset(source.externalDatasetBinding,{profileRef:prepared.profileRef,sourceRevision:prepared.binding.sourceRevision,harnessRelease:prepared.binding.harnessRelease});
      await admitted.authorize();
      return admitted.packageValue;
    }
    const catalog=await profileEvaluationsForRelease({store,ref:prepared.profileRef,sourceRevision:source.sourceRevision,harnessRelease:source.harnessRelease});
    const definition=catalog.definitions.find(item=>item.id===source.definitionId&&contentHash(item)===source.definitionHash);
    if(!definition)throw new Error("The exact local Profile Dataset definition is unavailable.");
    return loadLocalProfileEvaluationTaskset({store,storeDir,definition,profileId:source.profileId,harnessRelease:source.harnessRelease});
  }});
  const localSourceChoices=createLocalExperimentSourceChoices({store,native:localNativeOwner.native,workflows,originProfiles:origins.discover,authorizeOrigin,
    loadPackage:(definition,profileId,harnessRelease)=>loadLocalProfileEvaluationTaskset({store,storeDir,definition,profileId,harnessRelease}),
    remoteSource:createLocalExperimentRemoteSourceLookup({resolveAccess:sourceAccess})});
  const remotePackage=createLocalExperimentPackageResolver({resolveAccess:deps.resolveAccess});
  const publishedPackage=async(scope:string,projectId:string,release:{id:string;revision:number;contentHash:string})=>{const access=await sourceAccess();if(access.teamId!==scope)throw new Error("Local publication workspace changed.");const options={baseUrl:access.apiBaseUrl,apiKey:access.token,teamId:scope};const project=await new OpenPondTrainingProjectClient(options).get(projectId);if(project.archived)throw new Error("The Project is archived.");return resolveLocalHumanPublishedPackage({store,storeDir,scope,actorId:access.actorId,projectId,release,loadBaseline:async(reference)=>await localSourceChoices.packageByRelease(reference)??await new OpenPondTasksetPackageClient(options).getByRelease(reference)});};
  const loopback=deps.localInferenceState?createLocalInferenceOwner(deps.localInferenceState):undefined;
  const claude=deps.localInferenceState?createClaudeCodeOwner({state:deps.localInferenceState,store,ownerId:deps.ownerId,actorId:deps.actorId,teamId:deps.teamId}):undefined;
  const inference=loopback&&claude?{choices:loopback.choices,claudeReadiness:claude.readiness,claudeControl:claude.control,prepare:(configuration:Parameters<typeof loopback.prepare>[0])=>configuration.request.policy.kind==="hosted_chat"&&configuration.request.policy.localRuntime?.providerId==="claude-code"?claude.prepare(configuration):loopback.prepare(configuration)}:undefined;
  const resolveSelectedRewards=createLocalRewardGradingResolver({resolveAccess:deps.resolveAccess,identity:async()=>({actorId:await deps.actorId(),teamId:await deps.teamId()})});
  const localExperiments=createLocalExperimentService({resolveSelectedRewards,localInference:inference,store,storeDir,runtimeEventsForTurn:id=>store.runtimeEventsForTurn(id),ownerId:deps.ownerId,stream:streamOpenPondHostedChatTurn,
    actorId:deps.actorId,teamId:deps.teamId,nativeHarness:localNativeOwner.native,profile:localProfileOwner.profile,
    sourceChoices:localSourceChoices.list,sourceDataset:localSourceChoices.population,
    environment:createLocalExperimentEnvironment(),authorizeProject:createLocalExperimentProjectAuthorizer({resolveAccess:deps.resolveAccess}),
    readHumanTaskPackage:async(scope,projectId,release)=>{const access=await deps.resolveAccess(),options={baseUrl:access.apiBaseUrl,apiKey:access.token,teamId:scope};const project=await new OpenPondTrainingProjectClient(options).get(projectId);if(project.archived)throw new Error("The Project is archived.");return await publishedPackage(scope,projectId,release)??await localSourceChoices.packageByRelease(release)??await new OpenPondTasksetPackageClient(options).getByRelease(release);},
    resolvePackage:async input=>await (input.configuration.request.project?.id?publishedPackage(input.configuration.request.teamId,input.configuration.request.project.id,input.configuration.request.taskset):Promise.resolve(null))??await localSourceChoices.packageByRelease(input.configuration.request.taskset)??await remotePackage(input)});
  const closeExperiments=localExperiments.close;
  localExperiments.close=async()=>{try{await closeExperiments();}finally{localProfileOwner.close();}};
  return {localExperiments,localNativeOwner,localProfileOwner};
}
