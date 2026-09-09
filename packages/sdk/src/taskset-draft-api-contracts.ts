import { z } from "zod";
import { LearningRevisionRefSchema } from "@openpond/evals/learning";
import { TasksetDraftSchema, TasksetDraftStatusSchema } from "./taskset-draft-document.js";
import { TasksetDraftFileSchema, TasksetDraftFileInfoSchema } from "./model-taskset-authoring-contracts.js";

const IdSchema = TasksetDraftSchema.shape.id;
const RevisionSchema = z.number().int().positive();
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const scope = { teamId: IdSchema, modelId: IdSchema };

export const TasksetDraftCreateRequestSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetDraftCreate.v1"),
  operationId: IdSchema, modelId: IdSchema, expectedModelRevision: RevisionSchema,
  name: TasksetDraftSchema.shape.name,
}).strict();
export type TasksetDraftCreateRequest = z.infer<typeof TasksetDraftCreateRequestSchema>;

export const TasksetDraftSourceDescriptorSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetDraftSourceDescriptor.v1"), ...scope,
  expectedModelRevision: RevisionSchema, sourcePackageHash: HashSchema,
}).strict();
export const TasksetDraftReadbackSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetDraftReadback.v1"), ...scope,
  draft: TasksetDraftSchema, workspaceHash: HashSchema, projectEtag: HashSchema,
}).strict().refine(value => value.draft.profileId === value.teamId && value.draft.modelScope?.modelId === value.modelId,
  "The hosted draft must belong to its declared workspace and Model.");
export const TasksetDraftSummarySchema = z.object({
  id: IdSchema, revision: RevisionSchema, name: TasksetDraftSchema.shape.name,
  status: TasksetDraftStatusSchema, updatedAt: TasksetDraftSchema.shape.updatedAt,
  sourceTasksetRef: LearningRevisionRefSchema.nullable(),
}).strict();
export const TasksetDraftListSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetDraftList.v1"), ...scope,
  drafts: z.array(TasksetDraftSummarySchema).max(100), nextCursor: z.string().min(1).max(2_000).nullable(),
}).strict();
export const TasksetDraftSaveRequestSchema = z.object({ expectedDraftRevision: RevisionSchema, draft: TasksetDraftSchema }).strict();
export const TasksetDraftRefreshRequestSchema = z.object({ expectedDraftRevision: RevisionSchema, expectedModelRevision: RevisionSchema }).strict();
export const TasksetDraftValidationRequestSchema = z.object({ expectedDraftRevision: RevisionSchema, expectedWorkspaceHash: HashSchema }).strict();
export const TasksetDraftValidationSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetDraftValidation.v1"), ...scope,
  draftId: IdSchema, draftRevision: RevisionSchema, workspaceHash: HashSchema,
  valid: z.boolean(), issues: z.array(z.object({ code: z.string().min(1), severity: z.enum(["warning", "error"]), message: z.string(), path: z.string().nullable() }).strict()),
  packageHash: HashSchema.nullable(), tasksetRef: LearningRevisionRefSchema.nullable(),
}).strict().refine(value => value.valid
  ? value.packageHash !== null && value.tasksetRef !== null && value.issues.every(issue => issue.severity !== "error")
  : value.packageHash === null && value.tasksetRef === null && value.issues.some(issue => issue.severity === "error"), "Validation must retain either a compiled package or publication errors.");
export const TasksetDraftPublicationRequestSchema = TasksetDraftValidationRequestSchema.extend({
  operationId: IdSchema, expectedPackageHash: HashSchema, expectedTasksetRef: LearningRevisionRefSchema,
}).strict();
export const TasksetDraftFileListSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetDraftFileList.v1"), ...scope,
  draftId: IdSchema, draftRevision: RevisionSchema, files: z.array(TasksetDraftFileInfoSchema).max(10_020),
}).strict();
export const TasksetDraftFileReadbackSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetDraftFileReadback.v1"), ...scope,
  draftId: IdSchema, draftRevision: RevisionSchema, file: TasksetDraftFileSchema,
}).strict();
export const TasksetDraftDeletionSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetDraftDeletion.v1"), ...scope,
  draftId: IdSchema, revision: RevisionSchema, deleted: z.literal(true),
}).strict();

export type TasksetDraftSourceDescriptor = z.infer<typeof TasksetDraftSourceDescriptorSchema>;
export type TasksetDraftReadback = z.infer<typeof TasksetDraftReadbackSchema>;
export type TasksetDraftList = z.infer<typeof TasksetDraftListSchema>;
export type TasksetDraftSaveRequest = z.infer<typeof TasksetDraftSaveRequestSchema>;
export type TasksetDraftRefreshRequest = z.infer<typeof TasksetDraftRefreshRequestSchema>;
export type TasksetDraftValidationRequest = z.infer<typeof TasksetDraftValidationRequestSchema>;
export type TasksetDraftValidation = z.infer<typeof TasksetDraftValidationSchema>;
export type TasksetDraftPublicationRequest = z.infer<typeof TasksetDraftPublicationRequestSchema>;
export type TasksetDraftFileList = z.infer<typeof TasksetDraftFileListSchema>;
export type TasksetDraftFileReadback = z.infer<typeof TasksetDraftFileReadbackSchema>;
export type TasksetDraftDeletion = z.infer<typeof TasksetDraftDeletionSchema>;
