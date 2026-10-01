import {z} from "zod";
import {contentHash,ImmutableReleaseRefSchema,HarnessPolicySourcePackageSchema,validateHarnessPolicySourcePackage} from "@openpond/harness";
import {ExperimentImprovementTestRecipeSchema,ExperimentImprovementStateSchema} from "./experiment-improvement-contracts.js";
const Id=z.string().min(1).max(240),Hash=z.string().regex(/^[a-f0-9]{64}$/),Commit=z.string().regex(/^[a-f0-9]{40}$/);
/** This export attests native owner execution. It never asserts a hosted run,
 * grants training eligibility, or authorizes automatic candidate adoption. */
export const HostedProfileCandidateExportSchema=z.object({schemaVersion:z.literal("openpond.hostedProfileCandidateExport.v1"),
  actorId:Id,teamId:Id,candidateId:Id,candidateRevision:z.number().int().positive(),projectId:Id.nullable(),
  profileRef:z.object({source:z.literal("openpond_git"),repositoryId:Id,profileId:Id}).strict(),expectedCommit:Commit,
  component:ExperimentImprovementStateSchema.shape.component,baseRelease:ImmutableReleaseRefSchema,
  frozenHash:Hash,executableSourceHash:Hash,protectedClosureHash:Hash,
  compiler:z.object({workspaceId:Id,name:z.string().max(500),repositoryId:Id}).strict(),
  sourceManifest:z.object({base64:z.string().max(2_800_000),contentHash:Hash,sizeBytes:z.number().int().positive().max(2_000_000)}).strict(),
  policySource:HarnessPolicySourcePackageSchema,
  qualification:z.object({kind:z.enum(["owner_attested_local","hosted_execution"]),ownerActorId:Id,teamId:Id,originalEvidence:ImmutableReleaseRefSchema,
    baseline:ImmutableReleaseRefSchema,candidate:ImmutableReleaseRefSchema,comparisonHash:Hash,recipe:ExperimentImprovementTestRecipeSchema}).strict(),
  createdAt:z.string().datetime(),contentHash:Hash}).strict();
export type HostedProfileCandidateExport=z.infer<typeof HostedProfileCandidateExportSchema>;
export function verifyHostedProfileCandidateExport(raw:unknown){const value=HostedProfileCandidateExportSchema.parse(raw),{contentHash:hash,...body}=value;
  if(contentHash(body)!==hash||value.qualification.ownerActorId!==value.actorId||value.qualification.teamId!==value.teamId||value.qualification.recipe.externalDatasetBinding.profileId!==value.profileRef.profileId||value.qualification.recipe.externalDatasetBinding.protectedProfileClosureHash!==value.protectedClosureHash)throw new Error("Hosted candidate owner attestation identity differs.");
  validateHarnessPolicySourcePackage(value.policySource);return value;
}
export const HostedProfileCandidateReceiptSchema=z.object({schemaVersion:z.literal("openpond.hostedProfileCandidateAdoption.v1"),id:Id,operationId:Id,actorId:Id,teamId:Id,
  candidateId:Id,exportHash:Hash,executionOrigin:z.enum(["owner_attested_local","hosted_execution"]),qualification:HostedProfileCandidateExportSchema.shape.qualification,
  testedCandidateRelease:ImmutableReleaseRefSchema,activeRelease:ImmutableReleaseRefSchema,expectedCommit:Commit,committedProfileGit:Commit,
  executableSourceHash:Hash,protectedClosureHash:Hash,createdAt:z.string().datetime(),contentHash:Hash}).strict();
export type HostedProfileCandidateReceipt=z.infer<typeof HostedProfileCandidateReceiptSchema>;
export function verifyHostedProfileCandidateReceipt(raw:unknown){const value=HostedProfileCandidateReceiptSchema.parse(raw),{contentHash:hash,...body}=value;if(contentHash(body)!==hash||value.executionOrigin!==value.qualification.kind||value.qualification.ownerActorId!==value.actorId||value.qualification.teamId!==value.teamId)throw new Error("Hosted candidate receipt integrity differs.");return value;}
export const HostedProfileCandidateCommandSchema=z.discriminatedUnion("operation",[
 z.object({operation:z.literal("adopt"),operationId:Id,export:HostedProfileCandidateExportSchema}).strict(),
 z.object({operation:z.enum(["read","rollback"]),operationId:Id,adoptionOperationId:Id,profileRepositoryId:Id}).strict(),
]);
