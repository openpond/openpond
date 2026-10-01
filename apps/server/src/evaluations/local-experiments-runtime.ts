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

type ProfileDeps=Parameters<typeof createLocalProfileExperimentOwner>[0];
type SourceDeps=Parameters<typeof createLocalExperimentSourceChoices>[0];
/** Compose the ordinary owners after startup without acquiring unrestricted
 * native inference. Session dispatch remains lazy until the turn runner exists. */
export function createLocalExperimentsRuntime(deps: {
  store:SqliteStore;storeDir:string;ownerId:string;
  actorId:ProfileDeps["actorId"];teamId:ProfileDeps["teamId"];
  createSession:ProfileDeps["createSession"];sendTurn:ProfileDeps["sendTurn"];interruptSessionTurn:ProfileDeps["interruptSessionTurn"];
  prepare:ProfileDeps["prepare"];workflows:SourceDeps["workflows"];
  resolveAccess:()=>Promise<{apiBaseUrl:string;token:string}>;
}) {
  const {store,storeDir}=deps;
  const sourceAccess=async()=>({...await deps.resolveAccess(),teamId:await deps.teamId(),actorId:await deps.actorId()});
  const localNativeOwner=createLocalNativeExperimentOwner({...deps,authorizeRemote:createLocalExperimentRemoteSourceAuthority({resolveAccess:sourceAccess})});
  const localProfileOwner=createLocalProfileExperimentOwner({...deps,loadPackage:async prepared=> {
    const source=prepared.manifest.profileEvaluation!;
    const catalog=await profileEvaluationsForRelease({store,ref:prepared.profileRef,sourceRevision:source.sourceRevision,harnessRelease:source.harnessRelease});
    const definition=catalog.definitions.find(item=>item.id===source.definitionId&&contentHash(item)===source.definitionHash);
    if(!definition)throw new Error("The exact local Profile Dataset definition is unavailable.");
    return loadLocalProfileEvaluationTaskset({store,storeDir,definition,profileId:source.profileId,harnessRelease:source.harnessRelease});
  }});
  const localSourceChoices=createLocalExperimentSourceChoices({store,native:localNativeOwner.native,workflows:deps.workflows,
    loadPackage:(definition,profileId,harnessRelease)=>loadLocalProfileEvaluationTaskset({store,storeDir,definition,profileId,harnessRelease}),
    remoteSource:createLocalExperimentRemoteSourceLookup({resolveAccess:sourceAccess})});
  const remotePackage=createLocalExperimentPackageResolver({resolveAccess:deps.resolveAccess});
  const localExperiments=createLocalExperimentService({store,ownerId:deps.ownerId,stream:streamOpenPondHostedChatTurn,
    actorId:deps.actorId,teamId:deps.teamId,nativeHarness:localNativeOwner.native,profile:localProfileOwner.profile,
    sourceChoices:localSourceChoices.list,sourceDataset:localSourceChoices.population,
    environment:createLocalExperimentEnvironment(),authorizeProject:createLocalExperimentProjectAuthorizer({resolveAccess:deps.resolveAccess}),
    resolvePackage:async input=>await localSourceChoices.packageByRelease(input.configuration.request.taskset)??await remotePackage(input)});
  return {localExperiments,localNativeOwner,localProfileOwner};
}
