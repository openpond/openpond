import { z } from "zod";
import {HumanComparisonSelectionsSchema,HumanComparisonProjectionSchema,verifyHumanComparisonProjection} from "@openpond/evals/human-review";
import { contentHash, ImmutableReleaseRefSchema } from "@openpond/harness";
import { ExperimentManifestSchema, ExperimentResultSchema, verifyExperimentEvidence, compareExperiments } from "@openpond/evals/experiments";
import {ExperimentScoringRequestSchema} from "./experiment-scoring-contracts.js";
import {ProfileExternalDatasetBindingSchema,verifyProfileExternalDatasetBinding} from "@openpond/evals";
export const ExperimentImprovementScoringSchema=z.object({sourcePass:ImmutableReleaseRefSchema,graders:ExperimentScoringRequestSchema.shape.graders,mappings:ExperimentScoringRequestSchema.shape.mappings,maximumCostUsd:z.number().finite().positive().max(10000)}).strict();
export const ExperimentImprovementTestRecipeSchema=z.object({externalDatasetBinding:ProfileExternalDatasetBindingSchema,scoring:ExperimentImprovementScoringSchema.optional(),modelId:z.string().min(1).max(300),maximumCostUsd:z.number().finite().positive().max(10000)}).strict();
export type ExperimentImprovementTestRecipe=z.infer<typeof ExperimentImprovementTestRecipeSchema>;
const OpenPondProfileRefSchema=z.object({source:z.enum(["local","github","openpond_git"]),repositoryId:z.string().trim().min(1),profileId:z.string().trim().min(1)}).strict();
const Id=z.string().min(1).max(240),Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const ExperimentImprovementStateSchema=z.object({schemaVersion:z.literal("openpond.experimentImprovement.v1"),id:Id,operationId:Id,requestHash:Hash,
  actorId:Id,teamId:Id,projectId:Id.nullable(),ownerWorkspaceId:Id,ownerRevision:z.number().int().nonnegative(),ownerSourceRevision:z.string().min(1).max(500),baseRelease:ImmutableReleaseRefSchema,
  profileRef:OpenPondProfileRefSchema,baseProfileSourceRevision:z.string().min(1).max(500),
  evidence:z.object({manifest:ExperimentManifestSchema,result:ExperimentResultSchema}).strict(),
  component:z.object({kind:z.enum(["skill","workflow","agent","instruction"]),path:z.string().min(1).max(2000),workflowId:Id.optional()}).strict(),
  mode:z.enum(["manual","llm_assisted"]),status:z.enum(["draft","authoring_queued","authoring","frozen","testing","ready_for_review","adopting","accepted","rolled_back","declined","failed","cancelled"]),revision:z.number().int().positive(),
  limits:z.object({maximumCostUsd:z.number().finite().positive(),maximumAuthoringSteps:z.number().int().min(1).max(500),maximumDurationMs:z.number().int().min(1000).max(86400000)}).strict(),
  authoringSteps:z.number().int().nonnegative().max(500),
  work:z.object({sessionId:Id,turnId:Id,revision:z.number().int().positive(),startedAt:z.string().datetime()}).strict().nullable(),
  frozen:z.object({release:ImmutableReleaseRefSchema,sourceRevision:z.string().min(1).max(500),profileSourceRevision:z.string().min(1).max(500),authoringHash:Hash,partitionHash:Hash,executableSourceHash:Hash,protectedClosureHash:Hash,
    candidateRevision:z.number().int().positive(),diff:z.array(z.object({path:z.string(),before:Hash.nullable(),after:Hash.nullable()}).strict()).max(10000)}).strict().nullable(),
  test:z.object({recipe:ExperimentImprovementTestRecipeSchema,recipeHash:z.string().regex(/^[a-f0-9]{64}$/),baselineOperationId:z.string(),candidateOperationId:z.string(),cancelRequestedAt:z.string().datetime().nullable(),dispatching:z.object({kind:z.enum(["baseline","candidate"]),token:Id,pid:z.number().int().positive(),processStart:z.string().nullable(),startedAt:z.string().datetime()}).strict().nullable()}).strict().nullable(),
  comparison:z.object({baseline:z.object({manifest:ExperimentManifestSchema,result:ExperimentResultSchema}).strict(),candidate:z.object({manifest:ExperimentManifestSchema,result:ExperimentResultSchema}).strict(),frozenHash:Hash,humanProjection:HumanComparisonProjectionSchema.optional()}).strict().nullable(),
  adoptionIntent:z.object({operationId:Id,expectedOwnerRevision:z.number().int().nonnegative(),frozenHash:Hash,humanProjection:HumanComparisonProjectionSchema.optional()}).strict().nullable(),
  acceptance:ImmutableReleaseRefSchema.nullable(),rollback:ImmutableReleaseRefSchema.nullable(),error:z.string().max(2000).nullable(),createdAt:z.string().datetime(),updatedAt:z.string().datetime(),contentHash:Hash}).strict();
