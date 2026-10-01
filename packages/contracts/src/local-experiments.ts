import { z } from "zod";
import {contentHash} from "@openpond/harness";
import { SaveExperimentSchema,RunExperimentSchema, ExperimentDefinitionRefSchema, ExperimentGraderPinSchema, ExperimentGraderSelectionSchema, ExperimentAttemptGradeSchema } from "openpond-sdk/experiments";
import { TasksetPackageSchema } from "openpond-sdk/taskset-packages";
import { NativeHarnessExperimentEvidenceSchema, ExperimentManifestSchema, ExperimentResultSchema, verifyExperimentEvidence } from "@openpond/evals/experiments";
import { ProfileEvaluationRunSourceSchema } from "@openpond/evals";
import { OpenPondProfileRefSchema } from "./profile-ref.js";

const Id = z.string().trim().min(1).max(200);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const LocalExperimentStatusSchema=z.enum(["queued","running","cancelling","completed","failed","cancelled","interrupted"]);

export const ExperimentModelConfigurationSchema = z.object({
  providerId: z.literal("openpond"), modelId: z.string().trim().min(1).max(500), configurationHash: Hash,
  maxOutputTokens: z.number().int().positive().max(262_144),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().positive().max(1).optional(),
  messages: z.array(z.object({role:z.enum(["system","user","assistant"]),content:z.string().max(262_144)}).strict()).max(200),
}).strict();

