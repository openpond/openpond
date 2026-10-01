import { readFile } from "node:fs/promises";
import path from "node:path";
import { contentHash, createHarnessSourcePackage, createHarnessSourceRuntime } from "@openpond/harness";
import { harnessExperimentReadToolDeclarations } from "@openpond/evals/experiments";
import type { OpenPondProfileRef } from "@openpond/contracts";
import { PROFILE_HARNESS_WORKSPACE_PREFIX } from "../harness/profile-harness-workspace-identity.js";
import type { HarnessStateStore } from "../store/harness-state-store.js";
import { loadLocalHarnessRuntimeFromRelease } from "../harness/local-harness-skill-runtime.js";
import type { ProfileOriginAuthority } from "./local-experiment-profile-origin.js";
import { LocalExperimentError } from "./local-experiment-contract.js";

/** Validate persisted device authority before reading immutable Profile bytes.
 * The canonical source runtime then checks program/dependency compatibility. */
export async function resolveLocalProfileExperimentSource(store:HarnessStateStore,reference:{id:string;contentHash:string},profileRef?:OpenPondProfileRef,authorizeOrigin?:ProfileOriginAuthority) {
  const release=await store.getHarnessReleaseRecord(reference.contentHash);
  const workspace=release&&await store.getHarnessWorkspace(release.workspaceId);
  if(!release||!workspace||release.harnessRelease.id!==reference.id||workspace.location!=="local"||workspace.metadata.sourceLayout!=="openpond.harnessSourceManifest.v1")
    throw new LocalExperimentError("local_profile_source_unavailable","The exact Profile Harness is unavailable.",403);
  const remote=workspace.metadata.profileExperimentOrigin!==undefined||workspace.metadata.experimentCandidateOrigin!==undefined;
  if(remote) {
    if(!authorizeOrigin||!profileRef)throw new LocalExperimentError("local_profile_origin_access_denied","This source requires its authenticated origin.",403);
    await authorizeOrigin(workspace,reference,profileRef);
  } else {
    if(workspace.ownerScope.kind!=="personal"||workspace.ownerScope.id!=="desktop-personal"||typeof release.harnessRelease.metadata.profileRepositoryId==="string"||typeof release.agentSnapshot.metadata.profileRepositoryId==="string")
      throw new LocalExperimentError("local_profile_origin_access_denied","The Profile is not device-owned.",403);
    const provenance=release.harnessRelease.metadata.profile as {id?:string;sourceRevision?:string;repositoryId?:string}|undefined;
    if(profileRef&&(profileRef.source!=="local"||provenance?.id!==profileRef.profileId||provenance.repositoryId&&provenance.repositoryId!==profileRef.repositoryId))throw new LocalExperimentError("local_profile_origin_access_denied","The retained Harness differs from this exact Profile reference.",403);
    if(workspace.metadata.selectionEligible===false&&(!profileRef||!provenance?.repositoryId||provenance.repositoryId!==profileRef.repositoryId||workspace.id!==`${PROFILE_HARNESS_WORKSPACE_PREFIX}${contentHash({ref:profileRef,sourceRevision:provenance.sourceRevision}).slice(0,24)}`))throw new LocalExperimentError("local_profile_origin_access_denied","This explicit Profile release requires its canonical accepted reference.",403);
  }
  const runtime=await loadLocalHarnessRuntimeFromRelease({workspace,release});
  const files=new Map<string,Uint8Array>();
  for(const asset of release.harnessRelease.files)files.set(asset.path,await readFile(path.join(release.bundlePath,"source",...asset.path.split("/"))));
  const value=createHarnessSourcePackage({agentSnapshot:release.agentSnapshot,harnessRelease:release.harnessRelease,files});
  const declarations=harnessExperimentReadToolDeclarations(release);
  createHarnessSourceRuntime({sourcePackage:value,expectedRelease:reference,baseSystemPrompt:"",
    runtimeId:"openpond.native-profile-experiment.v1",maxContextCharacters:262_144,
    tools:declarations.map(tool=>({name:tool.name,inputSchema:tool.inputSchema,
      definition:{type:"function",function:{name:tool.name,description:tool.description,parameters:tool.inputSchema}}}))});
  const current=await store.getHarnessWorkspace(workspace.id);
  if(!current||contentHash(current.ownerScope)!==contentHash(workspace.ownerScope)||contentHash(current.metadata)!==contentHash(workspace.metadata))
    throw new LocalExperimentError("local_profile_origin_access_denied","Profile source ownership changed during admission.",403);
  if(remote)await authorizeOrigin!(workspace,reference,profileRef!);
  return runtime;
}
