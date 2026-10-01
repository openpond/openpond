import {promises as fs} from "node:fs";
import path from "node:path";
import {inspectOpenPondProfileSource} from "@openpond/cloud";
import type {HarnessStateStore} from "../store/harness-state-store.js";
import type {ExperimentImprovementState} from "./experiment-improvement-state.js";
import {profileOriginFilesHash} from "../evaluations/local-experiment-profile-origin-materialization.js";
/** A canonical owner-authorized committed archive is a read-only input. Its
 * private bytes may hydrate compiler staging but never enter authoring Work. */
export async function withRemoteProfileCandidateSnapshot<T>(input:{store:HarnessStateStore;storeDir:string;state:ExperimentImprovementState},run:(source:{root:string;profile:Awaited<ReturnType<typeof inspectOpenPondProfileSource>>;source:string})=>Promise<T>){
 const workspace=await input.store.getHarnessWorkspace(input.state.ownerWorkspaceId),origin=workspace?.metadata.profileExperimentOrigin as {actorId?:unknown;teamId?:unknown;sourceRevision?:unknown;sourcePath?:unknown;sourceFilesHash?:unknown}|undefined,expected=path.join(input.storeDir,"library","profile-experiment-origins",input.state.ownerWorkspaceId);
 if(input.state.profileRef.source!=="openpond_git"||workspace?.location!=="local"||workspace.metadata.selectionEligible!==false||origin?.actorId!==input.state.actorId||origin.teamId!==input.state.teamId||origin.sourceRevision!==input.state.baseProfileSourceRevision||origin.sourcePath!==expected||typeof origin.sourceFilesHash!=="string"||await profileOriginFilesHash(expected)!==origin.sourceFilesHash)throw new Error("The exact authorized committed Profile snapshot is unavailable.");
 const parent=path.join(input.storeDir,"library","harnesses","profile-candidate-staging");await fs.mkdir(parent,{recursive:true,mode:0o700});const root=await fs.mkdtemp(path.join(parent,"remote-source-"));try{await fs.cp(expected,root,{recursive:true,errorOnExist:true,force:false});const profile=await inspectOpenPondProfileSource(root,input.state.profileRef.profileId);if(profile.error||!profile.sourcePath)throw new Error("The actual committed Profile archive cannot compile.");const result=await run({root,profile,source:profile.sourcePath});if(await profileOriginFilesHash(expected)!==origin.sourceFilesHash)throw new Error("The committed Profile cache changed during candidate compilation.");return result;}finally{await fs.rm(root,{recursive:true,force:true});}
}