export type ExperimentImprovementState=z.infer<typeof ExperimentImprovementStateSchema>;
export function verifyExperimentImprovementState(raw:unknown) {
  const value=ExperimentImprovementStateSchema.parse(raw),{contentHash:hash,...body}=value;
  if(contentHash(body)!==hash)throw new Error("Improvement state integrity failed.");
  verifyExperimentEvidence(value.evidence);
  if(value.evidence.manifest.teamId!==value.teamId || value.evidence.result.status!=="completed" || !value.evidence.result.cases.some(row=>row.status==="completed"))throw new Error("Improvement requires usable completed owner evidence.");
  if(value.test&&(contentHash(value.test.recipe)!==value.test.recipeHash||verifyProfileExternalDatasetBinding(value.test.recipe.externalDatasetBinding).profileId!==value.profileRef.profileId))throw new Error("The test recipe changed its exact selected Profile.");
  if(value.comparison?.humanProjection){const projection=verifyHumanComparisonProjection(value.comparison.humanProjection);if(projection.teamId!==value.teamId||projection.projectId!==value.projectId||contentHash(projection.baseline)!==contentHash(value.comparison.baseline)||contentHash(projection.candidate)!==contentHash(value.comparison.candidate))throw new Error("Human comparison projection differs from its exact owner evidence.");}
  if(value.comparison){verifyExperimentEvidence(value.comparison.baseline);verifyExperimentEvidence(value.comparison.candidate);
    if(!value.frozen||value.comparison.frozenHash!==contentHash(value.frozen)||!compareExperiments(value.comparison.baseline,value.comparison.candidate).comparable)throw new Error("Improvement comparison is not bound to a comparable frozen candidate.");}
  if(value.status==="ready_for_review"&&(!value.frozen||!value.comparison))throw new Error("Improvement is missing qualification.");
  if(value.status==="adopting"&&(!value.adoptionIntent||!value.frozen||value.adoptionIntent.frozenHash!==contentHash(value.frozen)))throw new Error("Improvement adoption intent is not bound to its tested revision.");
  if(value.status==="accepted"&&(!value.acceptance||!value.comparison||!value.frozen))throw new Error("Improvement acceptance is missing its exact qualification receipt.");
  if(value.status==="rolled_back"&&(!value.acceptance||!value.rollback))throw new Error("Profile rollback is missing its durable owner receipt.");
  return value;
}
export function sealExperimentImprovementState(input:Omit<ExperimentImprovementState,"contentHash">){return verifyExperimentImprovementState({...input,contentHash:contentHash(input)});}

export const ExperimentImprovementListSchema=z.object({states:z.array(ExperimentImprovementStateSchema).max(50),nextCursor:Id.nullable()}).strict();
export const StartExperimentImprovementSchema=z.object({operationId:Id,ownerWorkspaceId:Id,expectedOwnerRevision:z.number().int().nonnegative(),baseRelease:ImmutableReleaseRefSchema,
  profileRef:OpenPondProfileRefSchema,profileSourceRevision:z.string().min(1).max(500),projectId:Id.nullable(),evidence:ImmutableReleaseRefSchema,
  component:ExperimentImprovementStateSchema.shape.component,mode:ExperimentImprovementStateSchema.shape.mode,limits:ExperimentImprovementStateSchema.shape.limits}).strict();
