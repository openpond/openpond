import {HumanRevokeLocalPublicationSchema,HumanLocalPublicationsReadSchema,HumanNativeAttemptOriginSchema,HumanLocalAttemptOriginSchema,HumanExportLocalRequestSchema,HumanPublishLocalRequestSchema,HumanShareLocalRequestSchema} from "./local-publication.js";
import {HumanTaskProposalSchema,HumanTaskProposalViewSchema} from "./task-proposals.js";
import { z } from "zod";
import { contentHash, ReleaseHashSchema, ReleaseIdSchema, ReleaseTimestampSchema } from "@openpond/harness";

const Id = ReleaseIdSchema;
export const ReviewReleaseSchema = z.object({ id: Id, revision: z.number().int().positive(), contentHash: ReleaseHashSchema }).strict();
export const HumanCriterionSchema = z.discriminatedUnion("kind", [
  z.object({ id: Id, label: z.string().trim().min(1).max(500), instructions: z.string().max(20_000), required: z.boolean(), allowAbstain: z.boolean(), requireRationale: z.boolean().optional(), anchors: z.array(z.object({ value: z.union([z.number(), z.string(), z.boolean()]), description: z.string().min(1).max(2000) }).strict()).max(100).optional(), kind: z.literal("score"), minimum: z.number().finite(), maximum: z.number().finite(), step: z.number().positive().finite() }).strict().refine(c => c.minimum < c.maximum && c.step <= c.maximum - c.minimum, "Use an increasing raw score range and a step within that range."),
  z.object({ id: Id, label: z.string().trim().min(1).max(500), instructions: z.string().max(20_000), required: z.boolean(), allowAbstain: z.boolean(), requireRationale: z.boolean().optional(), anchors: z.array(z.object({ value: z.union([z.number(), z.string(), z.boolean()]), description: z.string().min(1).max(2000) }).strict()).max(100).optional(), kind: z.literal("category"), options: z.array(z.string().trim().min(1).max(500)).min(2).max(100) }).strict().refine(c => new Set(c.options).size === c.options.length, "Category options must be unique."),
  z.object({ id: Id, label: z.string().trim().min(1).max(500), instructions: z.string().max(20_000), required: z.boolean(), allowAbstain: z.boolean(), requireRationale: z.boolean().optional(), anchors: z.array(z.object({ value: z.union([z.number(), z.string(), z.boolean()]), description: z.string().min(1).max(2000) }).strict()).max(100).optional(), kind: z.literal("boolean") }).strict(),
  z.object({ id: Id, label: z.string().trim().min(1).max(500), instructions: z.string().max(20_000), required: z.boolean(), allowAbstain: z.boolean(), requireRationale: z.boolean().optional(), anchors: z.array(z.object({ value: z.union([z.number(), z.string(), z.boolean()]), description: z.string().min(1).max(2000) }).strict()).max(100).optional(), kind: z.literal("text"), minimumLength: z.number().int().nonnegative().max(20_000).optional(), maximumLength: z.number().int().positive().max(20_000) }).strict(),
  z.object({ id: Id, label: z.string().trim().min(1).max(500), instructions: z.string().max(20_000), required: z.boolean(), allowAbstain: z.boolean(), requireRationale: z.boolean().optional(), anchors: z.array(z.object({ value: z.union([z.number(), z.string(), z.boolean()]), description: z.string().min(1).max(2000) }).strict()).max(100).optional(), kind: z.literal("preference"), requireStrength: z.boolean().optional(), allowTie: z.boolean() }).strict(),
]);
export const HumanFormSchema = z.object({ schemaVersion: z.literal("openpond.humanForm.v1"), mode: z.enum(["individual", "pairwise"]), instructions: z.string().max(20_000), criteria: z.array(HumanCriterionSchema).min(1).max(100) }).strict().superRefine((form, ctx) => {
  form.criteria.forEach((criterion,index)=>{
    if(criterion.kind==="text"&&(criterion.minimumLength??0)>criterion.maximumLength)ctx.addIssue({code:"custom",path:["criteria",index,"minimumLength"],message:"Minimum text length must not exceed maximum length."});
    const seen=new Set<string>();
    criterion.anchors?.forEach((anchor,anchorIndex)=>{const value=anchor.value;const valid=criterion.kind==="score"?typeof value==="number"&&Number.isFinite(value)&&value>=criterion.minimum&&value<=criterion.maximum&&Math.abs((value-criterion.minimum)/criterion.step-Math.round((value-criterion.minimum)/criterion.step))<1e-8:criterion.kind==="category"?typeof value==="string"&&criterion.options.includes(value):criterion.kind==="boolean"?typeof value==="boolean":criterion.kind==="preference"?["A","B",...(criterion.allowTie?["tie"]:[])].includes(String(value)):typeof value==="string";const key=JSON.stringify(value);if(!valid||seen.has(key))ctx.addIssue({code:"custom",path:["criteria",index,"anchors",anchorIndex,"value"],message:"Each anchor must describe a unique valid raw value."});seen.add(key);});
  });
  if (new Set(form.criteria.map(c => c.id)).size !== form.criteria.length) ctx.addIssue({ code: "custom", path: ["criteria"], message: "Criterion IDs must be unique." });
  if (form.mode === "individual" && form.criteria.some(c => c.kind === "preference")) ctx.addIssue({ code: "custom", path: ["criteria"], message: "Preferences require an explicit pair." });
});
export type HumanForm = z.infer<typeof HumanFormSchema>;
export const HumanAttemptRefSchema = z.object({ localSource:z.union([HumanLocalAttemptOriginSchema,HumanNativeAttemptOriginSchema]).optional(), recordedSource:z.object({id:Id,snapshotHash:ReleaseHashSchema,boundaryId:Id,boundaryRevisionHash:ReleaseHashSchema}).strict().optional(), experimentId: Id, attemptId: Id, taskId: Id, targetId: Id, output: ReviewReleaseSchema, trace: ReviewReleaseSchema.nullable(), familyKey: Id, split: z.enum(["train", "validation", "test", "frozen_eval"]) }).strict();
export const HumanEvidenceSchema = z.object({ publication:ReviewReleaseSchema.optional(), dataset: ReviewReleaseSchema, grader: ReviewReleaseSchema, graderBinding: z.object({ id: Id, version: z.string().min(1).max(100), contentHash: ReleaseHashSchema }).strict(), rubric: ReviewReleaseSchema, attempts: z.array(HumanAttemptRefSchema).max(2), taskIds: z.array(Id).min(1).max(1000).optional() }).strict().superRefine((e, ctx) => {
  if (!e.attempts.length && !e.taskIds?.length) ctx.addIssue({ code: "custom", message: "Select retained attempts or exact tasks." });
  if (e.taskIds && new Set(e.taskIds).size !== e.taskIds.length) ctx.addIssue({ code: "custom", path: ["taskIds"], message: "Select each task once." });
  if (e.attempts.length === 2 && (e.attempts[0]!.attemptId === e.attempts[1]!.attemptId || e.attempts[0]!.taskId !== e.attempts[1]!.taskId || e.attempts[0]!.familyKey !== e.attempts[1]!.familyKey || e.attempts[0]!.split !== e.attempts[1]!.split)) ctx.addIssue({ code: "custom", path: ["attempts"], message: "A/B review requires distinct attempts of the same task, family and split." });
});
export type HumanEvidence = z.infer<typeof HumanEvidenceSchema>;
export const HumanAnswerSchema = z.object({ criterionId: Id, value: z.union([z.number().finite(), z.boolean(), z.string().max(20_000), z.null()]), abstain: z.boolean(), note: z.string().max(20_000), strength: z.enum(["slight", "moderate", "strong"]).optional() }).strict();
export type HumanAnswer = z.infer<typeof HumanAnswerSchema>;
export const HumanPolicySchema = z.object({ approval: z.enum(["none", "manager"]), minimumRaters: z.number().int().min(1).max(100), managerIds: z.array(Id).max(100), reviewerIds: z.array(Id).max(100), queueClaim: z.boolean(), teamVisible: z.boolean(), distinctManager: z.boolean().optional(), independentRaters: z.boolean().optional(), blindPair: z.boolean().optional() }).strict().superRefine((p,c) => {
  if (p.approval === "none" && p.minimumRaters !== 1) c.addIssue({ code: "custom", path: ["minimumRaters"], message: "Multi-rater review requires explicit adjudication." });
});
const SubmissionSchema = z.object({taskProposal:HumanTaskProposalSchema.optional(), id: Id, revision: z.number().int().positive(), actorId: Id, generation: z.number().int().positive(), evidenceHash: ReleaseHashSchema, formHash: ReleaseHashSchema, answers: z.array(HumanAnswerSchema).max(100), note: z.string().max(20_000), submittedAt: ReleaseTimestampSchema, supersedes: Id.nullable(), contentHash: ReleaseHashSchema }).strict();
const DecisionSchema = z.object({taskProposalHash:ReleaseHashSchema.optional(), id: Id, revision: z.number().int().positive(), actorId: Id, outcome: z.enum(["accept", "reject", "request_changes"]), submissions: z.array(z.object({ id: Id, contentHash: ReleaseHashSchema }).strict()).min(1).max(100), answers: z.array(HumanAnswerSchema).max(100), note: z.string().max(20_000), decidedAt: ReleaseTimestampSchema, contentHash: ReleaseHashSchema }).strict();
export const HumanReviewSchema = z.object({ schemaVersion: z.literal("openpond.humanReview.v1"), id: Id, revision: z.number().int().positive(), scope: Id, projectId: Id, createdBy: Id, kind: z.enum(["author", "execute", "grade"]),dueAt:ReleaseTimestampSchema.optional(), title: z.string().trim().min(1).max(500), authorPublication:z.object({proposalHash:ReleaseHashSchema,dataset:ReviewReleaseSchema,operationId:Id,publishedBy:Id,publishedAt:ReleaseTimestampSchema}).strict().nullable(), evidence: HumanEvidenceSchema, form: HumanFormSchema, policy: HumanPolicySchema, status: z.enum(["queued", "assigned", "in_progress", "submitted", "returned", "accepted", "rejected", "cancelled"]), assigneeId: Id.nullable(), generation: z.number().int().positive(), drafts: z.array(z.object({taskProposal:HumanTaskProposalSchema.optional(), actorId: Id, generation: z.number().int().positive(), answers: z.array(HumanAnswerSchema).max(100), note: z.string().max(20_000), updatedAt: ReleaseTimestampSchema }).strict()).max(100), submissions: z.array(SubmissionSchema).max(1000), decisions: z.array(DecisionSchema).max(1000), audit: z.array(z.object({ actorId: Id, action: z.enum(["claim", "reassign", "cancel"]), priorAssigneeId: Id.nullable(), assigneeId: Id.nullable(), generation: z.number().int().positive(), note: z.string().max(20_000), occurredAt: ReleaseTimestampSchema }).strict()).max(1000), execution: z.object({ executionId: Id.nullable(), operationId: Id, boundBy: Id, configurationHash: ReleaseHashSchema, generation:z.number().int().positive(), result:ReviewReleaseSchema.nullable() }).strict().nullable(), createdAt: ReleaseTimestampSchema, updatedAt: ReleaseTimestampSchema, contentHash: ReleaseHashSchema }).strict();
export type HumanReview = z.infer<typeof HumanReviewSchema>;
export type HumanSubmission = z.infer<typeof SubmissionSchema>;
export type HumanDecision = z.infer<typeof DecisionSchema>;
const Mutation = { operationId: Id, id: Id, expectedRevision: z.number().int().nonnegative() };
export const HumanReviewCommandSchema = z.discriminatedUnion("action", [
  z.object({ ...Mutation, action: z.literal("create"), projectId: Id, kind: HumanReviewSchema.shape.kind, title: HumanReviewSchema.shape.title, dueAt:ReleaseTimestampSchema.optional(), evidence: HumanEvidenceSchema, form: HumanFormSchema, policy: HumanPolicySchema, assigneeId: Id.nullable() }).strict(),
  z.object({ ...Mutation, action: z.literal("claim") }).strict(),
  z.object({...Mutation,action:z.literal("bind_author_publication"),proposalHash:ReleaseHashSchema,dataset:ReviewReleaseSchema}).strict(),
  z.object({...Mutation,action:z.literal("reserve_execution"),generation:z.number().int().positive(),runOperationId:Id,configurationHash:ReleaseHashSchema}).strict(),
  z.object({...Mutation,action:z.literal("bind_execution"),generation:z.number().int().positive(),executionId:Id,runOperationId:Id,configurationHash:ReleaseHashSchema}).strict(),
  z.object({ ...Mutation, action: z.literal("reassign"), assigneeId: Id.nullable(), note: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ ...Mutation, action: z.literal("cancel"), note: z.string().max(20_000) }).strict(),
  z.object({ ...Mutation, action: z.literal("save_draft"), taskProposal:HumanTaskProposalSchema.optional(), generation: z.number().int().positive(), answers: z.array(HumanAnswerSchema).max(100), note: z.string().max(20_000) }).strict(),
  z.object({ ...Mutation, action: z.literal("submit"), taskProposal:HumanTaskProposalSchema.optional(), generation: z.number().int().positive(), evidenceHash: ReleaseHashSchema, formHash: ReleaseHashSchema, executionResult:ReviewReleaseSchema.optional(), answers: z.array(HumanAnswerSchema).max(100), note: z.string().max(20_000) }).strict(),
  z.object({ ...Mutation, action: z.literal("decide"), taskProposalHash:ReleaseHashSchema.optional(), outcome: DecisionSchema.shape.outcome, submissions: DecisionSchema.shape.submissions, answers: DecisionSchema.shape.answers, note: DecisionSchema.shape.note }).strict(),
]);
export type HumanReviewCommand = z.infer<typeof HumanReviewCommandSchema>;
export const HumanReviewRequestSchema = z.discriminatedUnion("endpoint", [
  z.object({ endpoint: z.literal("command"), scope: Id, command: HumanReviewCommandSchema }).strict(),
  z.object({ endpoint: z.literal("get"), scope: Id, id: Id, revision: z.number().int().positive().optional() }).strict(),
  z.object({ endpoint: z.literal("inbox"), scope: Id, projectId: Id.optional(), view: z.enum(["mine", "team", "approval"]), status: z.enum(["active", "history"]), afterId: Id.optional(), limit: z.number().int().min(1).max(100) }).strict(),
]);
export type HumanReviewRequest = z.infer<typeof HumanReviewRequestSchema>;
export function sealHumanRecord<T extends object>(record: T): T & { contentHash: string } { return { ...record, contentHash: contentHash(record) }; }
export function assertHumanAnswers(form: HumanForm, answers: HumanAnswer[], complete: boolean): void {
  if (new Set(answers.map(a => a.criterionId)).size !== answers.length) throw new Error("human_duplicate_criterion");
  for (const answer of answers) {
    const criterion = form.criteria.find(c => c.id === answer.criterionId);
    if (!criterion) throw new Error("human_unknown_criterion");
    if (complete && criterion.requireRationale && !answer.note.trim()) throw new Error("human_rationale_required");
    if (complete && criterion.kind === "preference" && criterion.requireStrength && !answer.strength && !answer.abstain) throw new Error("human_preference_strength_required");
    if (answer.abstain) { if (!criterion.allowAbstain || answer.value !== null || !answer.note.trim()) throw new Error("human_abstention_invalid"); continue; }
    const v = answer.value;
    if (!complete && v === null) continue;
    const valid = criterion.kind === "score" ? typeof v === "number" && v >= criterion.minimum && v <= criterion.maximum && Math.abs((v - criterion.minimum) / criterion.step - Math.round((v - criterion.minimum) / criterion.step)) < 1e-8
      : criterion.kind === "category" ? typeof v === "string" && criterion.options.includes(v)
      : criterion.kind === "boolean" ? typeof v === "boolean"
      : criterion.kind === "preference" ? ["A", "B", ...(criterion.allowTie ? ["tie"] : [])].includes(String(v))
      : typeof v === "string" && v.length >= (criterion.minimumLength ?? 0) && v.length <= criterion.maximumLength && (!criterion.required || Boolean(v.trim()));
    if (!valid) throw new Error("human_answer_invalid");
  }
  if (complete && form.criteria.some(c => c.required && !answers.some(a => a.criterionId === c.id))) throw new Error("human_required_answer_missing");
}

