import { z } from "zod";
import { ReleaseIdSchema, ReleaseHashSchema, ReleaseTimestampSchema, ImmutableReleaseRefSchema } from "@openpond/harness";
import { LearningRevisionRefSchema } from "./contracts.js";

/** Reviewed behavior identity and verifier membership are frozen before either
 * declared evaluation starts. A failed unrelated grader is never a repeat. */
export const CorrectionVerificationCheckSchema = z.object({
  id: ReleaseIdSchema,
  role: z.enum(["replay", "transfer"]),
  taskId: ReleaseIdSchema,
  seeds: z.array(z.string().min(1).max(500)).min(1).max(100),
  grader: z.object({ id: ReleaseIdSchema, revision: z.string().min(1).max(200), contentHash: ReleaseHashSchema, reward: LearningRevisionRefSchema.nullable().default(null) }).strict(),
  failureMeaning: z.literal("corrected_mistake_repeated"),
}).strict();
export const CorrectionVerificationPlanContentSchema = z.object({
  schemaVersion: z.literal("openpond.correctionVerificationPlan.v1"),
  id: ReleaseIdSchema, revision: z.literal(1), teamId: ReleaseIdSchema, ownerUserId: ReleaseIdSchema, modelId: ReleaseIdSchema,
  classification: z.literal("reviewed_model_behavior"),
  feedback: LearningRevisionRefSchema, evidence: LearningRevisionRefSchema,
  trainingJobId: ReleaseIdSchema, checkpoint: ImmutableReleaseRefSchema, artifact: ImmutableReleaseRefSchema,
  taskset: LearningRevisionRefSchema,
  checks: z.array(CorrectionVerificationCheckSchema).min(1).max(1000),
  baselineOperationId: ReleaseIdSchema, candidateOperationId: ReleaseIdSchema,
  criterion: z.literal("all_declared_checks_pass_after_failed_parent"),
  receivedAt: ReleaseTimestampSchema, eligibleAt: ReleaseTimestampSchema, frozenAt: ReleaseTimestampSchema,
}).strict().superRefine((plan, context) => {
  if (plan.baselineOperationId === plan.candidateOperationId) context.addIssue({ code: "custom", path: ["candidateOperationId"], message: "Parent and candidate must have distinct evaluation operations." });
  if (new Set(plan.checks.map(check => check.id)).size !== plan.checks.length) context.addIssue({ code: "custom", path: ["checks"], message: "Correction check identities must be unique." });
  for (const [index, check] of plan.checks.entries()) if (new Set(check.seeds).size !== check.seeds.length) context.addIssue({ code: "custom", path: ["checks", index, "seeds"], message: "Seeds must be unique per correction check." });
});
export const CorrectionVerificationPlanSchema = CorrectionVerificationPlanContentSchema.safeExtend({ contentHash: ReleaseHashSchema });
export type CorrectionVerificationPlan = z.infer<typeof CorrectionVerificationPlanSchema>;

export const CorrectionOpportunitySchema = z.object({
  schemaVersion: z.literal("openpond.correctionOpportunity.v1"),
  id: ReleaseIdSchema, correction: ImmutableReleaseRefSchema, source: z.enum(["evaluation", "live"]),
  modelId: ReleaseIdSchema, trainingJobId: ReleaseIdSchema, artifactId: ReleaseIdSchema, checkpointId: ReleaseIdSchema,
  observedAt: ReleaseTimestampSchema, occurredAt: ReleaseTimestampSchema,
  attempt: ImmutableReleaseRefSchema,
  classification: z.enum(["confirmed_repeat", "passed", "unscored"]),
  checkIds: z.array(ReleaseIdSchema).min(1).max(1000),
}).strict();
export type CorrectionOpportunity = z.infer<typeof CorrectionOpportunitySchema>;
export const CorrectionMetricObservationSchema = z.object({
  schemaVersion: z.literal("openpond.correctionMetricObservation.v1"),
  correction: ImmutableReleaseRefSchema, modelId: ReleaseIdSchema, trainingJobId: ReleaseIdSchema,
  checkpointId: ReleaseIdSchema, artifactId: ReleaseIdSchema, receivedAt: ReleaseTimestampSchema, eligibleAt: ReleaseTimestampSchema,
  firstBatchConsumptionAt: ReleaseTimestampSchema.nullable(), firstTrainingUseAt: ReleaseTimestampSchema.nullable(),
  verifiedAt: ReleaseTimestampSchema.nullable(), servedAt: ReleaseTimestampSchema.nullable(),
  baselineEvaluation: ImmutableReleaseRefSchema.nullable(), candidateEvaluation: ImmutableReleaseRefSchema.nullable(),
  status: z.enum(["pending_exposure", "pending_verification", "baseline_not_failed", "verified", "regressed", "withdrawn"]),
  opportunities: z.array(CorrectionOpportunitySchema).max(100_000), blockers: z.array(z.string().max(500)).max(20).default([]), observedAt: ReleaseTimestampSchema,
}).strict();
export type CorrectionMetricObservation = z.infer<typeof CorrectionMetricObservationSchema>;
const repeat = z.object({ confirmedRepeats: z.number().int().nonnegative(), scoredRelevantOpportunities: z.number().int().nonnegative(), unscoredOpportunities: z.number().int().nonnegative(), rate: z.number().min(0).max(1).nullable() }).strict();
export const CorrectionMetricSummarySchema = z.object({
  schemaVersion: z.literal("openpond.correctionMetricSummary.v1"), observedAt: ReleaseTimestampSchema,
  scope: z.object({ teamId: ReleaseIdSchema, modelId: ReleaseIdSchema, runId: ReleaseIdSchema.nullable(), checkpointId: ReleaseIdSchema.nullable(), artifactId: ReleaseIdSchema.nullable() }).strict(),
  window: z.object({ from: ReleaseTimestampSchema, to: ReleaseTimestampSchema }).strict(), correctionCount: z.number().int().nonnegative(),
  adaptation: z.object({ medianSeconds: z.number().nonnegative().nullable(), resolvedCount: z.number().int().nonnegative(), pendingCount: z.number().int().nonnegative(), oldestPendingSeconds: z.number().nonnegative().nullable() }).strict(),
  evaluation: repeat.safeExtend({ source: z.literal("evaluation") }), live: repeat.safeExtend({ source: z.literal("live") }),
}).strict();
export type CorrectionMetricSummary = z.infer<typeof CorrectionMetricSummarySchema>;
