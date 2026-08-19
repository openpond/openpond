import { z } from "zod";

import { ReleaseIdSchema } from "@openpond/harness";

/**
 * A policy-visible requirement that can contribute to task evaluation.  The
 * source trace is deliberately part of the release: graders may not invent a
 * requirement that the policy could not have learned from the task.
 */
export const EvaluationCriterionSourceSchema = z.object({
  source: z.enum(["prompt", "attachment", "declared_output_schema"]),
  path: z.string().trim().min(1).max(2_000),
  quoteOrAnchor: z.string().trim().min(1).max(10_000),
}).strict();

export const EvaluationCriterionSchema = z.object({
  id: ReleaseIdSchema,
  label: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1).max(10_000),
  sourceRefs: z.array(EvaluationCriterionSourceSchema).min(1).max(100),
  kind: z.enum([
    "hard_constraint",
    "artifact_structure",
    "semantic_quality",
    "factual_grounding",
  ]),
  weight: z.number().positive().max(1_000),
  critical: z.boolean(),
  scorerIds: z.array(ReleaseIdSchema).min(1).max(100),
}).strict();

/** A grader's bounded, inspectable result for one released criterion. */
export const CriterionScoreSchema = z.object({
  criterionId: ReleaseIdSchema,
  score: z.number().min(0).max(1),
  passed: z.boolean(),
  feedback: z.string().trim().max(20_000).nullable().default(null),
  evidenceRefs: z.array(ReleaseIdSchema).max(10_000).default([]),
}).strict();

export const AttemptDiagnosisCauseSchema = z.object({
  code: z.enum([
    "tool_failure",
    "artifact_missing",
    "artifact_invalid",
    "visible_format_failure",
    "visible_constraint_failure",
    "semantic_completeness_failure",
    "factual_grounding_failure",
    "unsafe_or_forbidden_output",
    "grader_disagreement",
    "insufficient_evidence",
  ]),
  owner: z.enum([
    "model",
    "harness",
    "taskset",
    "runtime",
    "provider",
    "grader",
    "unknown",
  ]),
  criterionIds: z.array(ReleaseIdSchema).max(1_000).default([]),
  evidenceRefs: z.array(ReleaseIdSchema).max(10_000).default([]),
  scoreImpact: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
}).strict();

export const AttemptDiagnosisContentSchema = z.object({
  schemaVersion: z.literal("openpond.attemptDiagnosis.v1"),
  attemptId: ReleaseIdSchema,
  terminalClass: z.enum([
    "completed",
    "infrastructure_failure",
    "environment_failure",
    "timeout",
    "cancelled",
    "grader_failure",
  ]),
  causes: z.array(AttemptDiagnosisCauseSchema).max(1_000).default([]),
  primaryCauseCode: AttemptDiagnosisCauseSchema.shape.code.nullable(),
  rewardEligible: z.boolean(),
}).strict();

export const AttemptDiagnosisSchema = AttemptDiagnosisContentSchema.extend({
  contentHash: z.string().trim().regex(/^[a-f0-9]{64}$/),
}).strict();

export type EvaluationCriterion = z.infer<typeof EvaluationCriterionSchema>;
export type CriterionScore = z.infer<typeof CriterionScoreSchema>;
export type AttemptDiagnosis = z.infer<typeof AttemptDiagnosisSchema>;