export const HumanReviewViewSchema = HumanReviewSchema.omit({ evidence: true,drafts:true,submissions:true }).extend({drafts:z.array(HumanReviewSchema.shape.drafts.element.omit({taskProposal:true}).extend({taskProposal:HumanTaskProposalViewSchema.optional()})).max(100),submissions:z.array(SubmissionSchema.omit({taskProposal:true}).extend({taskProposal:HumanTaskProposalViewSchema.optional()})).max(1000), evidence: HumanEvidenceSchema.nullable(), evidenceHash: ReleaseHashSchema, formHash: ReleaseHashSchema, permissions: z.object({ owner: z.boolean(), manager: z.boolean(), reviewer: z.boolean(), claim: z.boolean() }).strict() }).strict();
export type HumanReviewView = z.infer<typeof HumanReviewViewSchema>;
export const HumanInboxSchema = z.object({ items: z.array(HumanReviewViewSchema).max(100), nextCursor: Id.nullable(), actionCount: z.number().int().nonnegative(), approvalAvailable: z.boolean() }).strict();
export const HumanSnapshotRequestSchema = z.object({ endpoint:z.literal("snapshot"),scope:Id,projectId:Id,graderId:Id,selections:z.array(z.object({executionId:Id,receiptId:Id}).strict()).min(1).max(2) }).strict();
export const HumanTasksSnapshotRequestSchema = z.object({endpoint:z.literal("snapshot_tasks"),scope:Id,projectId:Id,graderId:Id,dataset:ReviewReleaseSchema,taskIds:z.array(Id).min(1).max(1000).optional(),all:z.literal(true).optional()}).strict().refine(value=>Boolean(value.all)!==Boolean(value.taskIds),"Choose an exact selected task list or the server-frozen full Dataset.");
export const HumanInspectRequestSchema = z.object({endpoint:z.literal("inspect"),scope:Id,id:Id,slot:z.number().int().min(0).max(1).optional(),afterId:z.string().min(1).max(500).optional()}).strict();
export const HumanResultsReadRequestSchema=z.object({endpoint:z.literal("results"),scope:Id,executionId:Id,selection:z.array(ReviewReleaseSchema).max(10000).optional()}).strict();
export const HumanMembersRequestSchema=z.object({endpoint:z.literal("members"),scope:Id}).strict();
export const HumanExecuteRequestSchema=z.object({endpoint:z.literal("execute"),scope:Id,id:Id,expectedRevision:z.number().int().positive(),generation:z.number().int().positive(),operationId:Id,configuration:z.unknown()}).strict();
export const HumanExecutionReadRequestSchema=z.object({endpoint:z.literal("execution"),scope:Id,id:Id,action:z.enum(["status","result","cancel"])}).strict();
export const HumanPublishEvidenceRequestSchema=HumanSnapshotRequestSchema.omit({endpoint:true}).extend({endpoint:z.literal("publish_evidence"),operationId:Id,audience:z.array(Id).max(100),workspaceVisible:z.boolean()}).strict();
export const HumanPublicationAccessRequestSchema=z.object({endpoint:z.literal("publication_access"),scope:Id,projectId:Id}).strict();
export const HumanRevokePublicationRequestSchema=z.object({endpoint:z.literal("revoke_publication"),scope:Id,publication:ReviewReleaseSchema}).strict();
export const HumanPublishAuthorRequestSchema=z.object({endpoint:z.literal("publish_author"),scope:Id,id:Id,expectedRevision:z.number().int().positive(),operationId:Id,proposalHash:ReleaseHashSchema,workspaceId:Id.optional(),expectedWorkspaceRevision:z.number().int().positive().optional()}).strict();
export const HumanAuthorTasksRequestSchema=z.object({endpoint:z.literal("author_tasks"),scope:Id,id:Id,includeReference:z.literal(true).optional()}).strict();
export const HumanGraderChoicesRequestSchema=z.object({endpoint:z.literal("graders"),scope:Id,projectId:Id,dataset:ReviewReleaseSchema}).strict();
export const HumanGraderChoicesSchema=z.array(z.object({id:Id,name:z.string(),version:z.string(),contentHash:ReleaseHashSchema,mode:z.enum(["individual","pairwise"])}).strict()).max(1000);
export const HumanReviewTransportSchema = z.union([HumanRevokeLocalPublicationSchema,HumanLocalPublicationsReadSchema,HumanExportLocalRequestSchema,HumanPublishLocalRequestSchema,HumanShareLocalRequestSchema,HumanPublicationAccessRequestSchema,HumanPublishAuthorRequestSchema,HumanAuthorTasksRequestSchema,HumanGraderChoicesRequestSchema,HumanPublishEvidenceRequestSchema,HumanRevokePublicationRequestSchema,HumanExecuteRequestSchema,HumanExecutionReadRequestSchema,HumanReviewRequestSchema,HumanSnapshotRequestSchema,HumanTasksSnapshotRequestSchema,HumanInspectRequestSchema,HumanResultsReadRequestSchema,HumanMembersRequestSchema]);
export type HumanReviewTransportRequest=z.infer<typeof HumanReviewTransportSchema>;

export const HumanInspectionSchema = z.array(z.object({ origin:z.literal("owner_attested_local").optional(),coverage:z.object({sourceEventCount:z.number().int().nonnegative(),publishedEventCount:z.number().int().nonnegative(),traceLimited:z.boolean(),artifactsIncluded:z.literal(false)}).strict().optional(),reviewId:Id,reviewRevision:z.number().int().positive(),evidenceHash:ReleaseHashSchema, slot:z.string(), input:z.unknown(), output:z.unknown(), error:z.string().nullable(), events:z.array(z.record(z.string(),z.unknown())), eventCount:z.number().int().nonnegative(), evidenceLimited:z.boolean(), nextEventCursor:z.string().nullable(), slotIndex:z.number().int().nonnegative(), executionId:Id.optional(), receiptId:Id.optional() }).strict()).max(1000);
export type HumanInspection=z.infer<typeof HumanInspectionSchema>;