export const LocalExperimentSaveSchema = z.object({
  configuration: SaveExperimentSchema,
  package: TasksetPackageSchema,
}).strict();
export const LocalExperimentSaveFromReleaseSchema = z.object({
  configuration: SaveExperimentSchema,
  expectedPackageHash: Hash.optional(),
}).strict();
export const LocalExperimentDefinitionSchema = z.object({
  schemaVersion: z.literal("openpond.localExperimentDefinition.v1"),
  location: z.literal("local"), id: Id, teamId: Id, ownerActorId: Id, revision: z.number().int().positive(),
  configuration: SaveExperimentSchema,
  model: ExperimentModelConfigurationSchema,
  packageHash: Hash,
  graders: z.array(ExperimentGraderPinSchema).min(1).max(100),
  availableGraders:z.array(ExperimentGraderPinSchema).min(1).max(1000),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), contentHash: Hash,
}).strict();
export type LocalExperimentDefinition = z.infer<typeof LocalExperimentDefinitionSchema>;
export const LocalExperimentStartSchema = z.object({ operationId: Id, definition: ExperimentDefinitionRefSchema }).strict();
export const LocalExperimentReadSchema = z.object({ teamId: Id, id: Id }).strict();
export const LocalExperimentListSchema = z.object({
  teamId: Id, projectId: Id.optional(), status:LocalExperimentStatusSchema.optional(), datasetHash:Hash.optional(), search:z.string().max(100).optional(), afterId: Id.optional(), limit: z.number().int().min(1).max(100).default(30),
}).strict();
export type LocalCaseStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "unknown";
const LocalExperimentExecutionFieldsSchema = z.object({
  schemaVersion: z.literal("openpond.localExperimentExecution.v1"), location: z.literal("local"),
  id: Id, teamId: Id, ownerActorId: Id, operationId: Id, definition: ExperimentDefinitionRefSchema,
  kind: z.enum(["target", "scoring"]),
  executionHash: Hash,
  sourceExecution: z.object({id:Id,executionHash:Hash}).strict().nullable(),
  packageHash: Hash, maximumCostUsd: z.number().finite().positive(),
  status: LocalExperimentStatusSchema,
  createdAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
  counts: z.object({pending:z.number().int().nonnegative(),running:z.number().int().nonnegative(),
    completed:z.number().int().nonnegative(),failed:z.number().int().nonnegative(),cancelled:z.number().int().nonnegative(),unknown:z.number().int().nonnegative()}).strict(),
  usage: z.object({knownCostUsd:z.number().finite().nonnegative(),costUsd:z.number().finite().nonnegative().nullable(),heldUsd:z.number().finite().nonnegative(),
    uncertainRequests:z.number().int().nonnegative()}).strict(),
  cleanupComplete: z.boolean(), error: z.string().max(2000).nullable(),
}).strict();
const LocalExperimentPublicExecutionFieldsSchema=LocalExperimentExecutionFieldsSchema.omit({definition:true});
function validateLocalExecutionState(value:z.infer<typeof LocalExperimentPublicExecutionFieldsSchema>,context:z.RefinementCtx) {
  if((value.kind==="scoring")!==(value.sourceExecution!==null))context.addIssue({code:"custom",message:"Only retained scoring passes name an original execution."});
  if(["completed","failed","cancelled","interrupted"].includes(value.status)&&(!value.completedAt||value.counts.pending||value.counts.running))context.addIssue({code:"custom",message:"Terminal local execution requires complete population accounting."});
  if(["completed","cancelled"].includes(value.status)&&!value.cleanupComplete)context.addIssue({code:"custom",message:"Successful completion or cancellation requires confirmed local transport cleanup."});
  if(value.usage.uncertainRequests>0&&value.usage.costUsd!==null)context.addIssue({code:"custom",message:"Uncertain provider charges cannot claim a measured total."});
}
export const LocalExperimentExecutionSchema=LocalExperimentExecutionFieldsSchema.superRefine(validateLocalExecutionState);
export const LocalExperimentPublicExecutionSchema=LocalExperimentPublicExecutionFieldsSchema.superRefine(validateLocalExecutionState);
export type LocalExperimentExecution = z.infer<typeof LocalExperimentExecutionSchema>;
export type LocalExperimentPublicExecution=z.infer<typeof LocalExperimentPublicExecutionSchema>;
export const LocalExperimentRunSchema = z.object({configuration:RunExperimentSchema,package:TasksetPackageSchema}).strict();
export const LocalExperimentRunFromReleaseSchema = z.object({configuration:RunExperimentSchema,
  expectedPackageHash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export const LocalExperimentConfigurationSnapshotSchema = z.object({
  configuration:RunExperimentSchema,model:ExperimentModelConfigurationSchema,
  packageHash:z.string().regex(/^[a-f0-9]{64}$/),
  graders:z.array(ExperimentGraderPinSchema).min(1).max(100),
  availableGraders:z.array(ExperimentGraderPinSchema).min(1).max(1000),
  retainedConfigurationHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  configurationHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((value,context)=>{
  const {configurationHash,...content}=value;
  if(contentHash(content)!==configurationHash)context.addIssue({code:"custom",message:"Local configuration snapshot bytes changed."});
});
export type LocalExperimentConfigurationSnapshot=z.infer<typeof LocalExperimentConfigurationSnapshotSchema>;
const {definition:internalDefinition,...execution}=LocalExperimentExecutionFieldsSchema.shape;
void internalDefinition;
/** Each public Experiment is one target run with its own immutable snapshot. */
export const LocalExperimentRecordSchema=z.object({...execution,
  kind:z.literal("target"),...LocalExperimentConfigurationSnapshotSchema.shape,
}).strict().superRefine((value,context)=> {
  const snapshot={configuration:value.configuration,model:value.model,packageHash:value.packageHash,graders:value.graders,
    availableGraders:value.availableGraders,...(value.retainedConfigurationHash?{retainedConfigurationHash:value.retainedConfigurationHash}:{}),configurationHash:value.configurationHash};
  validateLocalExecutionState(value,context);
  const checked=LocalExperimentConfigurationSnapshotSchema.safeParse(snapshot);
  if(!checked.success)context.addIssue({code:"custom",message:"Local Experiment configuration changed."});
  if(value.operationId!==value.configuration.operationId||value.teamId!==value.configuration.request.teamId
    ||value.maximumCostUsd!==value.configuration.maximumCostUsd)
    context.addIssue({code:"custom",message:"Local Experiment differs from its sealed admission."});
});
export type LocalExperimentRecord=z.infer<typeof LocalExperimentRecordSchema>;
export const LocalExperimentRecordPageSchema=z.object({items:z.array(LocalExperimentRecordSchema).max(100),nextCursor:z.string().nullable()}).strict();
export const LocalExperimentRecordReadSchema=z.object({teamId:z.string().min(1).max(200),id:z.string().min(1).max(200),
  configurationHash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();

export const LocalExperimentScoreSchema = z.object({
  operationId:Id, execution:z.object({id:Id,executionHash:Hash}).strict(),
  graderPackage:TasksetPackageSchema,
  graders:z.array(ExperimentGraderSelectionSchema).min(1).max(100),
  maximumCostUsd:z.number().finite().positive().max(10000),
}).strict();
export const LocalExperimentRetainedScoreSchema = LocalExperimentScoreSchema.omit({ graderPackage:true });

export const LocalExperimentNativeEvidenceSchema = NativeHarnessExperimentEvidenceSchema;
export const LocalExperimentProfileEvidenceSchema=z.object({
  sessionId:Id,turnId:Id,source:ProfileEvaluationRunSourceSchema,profileRef:OpenPondProfileRefSchema,
  admissionHash:Hash,modelConfigurationHash:Hash,traceHash:Hash,runtimeEventRefs:z.array(Id).max(10_000),
  startedAt:z.iso.datetime(),completedAt:z.iso.datetime(),
  outputHash:Hash,partialOutputAvailable:z.boolean(),
}).strict();
export const LocalExperimentCaseResultSchema = z.object({
  receiptId:Id,taskId:Id,seed:z.string(),status:z.enum(["pending","running","completed","failed","cancelled","unknown"]),
  input:z.record(z.string(),z.unknown()),policyVisibleContext:z.record(z.string(),z.unknown()),
  output:z.string().nullable(),messages:z.array(z.unknown()).max(4002),
  grade:ExperimentAttemptGradeSchema.nullable(),error:z.string().nullable(),
  native:LocalExperimentNativeEvidenceSchema.optional(),
  profileNative:LocalExperimentProfileEvidenceSchema.optional(),
}).strict();
export const LocalExperimentResultSchema = z.object({
  execution:z.union([LocalExperimentRecordSchema,LocalExperimentPublicExecutionSchema]),cases:z.array(LocalExperimentCaseResultSchema).max(10_000),contentHash:Hash,
}).strict();
export type LocalExperimentResult = z.infer<typeof LocalExperimentResultSchema>;
export const LocalExperimentTracePageSchema = z.object({
  items:z.array(z.object({sequence:z.number().int().positive(),type:z.string().min(1),payload:z.unknown()}).strict()).max(500),
  nextCursor:z.number().int().positive().nullable(),
}).strict();
export const LocalExperimentCaseInspectionSchema = z.object({
  location:z.literal("local"),execution:z.union([LocalExperimentRecordSchema,LocalExperimentPublicExecutionSchema]),case:LocalExperimentCaseResultSchema,
  trace:LocalExperimentTracePageSchema,
}).strict();
export type LocalExperimentCaseInspection = z.infer<typeof LocalExperimentCaseInspectionSchema>;
export const LocalExperimentExecutionPageSchema = z.object({items:z.array(LocalExperimentPublicExecutionSchema).max(100),nextCursor:Id.nullable()}).strict();
export const LocalExperimentScoringPassSchema=z.object({execution:LocalExperimentPublicExecutionSchema,graders:z.array(ExperimentGraderPinSchema).min(1).max(100),graderPackageHash:Hash}).strict();
export const LocalExperimentPortableEvidenceSchema=z.object({execution:LocalExperimentPublicExecutionSchema,
  manifest:ExperimentManifestSchema,result:ExperimentResultSchema}).strict().superRefine((value,context)=> {
    try {
      verifyExperimentEvidence(value);
      if(value.manifest.id!==value.execution.id||value.manifest.teamId!==value.execution.teamId
        ||value.manifest.lineage?.execution.id!==(value.execution.sourceExecution?.id??value.execution.id)
        ||value.manifest.lineage.execution.contentHash!==(value.execution.sourceExecution?.executionHash??value.execution.executionHash)
        ||value.manifest.lineage.scoringPassId!==(value.execution.kind==="scoring"?value.execution.id:null)
        ||value.manifest.maximumCostUsd!==value.execution.maximumCostUsd)
        throw new Error("Portable evidence differs from its retained local execution.");
    } catch(error) { context.addIssue({code:"custom",message:error instanceof Error?error.message:"Local portable evidence verification failed."}); }
  });
export const LocalExperimentComparisonSchema=z.object({location:z.literal("local"),
  baseline:LocalExperimentPortableEvidenceSchema,candidate:LocalExperimentPortableEvidenceSchema}).strict();
