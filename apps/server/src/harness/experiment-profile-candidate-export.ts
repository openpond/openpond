import {contentHash,canonicalJson,sha256,createHarnessSourcePackage,createHarnessPolicySourcePackage} from "@openpond/harness";
import {verifyHostedProfileCandidateExport} from "openpond-sdk/experiment-improvements";
import type {HarnessStateStore} from "../store/harness-state-store.js";
import type {ExperimentImprovementState} from "./experiment-improvement-state.js";
import {compileLocalHarnessSource} from "./local-harness-workspace-service.js";
import {compiledCandidateExecutableIdentity} from "./experiment-candidate-equivalence.js";
/** Privileged native exporter reads the private immutable store. The browser
 * supplies only candidate ID/revision to its ordinary explicit Use action. */
export async function exportHostedProfileCandidate(store:HarnessStateStore,state:ExperimentImprovementState,executionOrigin:"owner_attested_local"|"hosted_execution"="owner_attested_local"){
 if(state.profileRef.source!=="openpond_git"||!state.frozen||!state.comparison||!state.test||!state.adoptionIntent||state.status!=="adopting")throw new Error("Export only the exact owner-approved qualified hosted Profile candidate.");
 const record=await store.getHarnessReleaseRecord(state.frozen.release.contentHash);if(!record||record.harnessRelease.id!==state.frozen.release.id)throw new Error("The tested native candidate is unavailable.");
 const workspaceId=record.agentSnapshot.metadata.workspaceId;if(typeof workspaceId!=="string")throw new Error("The candidate compiler identity is absent.");
 const compiled=await compileLocalHarnessSource({workspaceId,sourceDir:`${record.bundlePath}/source`}),identity=compiledCandidateExecutableIdentity(compiled);
 if(compiled.harnessRelease.contentHash!==record.harnessRelease.contentHash||identity.contentHash!==state.frozen.executableSourceHash||identity.protectedClosureHash!==state.frozen.protectedClosureHash||state.comparison.frozenHash!==contentHash(state.frozen))throw new Error("The actual tested source differs from its qualified immutable candidate.");
 const repositoryId=compiled.manifest.metadata.profileRepositoryId;if(repositoryId!==state.profileRef.repositoryId)throw new Error("The candidate source compiler belongs to another Profile owner.");
 const manifest=Buffer.from(canonicalJson(compiled.manifest)),policySource=createHarnessPolicySourcePackage(createHarnessSourcePackage({agentSnapshot:compiled.agentSnapshot,harnessRelease:compiled.harnessRelease,files:new Map(compiled.sourceFiles.map(file=>[file.path,file.bytes]))}));
 const body={schemaVersion:"openpond.hostedProfileCandidateExport.v1" as const,actorId:state.actorId,teamId:state.teamId,candidateId:state.id,candidateRevision:state.revision,projectId:state.projectId,profileRef:{...state.profileRef,source:"openpond_git" as const},expectedCommit:state.baseProfileSourceRevision,component:state.component,baseRelease:state.baseRelease,frozenHash:contentHash(state.frozen),executableSourceHash:identity.contentHash,protectedClosureHash:identity.protectedClosureHash,compiler:{workspaceId,name:compiled.manifest.name,repositoryId},sourceManifest:{base64:manifest.toString("base64"),contentHash:sha256(manifest),sizeBytes:manifest.length},policySource,
 qualification:{kind:executionOrigin,ownerActorId:state.actorId,teamId:state.teamId,originalEvidence:{id:state.evidence.manifest.id,contentHash:state.evidence.result.contentHash},baseline:{id:state.comparison.baseline.manifest.id,contentHash:state.comparison.baseline.result.contentHash},candidate:{id:state.comparison.candidate.manifest.id,contentHash:state.comparison.candidate.result.contentHash},comparisonHash:contentHash(state.comparison),recipe:state.test.recipe},createdAt:state.adoptionIntent?state.updatedAt:state.createdAt};
 const result=verifyHostedProfileCandidateExport({...body,contentHash:contentHash(body)});if(Buffer.byteLength(JSON.stringify(result))>8*1024*1024)throw new Error("Candidate policy export exceeds the bounded hosted admission size.");return result;
}
