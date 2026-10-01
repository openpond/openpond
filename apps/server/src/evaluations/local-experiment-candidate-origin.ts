import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { OpenPondProfileRefSchema, type HarnessWorkspace, type OpenPondProfileRef } from "@openpond/contracts";
import type { HarnessStateStore } from "../store/harness-state-store.js";
import type { LocalExperimentImprovementService } from "../harness/experiment-improvement-service.js";
import { profileWorkflowsForRelease } from "../harness/local-profile-workflow-runtime.js";
import { resolveLocalProfileExperimentSource } from "./local-experiment-profile-source.js";
import type { ProfileOriginAuthority } from "./local-experiment-profile-origin.js";
const Id=z.string().min(1).max(240),Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const ExperimentCandidateOriginSchema=z.object({schemaVersion:z.literal("openpond.experimentCandidateOrigin.v1"),candidateId:Id,actorId:Id,teamId:Id,baseWorkspaceId:Id,
  baseProfileRef:OpenPondProfileRefSchema,baseProfileSourceRevision:z.string().min(1).max(500),baseRelease:z.object({id:Id,contentHash:Hash}).strict(),frozenRevision:z.number().int().positive(),frozenHash:Hash}).strict();

/** A marker selects a mandatory check; it never grants source authority itself. */
export function createLocalExperimentCandidateOriginAdapter(deps:{store:HarnessStateStore;improvements:LocalExperimentImprovementService;actorId():Promise<string>;teamId():Promise<string>;authorizeBaseOrigin?:ProfileOriginAuthority}) {
  async function require(workspace:HarnessWorkspace,reference:{id:string;contentHash:string},ref?:OpenPondProfileRef){
    const origin=ExperimentCandidateOriginSchema.parse(workspace.metadata.experimentCandidateOrigin),actorId=await deps.actorId(),teamId=await deps.teamId();
    if(origin.actorId!==actorId||origin.teamId!==teamId||workspace.metadata.selectionEligible!==false||workspace.location!=="local"||workspace.ownerScope.kind!=="personal"||workspace.ownerScope.id!==actorId)
      throw new Error("Candidate origin is unavailable to this account or placement.");
    const state=await deps.improvements.read({actorId,teamId},origin.candidateId);
    if(!state.frozen||["draft","authoring","failed","cancelled","declined"].includes(state.status)||state.ownerWorkspaceId!==origin.baseWorkspaceId||contentHash(state.profileRef)!==contentHash(origin.baseProfileRef)
      ||state.baseProfileSourceRevision!==origin.baseProfileSourceRevision||contentHash(state.baseRelease)!==contentHash(origin.baseRelease)||state.frozen.candidateRevision!==origin.frozenRevision
      ||contentHash(state.frozen)!==origin.frozenHash||contentHash(reference)!==contentHash(state.frozen.release)||contentHash(workspace.currentChannel.release)!==contentHash(reference)
      ||ref&&contentHash(ref)!==contentHash(state.profileRef))throw new Error("Candidate origin differs from its durable owner and exact frozen revision.");
    await resolveLocalProfileExperimentSource(deps.store,state.baseRelease,state.profileRef,deps.authorizeBaseOrigin);
    if(await deps.actorId()!==actorId||await deps.teamId()!==teamId)throw new Error("Candidate account changed during admission.");
    return state;
  }
  async function workspace(reference:{id:string;contentHash:string}){const release=await deps.store.getHarnessReleaseRecord(reference.contentHash);if(!release||release.harnessRelease.id!==reference.id)return null;const value=await deps.store.getHarnessWorkspace(release.workspaceId);return value?.metadata.experimentCandidateOrigin!==undefined?{workspace:value,release}:null;}
  return {
    hasOrigin:async(reference:{id:string;contentHash:string})=>Boolean(await workspace(reference)),
    authority:(async(owner,reference,ref)=>{await require(owner,reference,ref);}) satisfies ProfileOriginAuthority,
    async resolveRef(repositoryId:string,profileId:string,reference:{id:string;contentHash:string}){const value=await workspace(reference);if(!value)throw new Error("Candidate source is unavailable.");const state=await require(value.workspace,reference);if(state.profileRef.repositoryId!==repositoryId||state.profileRef.profileId!==profileId)throw new Error("Candidate Profile reference changed.");return state.profileRef;},
    async workflows(ref:OpenPondProfileRef,source?:{sourceRevision:string;harnessRelease:{id:string;contentHash:string}}){if(!source)throw new Error("Candidate discovery requires its frozen source reference.");const value=await workspace(source.harnessRelease);if(!value)throw new Error("Candidate source is unavailable.");const state=await require(value.workspace,source.harnessRelease,ref);if(source.sourceRevision!==state.frozen!.profileSourceRevision)throw new Error("Candidate Profile source revision changed.");
      const result=await profileWorkflowsForRelease({store:deps.store,release:value.release,ref,sourceRevision:source.sourceRevision});await require(value.workspace,source.harnessRelease,ref);return result;}
  };
}
export type LocalExperimentCandidateOriginAdapter=ReturnType<typeof createLocalExperimentCandidateOriginAdapter>;
