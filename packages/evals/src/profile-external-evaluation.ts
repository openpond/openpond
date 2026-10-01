import { z } from "zod";
import { ImmutableReleaseRefSchema,ReleaseHashSchema,ReleaseIdSchema,contentHash } from "@openpond/harness";
import { ProfileEvaluationTargetSchema } from "./profile-evaluation-target.js";
import { TaskSplitSchema } from "./tasksets.js";
const PopulationMemberSchema=z.object({taskId:ReleaseIdSchema,seed:z.string().min(1).max(500),fixtureId:ReleaseIdSchema.nullable()}).strict();
const Segment=z.string().min(1).max(200).refine(value=>!["__proto__","prototype","constructor"].includes(value),"Use an ordinary field name.");
const Slot=z.enum(["input","output","expectedOutput","evaluatorContext"]);
export const ProfileExternalFieldMappingsSchema=z.array(z.object({graderId:ReleaseIdSchema,fields:z.array(z.object({destination:Slot,path:z.array(Segment).min(1).max(20),source:Slot,sourcePath:z.array(Segment).max(20)}).strict()).max(100)}).strict()).max(100);
const RecordedOriginSchema=z.object({execution:ImmutableReleaseRefSchema,originalEvidence:ImmutableReleaseRefSchema,members:z.array(z.object({caseId:ReleaseIdSchema,seed:z.string().min(1).max(500),fixtureId:ReleaseHashSchema,
  sourceId:ReleaseIdSchema,snapshotHash:ReleaseHashSchema,boundaryRevisionHash:ReleaseHashSchema}).strict()).min(1).max(500)}).strict();
const MeasurementSchema=z.object({release:ImmutableReleaseRefSchema.extend({revision:z.union([z.number().int().positive(),z.string().min(1).max(200)])}).strict(),feedbackKey:z.string().min(1).max(240),
  configurationHash:ReleaseHashSchema,output:z.enum(["boolean","score","category"]),categories:z.array(z.string().min(1).max(120)).max(50)}).strict();
export const ProfileExternalDatasetBindingContentSchema=z.object({schemaVersion:z.literal("openpond.profileExternalDatasetBinding.v1"),dataset:ImmutableReleaseRefSchema.extend({revision:z.number().int().positive()}).strict(),
  packageHash:ReleaseHashSchema,profileId:ReleaseIdSchema,target:ProfileEvaluationTargetSchema,declaredProfileCatalogHash:ReleaseHashSchema.nullable(),protectedProfileClosureHash:ReleaseHashSchema,
  recordedOrigin:RecordedOriginSchema.optional(),gradingSource:z.object({pass:ImmutableReleaseRefSchema,evidence:ImmutableReleaseRefSchema}).strict().optional(),split:TaskSplitSchema,population:z.array(PopulationMemberSchema).min(1).max(10000),evaluators:z.array(MeasurementSchema).min(1).max(100),fieldMappingsHash:ReleaseHashSchema,fieldMappings:ProfileExternalFieldMappingsSchema,
  environmentHash:ReleaseHashSchema,privateDatasetClosureHash:ReleaseHashSchema,criterion:z.object({minimumPassRate:z.number().min(0).max(1),requireComplete:z.boolean()}).strict()}).strict().superRefine((value,ctx)=>{
    if(value.recordedOrigin&&(value.recordedOrigin.members.length!==value.population.length||value.recordedOrigin.members.some((source,index)=>source.caseId!==value.population[index]!.taskId||source.seed!==value.population[index]!.seed||source.fixtureId!==source.snapshotHash||value.population[index]!.fixtureId!==null)))ctx.addIssue({code:"custom",message:"Recorded-to-rerun mapping must preserve every exact ordered cutoff and seed while admitting new target attempts."});
    if(contentHash(value.fieldMappings)!==value.fieldMappingsHash)ctx.addIssue({code:"custom",message:"Field mappings differ from their sealed hash."});
    if(new Set(value.fieldMappings.map(row=>row.graderId)).size!==value.fieldMappings.length)ctx.addIssue({code:"custom",message:"Field mappings must name each grader once."});
    if(new Set(value.population.map(row=>JSON.stringify([row.taskId,row.seed,row.fixtureId]))).size!==value.population.length)ctx.addIssue({code:"custom",message:"External Dataset population must be unique."});
    if(new Set(value.evaluators.map(row=>row.feedbackKey)).size!==value.evaluators.length)ctx.addIssue({code:"custom",message:"External Dataset feedback keys must be unique."});
    for(const grader of value.evaluators)if((grader.output==="category")!==(grader.categories.length>0))ctx.addIssue({code:"custom",message:"Only category grading declares categories."});
  });
export const ProfileExternalDatasetBindingSchema=ProfileExternalDatasetBindingContentSchema.safeExtend({contentHash:ReleaseHashSchema}).strict();
export type ProfileExternalDatasetBinding=z.infer<typeof ProfileExternalDatasetBindingSchema>;
export function verifyProfileExternalDatasetBinding(raw:unknown){const value=ProfileExternalDatasetBindingSchema.parse(raw),{contentHash:hash,...body}=value;if(contentHash(body)!==hash)throw new Error("External Dataset binding integrity failed.");return value;}
export function createProfileExternalDatasetBinding(raw:z.input<typeof ProfileExternalDatasetBindingContentSchema>){const value=ProfileExternalDatasetBindingContentSchema.parse(raw);return verifyProfileExternalDatasetBinding({...value,contentHash:contentHash(value)});}
export const externalDatasetDefinitionId=(binding:ProfileExternalDatasetBinding)=>`external-dataset-${verifyProfileExternalDatasetBinding(binding).contentHash.slice(0,40)}`;