export const ExperimentImprovementCommandSchema=z.discriminatedUnion("operation",[
  z.object({operation:z.literal("list"),limit:z.number().int().min(1).max(50).default(30),cursor:Id.optional()}).strict(),
  z.object({operation:z.literal("options"),evidence:ImmutableReleaseRefSchema}).strict(),
  z.object({operation:z.literal("start"),request:StartExperimentImprovementSchema}).strict(),
  z.object({operation:z.enum(["read","humanComparisonOptions"]),id:Id}).strict(),
  z.object({operation:z.literal("instructions"),id:Id}).strict(),
  z.object({operation:z.literal("edit"),id:Id,revision:z.number().int().positive(),expectedFileHash:Hash,text:z.string().max(250000)}).strict(),
  z.object({operation:z.literal("mode"),id:Id,revision:z.number().int().positive(),mode:z.enum(["manual","llm_assisted"])}).strict(),
  z.object({operation:z.literal("author"),id:Id,revision:z.number().int().positive(),modelId:Id,prompt:z.string().min(1).max(20000)}).strict(),
  z.object({operation:z.enum(["freeze","finishAuthoring","useCandidate","discard","cancel","rollback"]),id:Id,revision:z.number().int().positive()}).strict(),
  z.object({operation:z.literal("test"),id:Id,revision:z.number().int().positive(),recipe:ExperimentImprovementTestRecipeSchema}).strict(),
  z.object({operation:z.literal("compare"),id:Id,revision:z.number().int().positive(),baseline:ImmutableReleaseRefSchema,candidate:ImmutableReleaseRefSchema,humanSelections:HumanComparisonSelectionsSchema.optional()}).strict(),
]);
export type ExperimentImprovementCommand=z.input<typeof ExperimentImprovementCommandSchema>;

export const ExperimentImprovementOptionsSchema=z.object({teamId:Id,evidence:ImmutableReleaseRefSchema,scoring:ExperimentImprovementScoringSchema.optional(),profiles:z.array(z.object({id:Hash,name:z.string(),profileRef:OpenPondProfileRefSchema,ownerWorkspaceId:Id,ownerRevision:z.number().int().nonnegative(),baseRelease:ImmutableReleaseRefSchema,profileSourceRevision:z.string(),components:z.array(z.object({kind:z.enum(["skill","instruction","agent","workflow"]),path:z.string(),agentId:z.string().optional(),workflowId:z.string().optional(),label:z.string(),binding:ProfileExternalDatasetBindingSchema}).strict()).max(500)}).strict()).max(100)}).strict();

export const ExperimentImprovementHumanOptionsSchema=z.object({candidateId:Id,actorId:Id,teamId:Id,projectId:Id.nullable(),candidateRevision:z.number().int().positive(),recipeHash:Hash,baseline:z.object({manifest:ExperimentManifestSchema,result:ExperimentResultSchema}).strict(),candidate:z.object({manifest:ExperimentManifestSchema,result:ExperimentResultSchema}).strict(),contentHash:Hash}).strict();
export type ExperimentImprovementHumanOptions=z.infer<typeof ExperimentImprovementHumanOptionsSchema>;
export function verifyExperimentImprovementHumanOptions(raw:unknown){const value=ExperimentImprovementHumanOptionsSchema.parse(raw),{contentHash:hash,...body}=value;if(contentHash(body)!==hash)throw new Error("Accepted Human discovery integrity failed.");for(const lane of [value.baseline,value.candidate]){verifyExperimentEvidence(lane);if(lane.manifest.teamId!==value.teamId||lane.manifest.lineage?.humanProjection)throw new Error("Discovery must retain original owner evidence.");}return value;}
export function sealExperimentImprovementHumanOptions(state:ExperimentImprovementState,pair:{baseline:{manifest:z.infer<typeof ExperimentManifestSchema>;result:z.infer<typeof ExperimentResultSchema>};candidate:{manifest:z.infer<typeof ExperimentManifestSchema>;result:z.infer<typeof ExperimentResultSchema>}}){if(!state.test||state.test.cancelRequestedAt)throw new Error("The paired test is unavailable.");const body={candidateId:state.id,actorId:state.actorId,teamId:state.teamId,projectId:state.projectId,candidateRevision:state.revision,recipeHash:state.test.recipeHash,...pair};return verifyExperimentImprovementHumanOptions({...body,contentHash:contentHash(body)});}
