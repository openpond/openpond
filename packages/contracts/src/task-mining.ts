import { z } from "zod";

const IdSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().trim().min(1);
const MetadataSchema = z.record(z.string(), z.unknown()).default({});

export const TaskCandidateStatusSchema = z.enum([
  "nominated",
  "needs_review",
  "approved_for_creation",
  "creating",
  "needs_task_review",
  "baselining",
  "ready_for_export",
  "rejected",
  "dismissed",
  "retired",
  "blocked",
]);

export const TrainingTacticSchema = z.enum([
  "no_training",
  "prompting",
  "retrieval",
  "sft",
  "preference",
  "grpo_rft",
  "sdft_opsd",
  "sdpo",
  "agentic_rl",
]);

export const TaskCandidateEvidenceSchema = z.object({
  id: IdSchema,
  kind: z.enum(["repeated_success", "accepted_correction", "agent_action_recurrence", "outcome_linked_change", "frontier_cost", "expert_label", "runtime_feedback"]),
  sourceRefIds: z.array(IdSchema).min(1).max(10_000),
  occurredAt: TimestampSchema,
  signature: z.string().trim().min(1).max(2_000),
  summary: z.string().trim().min(1).max(5_000),
  confidence: z.number().min(0).max(1),
  consented: z.boolean(),
  metadata: MetadataSchema,
});

export const TaskCandidateScorecardSchema = z.object({
  frequency: z.number().min(0).max(1),
  businessValue: z.number().min(0).max(1),
  frontierCost: z.number().min(0).max(1),
  signalQuality: z.number().min(0).max(1),
  verifiability: z.number().min(0).max(1),
  repeatability: z.number().min(0).max(1),
  privacyRisk: z.number().min(0).max(1),
  overall: z.number().min(0).max(1),
});

export const TrainingTacticRecommendationSchema = z.object({
  tactic: TrainingTacticSchema,
  eligible: z.boolean(),
  reasons: z.array(z.string().trim().min(1).max(5_000)).min(1).max(100),
  blockers: z.array(z.string().trim().min(1).max(5_000)).max(100).default([]),
  requiredSignals: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  generatedBy: z.enum(["decision_table", "baseline_reassessment"]),
});

export const TaskCandidateSchema = z.object({
  schemaVersion: z.literal("openpond.taskCandidate.v1"),
  id: IdSchema,
  profileId: IdSchema,
  status: TaskCandidateStatusSchema,
  fingerprint: z.string().trim().min(1).max(512),
  title: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(10_000),
  workflowSignature: z.string().trim().min(1).max(2_000),
  evidence: z.array(TaskCandidateEvidenceSchema).min(1).max(100_000),
  scorecard: TaskCandidateScorecardSchema,
  recommendation: TrainingTacticRecommendationSchema,
  mergedIntoId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  metadata: MetadataSchema,
});

export const TaskMinerConfigSchema = z.object({
  schemaVersion: z.literal("openpond.taskMinerConfig.v1"),
  enabled: z.boolean().default(false),
  localOnly: z.boolean().default(true),
  observationWindowDays: z.number().int().min(1).max(365).default(30),
  minimumRecurrence: z.number().int().min(2).max(100).default(3),
  clustering: z.literal("hybrid_deterministic_first").default("hybrid_deterministic_first"),
  consentRequired: z.boolean().default(true),
});

export const TaskCandidateListResponseSchema = z.object({
  items: z.array(TaskCandidateSchema),
  generatedAt: TimestampSchema,
  config: TaskMinerConfigSchema,
});

export const PatchTaskCandidateRequestSchema = z.object({
  status: TaskCandidateStatusSchema.optional(),
  mergeIntoId: IdSchema.nullable().optional(),
});

export const RunTaskMinerRequestSchema = z.object({
  profileId: IdSchema,
  sourceIds: z.array(IdSchema).max(100_000).default([]),
  sessionIds: z.array(IdSchema).max(100_000).default([]),
  config: TaskMinerConfigSchema.optional(),
});

export const TaskMinerRunSchema = z.object({
  schemaVersion: z.literal("openpond.taskMinerRun.v1"),
  id: IdSchema,
  profileId: IdSchema,
  status: z.enum(["queued", "running", "cancelling", "cancelled", "succeeded", "failed"]),
  config: TaskMinerConfigSchema,
  sourceIds: z.array(IdSchema).max(100_000),
  sessionIds: z.array(IdSchema).max(100_000).default([]),
  progress: z.object({
    stage: z.enum(["queued", "ingesting", "preparing", "clustering", "persisting", "complete"]),
    processedSources: z.number().int().nonnegative(),
    totalSources: z.number().int().nonnegative(),
    candidatesFound: z.number().int().nonnegative(),
    skippedSources: z.number().int().nonnegative().default(0),
  }),
  candidateIds: z.array(IdSchema).max(100_000),
  cancelRequested: z.boolean(),
  error: z.string().trim().min(1).max(20_000).nullable(),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
});

export type TaskCandidateStatus = z.infer<typeof TaskCandidateStatusSchema>;
export type TrainingTactic = z.infer<typeof TrainingTacticSchema>;
export type TaskCandidateEvidence = z.infer<typeof TaskCandidateEvidenceSchema>;
export type TaskCandidateScorecard = z.infer<typeof TaskCandidateScorecardSchema>;
export type TrainingTacticRecommendation = z.infer<typeof TrainingTacticRecommendationSchema>;
export type TaskCandidate = z.infer<typeof TaskCandidateSchema>;
export type TaskMinerConfig = z.infer<typeof TaskMinerConfigSchema>;
export type TaskCandidateListResponse = z.infer<typeof TaskCandidateListResponseSchema>;
export type PatchTaskCandidateRequest = z.infer<typeof PatchTaskCandidateRequestSchema>;
export type RunTaskMinerRequest = z.infer<typeof RunTaskMinerRequestSchema>;
export type TaskMinerRun = z.infer<typeof TaskMinerRunSchema>;
