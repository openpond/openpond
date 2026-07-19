import { z } from "zod";
import { ChatModelRefSchema } from "./providers.js";
import { CodexReasoningEffortSchema } from "./settings.js";
import { TrainingSourceRefSchema } from "./tasksets.js";
import {
  CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CrossSystemBootstrapRecordSchema,
  CrossSystemTrajectorySchema,
  CrossSystemVerifierResultSchema,
} from "./cross-system-operations.js";

const IdSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().trim().min(1);

export const CrossSystemSplitSchema = z.enum(["train", "validation", "frozen_eval"]);
export const CrossSystemDifficultySchema = z.enum(["easy", "medium", "hard"]);
export const CrossSystemScenarioProfileSchema = z.enum([
  "renewal_risk_v2",
]);
export const CrossSystemTaskFamilySchema = z.enum([
  "renewal_exposure",
  "collections_prioritization",
  "invoice_reconciliation",
  "sla_escalation",
  "contract_billing_mismatch",
]);

export const CrossSystemWorldSpecSchema = z.object({
  seed: z.number().int().nonnegative(),
  split: CrossSystemSplitSchema,
  difficulty: CrossSystemDifficultySchema,
  scenarioProfile: CrossSystemScenarioProfileSchema.optional(),
});

export const DEFAULT_CROSS_SYSTEM_WORLD_SPECS = [
  { seed: 301, split: "train", difficulty: "easy" },
  { seed: 302, split: "train", difficulty: "medium" },
  { seed: 303, split: "train", difficulty: "hard" },
  { seed: 304, split: "train", difficulty: "easy" },
  { seed: 305, split: "train", difficulty: "medium" },
  { seed: 306, split: "train", difficulty: "hard" },
  { seed: 401, split: "validation", difficulty: "medium" },
  { seed: 402, split: "validation", difficulty: "hard" },
  { seed: 501, split: "frozen_eval", difficulty: "medium" },
  { seed: 502, split: "frozen_eval", difficulty: "hard" },
] as const satisfies readonly CrossSystemWorldSpec[];

const SuccessSummarySchema = z.record(
  z.string(),
  z.object({ attempts: z.number().int().nonnegative(), correct: z.number().int().nonnegative() }),
);

export const CrossSystemBaselineReportSchema = z.object({
  schemaVersion: z.literal(CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION),
  id: IdSchema,
  toolContractHash: z.literal(CROSS_SYSTEM_TOOL_CONTRACT_HASH),
  model: ChatModelRefSchema,
  trajectoryIds: z.array(IdSchema).max(100_000),
  exactMatchAccuracy: z.number().min(0).max(1),
  successByFamily: SuccessSummarySchema,
  successByDifficulty: SuccessSummarySchema,
  metrics: z.object({
    toolCalls: z.number().int().nonnegative(),
    rowsRead: z.number().int().nonnegative(),
    bytesRead: z.number().int().nonnegative(),
    wallTimeMs: z.number().int().nonnegative(),
    parseFailures: z.number().int().nonnegative(),
    budgetExhaustion: z.number().int().nonnegative(),
  }),
  reward: z.object({
    count: z.number().int().nonnegative(),
    mean: z.number(),
    min: z.number(),
    max: z.number(),
    variance: z.number().nonnegative(),
  }),
});

export const CrossSystemFrontierBaselineResultSchema = z.object({
  schemaVersion: z.literal("openpond.crossSystemFrontierBaseline.v1"),
  report: CrossSystemBaselineReportSchema,
  trajectories: z.array(CrossSystemTrajectorySchema).max(100_000),
  results: z.array(CrossSystemVerifierResultSchema).max(100_000),
  sources: z.array(TrainingSourceRefSchema).max(100_000),
  bootstrap: z.array(CrossSystemBootstrapRecordSchema).max(100_000),
});

export const CrossSystemFrontierBaselineRunSchema = z.object({
  schemaVersion: z.literal("openpond.crossSystemFrontierBaselineRun.v1"),
  id: IdSchema,
  profileId: IdSchema,
  createImproveRunId: IdSchema.nullable().default(null),
  localProjectId: IdSchema,
  localProjectName: z.string().trim().min(1).max(500),
  model: ChatModelRefSchema,
  reasoningEffort: CodexReasoningEffortSchema.nullable(),
  worldSpecs: z.array(CrossSystemWorldSpecSchema).min(3).max(100),
  status: z.enum(["queued", "running", "cancelling", "cancelled", "succeeded", "failed"]),
  progress: z.object({
    stage: z.enum(["queued", "preparing", "running", "persisting", "complete"]),
    completedTasks: z.number().int().nonnegative(),
    totalTasks: z.number().int().nonnegative(),
    currentTask: z.object({
      index: z.number().int().nonnegative(),
      taskId: IdSchema,
      worldId: IdSchema,
      family: CrossSystemTaskFamilySchema,
    }).nullable(),
    outcomes: z.object({
      correct: z.number().int().nonnegative(),
      incorrect: z.number().int().nonnegative(),
      parseFailure: z.number().int().nonnegative(),
      budgetExhausted: z.number().int().nonnegative(),
      toolSchemaViolation: z.number().int().nonnegative(),
      infrastructureFailure: z.number().int().nonnegative(),
      cancelled: z.number().int().nonnegative(),
    }),
  }),
  sourceIds: z.array(IdSchema).max(100_000),
  reboundSessionCount: z.number().int().nonnegative(),
  result: CrossSystemFrontierBaselineResultSchema.nullable(),
  cancelRequested: z.boolean(),
  error: z.string().trim().min(1).max(20_000).nullable(),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
});

export type CrossSystemSplit = z.infer<typeof CrossSystemSplitSchema>;
export type CrossSystemDifficulty = z.infer<typeof CrossSystemDifficultySchema>;
export type CrossSystemScenarioProfile = z.infer<typeof CrossSystemScenarioProfileSchema>;
export type CrossSystemTaskFamily = z.infer<typeof CrossSystemTaskFamilySchema>;
export type CrossSystemWorldSpec = z.infer<typeof CrossSystemWorldSpecSchema>;
export type CrossSystemBaselineReport = z.infer<typeof CrossSystemBaselineReportSchema>;
export type CrossSystemFrontierBaselineResult = z.infer<typeof CrossSystemFrontierBaselineResultSchema>;
export type CrossSystemFrontierBaselineRun = z.infer<typeof CrossSystemFrontierBaselineRunSchema>;
