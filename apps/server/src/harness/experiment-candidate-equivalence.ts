import { z } from "zod";
import { contentHash, sha256, canonicalJson } from "@openpond/harness";
import type { CompiledLocalHarnessSource } from "./local-harness-workspace-service.js";

/** Only Git provenance may change when exactly tested bytes become an actual Profile commit. */
export function compiledCandidateExecutableIdentity(source:CompiledLocalHarnessSource) {
  const {profileGitHead:_git,...metadata}=source.manifest.metadata;
  const assets=source.sourceFiles.map(file=>{
    if(file.path!=="dependency-lock/profile-import.json")return{path:file.path,asset:file.asset};
    const generated=z.object({source:z.literal("openpond.profile"),profileId:z.string(),profileGitHead:z.string().nullable(),dependenciesResolved:z.literal(false)}).strict().parse(JSON.parse(Buffer.from(file.bytes).toString("utf8")));
    if(source.manifest.metadata.importedFrom!=="openpond.profile"||generated.profileId!==source.manifest.metadata.profileId||generated.profileGitHead!==_git)throw new Error("Generated Profile provenance differs from compiler metadata.");
    const bytes=Buffer.from(canonicalJson({...generated,profileGitHead:null}));return{path:file.path,asset:{...file.asset,contentHash:sha256(bytes),sizeBytes:bytes.byteLength}};
  });
  const body={manifest:{...source.manifest,metadata},assets};
  return {contentHash:contentHash(body),protectedClosureHash:contentHash(source.sourceFiles.filter(file=>file.asset.visibility!=="policy").map(file=>({path:file.path,asset:file.asset}))),
    profileGitHead:typeof source.manifest.metadata.profileGitHead==="string"?source.manifest.metadata.profileGitHead:null};
}
export function qualifyCommittedCandidateEquivalence(candidate:CompiledLocalHarnessSource,active:CompiledLocalHarnessSource,expectedCommit:string) {
  const tested=compiledCandidateExecutableIdentity(candidate),installed=compiledCandidateExecutableIdentity(active);
  if(!/^[a-f0-9]{40}$/.test(expectedCommit)||installed.profileGitHead!==expectedCommit||tested.contentHash!==installed.contentHash||tested.protectedClosureHash!==installed.protectedClosureHash)
    throw new Error("The actual committed Profile differs from tested executable source or its protected evaluator closure.");
  return {schemaVersion:"openpond.candidateExecutableEquivalence.v1" as const,contentHash:tested.contentHash,protectedClosureHash:tested.protectedClosureHash,
    candidateProfileGitHead:tested.profileGitHead,activeProfileGitHead:installed.profileGitHead};
}
const Hash=z.string().regex(/^[a-f0-9]{64}$/),Ref=z.object({id:z.string().min(1),contentHash:Hash}).strict();
export const CandidateProfileAdoptionReceiptSchema=z.object({schemaVersion:z.literal("openpond.candidateProfileAdoption.v1"),id:z.string().min(1),operationId:z.string().min(1),actorId:z.string().min(1),teamId:z.string().min(1),
  candidateId:z.string().min(1),testedCandidateRelease:Ref,activeRelease:Ref,expectedCommit:z.string().regex(/^[a-f0-9]{40}$/),committedProfileGit:z.string().regex(/^[a-f0-9]{40}$/),
  equivalence:z.object({schemaVersion:z.literal("openpond.candidateExecutableEquivalence.v1"),contentHash:Hash,protectedClosureHash:Hash,candidateProfileGitHead:z.string().nullable(),activeProfileGitHead:z.string()}).strict(),createdAt:z.string().datetime(),contentHash:Hash}).strict();
export type CandidateProfileAdoptionReceipt=z.infer<typeof CandidateProfileAdoptionReceiptSchema>;
export function sealCandidateProfileAdoptionReceipt(input:Omit<CandidateProfileAdoptionReceipt,"contentHash">){const value=CandidateProfileAdoptionReceiptSchema.parse({...input,contentHash:contentHash(input)});if(value.equivalence.activeProfileGitHead!==value.committedProfileGit)throw new Error("Adoption receipt differs from its qualified committed source.");return value;}
