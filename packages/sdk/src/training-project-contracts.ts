import { ProfileEvaluationRunSourceSchema } from "@openpond/evals";
import { z } from "zod";
import { ImmutableReleaseRefSchema, contentHash } from "@openpond/harness";

const Id = z.string().trim().min(1).max(240);
const Revision = z.number().int().positive();
export const TrainingResourceKindSchema = z.enum(["dataset", "evaluator", "model", "harness", "environment", "experiment", "learning_policy", "deployment"]);
export const TrainingResourceLinkSchema = z.object({
  kind: TrainingResourceKindSchema, resourceId: Id, release: ImmutableReleaseRefSchema.nullable(),
  role: z.enum(["training", "validation", "holdout", "target", "reward", "evaluation", "serving", "source"]),
}).strict();
export const TrainingTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model"), providerId: Id, modelId: Id, artifact: ImmutableReleaseRefSchema.nullable(),
    messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().max(100_000) }).strict()).max(100) }).strict(),
  z.object({ kind: z.literal("harness"), source: ProfileEvaluationRunSourceSchema }).strict(),
  z.object({ kind: z.literal("suite"), suiteId: Id, sources: z.array(ProfileEvaluationRunSourceSchema).min(1).max(1_000) }).strict(),
]);
export const TrainingProjectContentSchema = z.object({
  name: z.string().trim().min(1).max(200), description: z.string().max(10_000),
  targets: z.array(z.object({ id: Id, name: z.string().trim().min(1).max(200), target: TrainingTargetSchema }).strict()).max(100),
  defaultTargetId: Id.nullable(), resources: z.array(TrainingResourceLinkSchema).max(1_000),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.targets.map(t => t.id)).size !== value.targets.length) ctx.addIssue({ code: "custom", path: ["targets"], message: "Target identities must be unique." });
  if (value.defaultTargetId && !value.targets.some(t => t.id === value.defaultTargetId)) ctx.addIssue({ code: "custom", path: ["defaultTargetId"], message: "Default target must belong to this Project." });
  if (new Set(value.resources.map(r => contentHash(r))).size !== value.resources.length) ctx.addIssue({ code: "custom", path: ["resources"], message: "Resource links must be unique." });
});
export const TrainingProjectSchema = z.object({
  schemaVersion: z.literal("openpond.trainingProject.v1"), id: Id, teamId: Id, creatorUserId: Id,
  revision: Revision, content: TrainingProjectContentSchema, archived: z.boolean(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export const TrainingProjectWriteSchema = z.object({
  operationId: Id, id: Id, expectedRevision: z.number().int().nonnegative(), content: TrainingProjectContentSchema,
}).strict();
export const TrainingProjectArchiveSchema = z.object({ operationId: Id, expectedRevision: Revision, archived: z.boolean() }).strict();
export const TrainingProjectListSchema = z.object({ teamId: Id, projects: z.array(TrainingProjectSchema).max(100), nextCursor: Id.nullable() }).strict();
export const TrainingOperationReadinessSchema = z.object({
  operation: z.enum(["evaluate", "train", "enable_learning", "accept_candidate", "serve"]),
  support: z.enum(["supported", "unsupported"]), state: z.enum(["ready", "needs_setup", "blocked"]),
  reasons: z.array(z.object({ code: Id, message: z.string().min(1).max(2_000), field: z.string().nullable(),
    action: z.enum(["choose_target", "choose_data", "choose_evaluator", "configure_runtime", "request_access", "configure_budget", "wait", "review_evidence"]).nullable() }).strict()).max(100),
}).strict().superRefine((value, ctx) => {
  if (value.state === "ready" && (value.support !== "supported" || value.reasons.length)) ctx.addIssue({ code: "custom", message: "Ready operations must be supported with no blockers." });
  if (value.state !== "ready" && !value.reasons.length) ctx.addIssue({ code: "custom", message: "Unavailable operations must explain the next step." });
});
export type TrainingProject = z.infer<typeof TrainingProjectSchema>;
export type TrainingProjectContent = z.infer<typeof TrainingProjectContentSchema>;
export type TrainingProjectWrite = z.infer<typeof TrainingProjectWriteSchema>;
export type TrainingResourceLink = z.infer<typeof TrainingResourceLinkSchema>;
export type TrainingTarget = z.infer<typeof TrainingTargetSchema>;
