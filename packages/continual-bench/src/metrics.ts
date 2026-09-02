import { z } from "zod";

import { ContinualBenchPanelRoleSchema } from "./schema.js";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const NullableMetric = z.number().finite().nullable();

export const ContinualBenchAttemptMetricSchema = z.object({
  attemptId: Id,
  seed: z.number().int(),
  repetition: z.number().int().nonnegative(),
  score: NullableMetric,
  passed: z.boolean().nullable(),
  latencyMs: z.number().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  transcript: z.object({ path: z.string().min(1), contentHash: Hash }).strict().nullable(),
  trace: z.object({ path: z.string().min(1), contentHash: Hash }).strict().nullable(),
  graderOutputHash: Hash.nullable(),
  status: z.enum(["completed", "failed", "cancelled"]),
}).strict();

export const ContinualBenchTaskMetricSchema = z.object({
  targetId: Id,
  panelId: Id,
  panelRole: ContinualBenchPanelRoleSchema,
  taskId: Id,
  familyId: Id,
  attempts: z.array(ContinualBenchAttemptMetricSchema).min(1).max(10_000),
  meanScore: NullableMetric,
  passRate: NullableMetric,
  confidenceInterval: z.tuple([z.number().finite(), z.number().finite()]).nullable(),
}).strict();

export const ContinualBenchEfficiencyMetricSchema = z.object({
  targetId: Id,
  trainingGpuSeconds: z.number().nonnegative().nullable(),
  evaluationGpuSeconds: z.number().nonnegative().nullable(),
  providerSpendUsd: z.number().nonnegative().nullable(),
  totalSpendUsd: z.number().nonnegative().nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
  optimizerGroups: z.number().int().nonnegative().nullable(),
  trajectories: z.number().int().nonnegative().nullable(),
}).strict();

export const ContinualBenchOutcomeSchema = z.enum([
  "systems_complete",
  "correction_absorbed",
  "issue_generalized",
  "continually_current",
  "frontier_pareto_result",
  "inconclusive",
  "loss",
]);

export type ContinualBenchAttemptMetric = z.infer<typeof ContinualBenchAttemptMetricSchema>;
export type ContinualBenchTaskMetric = z.infer<typeof ContinualBenchTaskMetricSchema>;
export type ContinualBenchEfficiencyMetric = z.infer<typeof ContinualBenchEfficiencyMetricSchema>;
export type ContinualBenchOutcome = z.infer<typeof ContinualBenchOutcomeSchema>;
