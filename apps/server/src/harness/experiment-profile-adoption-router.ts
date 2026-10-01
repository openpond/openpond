import {ExperimentImprovementClient} from "openpond-sdk/experiment-improvements";
import type {createLocalProfileGitCandidateAdoption} from "./experiment-profile-git-adoption.js";
import {exportHostedProfileCandidate} from "./experiment-profile-candidate-export.js";
import type {ImprovementActor,ImprovementAdoptionReadback} from "./experiment-improvement-service.js";
import type {ExperimentImprovementState} from "./experiment-improvement-state.js";
import type {HarnessStateStore} from "../store/harness-state-store.js";
/** Remote source activation always belongs to the actual hosted Git owner.
 * An installed native snapshot is only a read-only authoring/test input. */
export function routeProfileCandidateAdoption(deps:{local:ReturnType<typeof createLocalProfileGitCandidateAdoption>;store:HarnessStateStore;
 actorId():Promise<string>;teamId():Promise<string>;resolveAccess():Promise<{apiBaseUrl:string;token:string}>}){
 async function client(actor:ImprovementActor){if(await deps.actorId()!==actor.actorId||await deps.teamId()!==actor.teamId)throw new Error("Profile candidate authority changed.");const access=await deps.resolveAccess();return new ExperimentImprovementClient({baseUrl:access.apiBaseUrl,apiKey:access.token,actorId:actor.actorId,teamId:actor.teamId});}
 async function hosted(actor:ImprovementActor,state:ExperimentImprovementState,raw:Parameters<ExperimentImprovementClient["hostedCandidate"]>[0]):Promise<ImprovementAdoptionReadback>{const result=await (await client(actor)).hostedCandidate(raw);await client(actor);if(result.candidateId!==state.id||result.protectedClosureHash!==state.frozen?.protectedClosureHash)throw new Error("Hosted Profile receipt differs from this exact candidate closure.");return{receipt:{id:result.id,contentHash:result.contentHash},activeRelease:result.activeRelease,testedCandidateRelease:result.testedCandidateRelease,executableSourceHash:result.executableSourceHash,protectedClosureHash:result.protectedClosureHash};}
 return{freezeProfile:deps.local.freezeProfile,
  async adopt(actor:ImprovementActor,state:ExperimentImprovementState,release:Parameters<typeof deps.local.adopt>[2],operationId:string){if(state.profileRef.source==="local")return deps.local.adopt(actor,state,release,operationId);if(state.profileRef.source!=="openpond_git")throw new Error("Adopt this external repository through its authorized original Git owner.");await client(actor);const source=await exportHostedProfileCandidate(deps.store,state);await client(actor);return hosted(actor,state,{operation:"adopt",operationId,export:source});},
  async readAdoption(actor:ImprovementActor,state:ExperimentImprovementState,operationId:string){if(state.profileRef.source==="local")return deps.local.readAdoption(actor,state,operationId);try{return await hosted(actor,state,{operation:"read",operationId,adoptionOperationId:operationId,profileRepositoryId:state.profileRef.repositoryId});}catch(error){if((error as {status?:number;code?:string}).status===404&&(error as {code?:string}).code==="profile_candidate_adoption_unavailable")return null;throw error;}},
  async rollback(actor:ImprovementActor,state:ExperimentImprovementState,operationId:string){if(state.profileRef.source==="local")return deps.local.rollback(actor,state,operationId);if(!state.adoptionIntent)throw new Error("The exact accepted adoption operation is unavailable.");return hosted(actor,state,{operation:"rollback",operationId,adoptionOperationId:state.adoptionIntent.operationId,profileRepositoryId:state.profileRef.repositoryId});}
 };
}
