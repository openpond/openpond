import { z } from "zod";
import { ChatProviderSchema, WorkspaceKindSchema } from "./settings.js";

export const ModelUsageRouteSchema = z.enum([
  "openpond_hosted",
  "local_byok",
  "codex_app_server",
  "unknown",
]);

export const ModelUsageSourceSchema = z.enum([
  "provider_usage",
  "codex_context_usage",
  "missing",
]);

export const ModelUsageRequestKindSchema = z.enum([
  "chat_turn",
  "tool_loop",
  "slash_command",
  "create_pipeline_planner",
  "context_compaction",
  "insights_scan",
  "insights_question",
  "goal_control",
  "codex_context",
  "other",
]);

export const ModelUsageVisibilitySchema = z.enum([
  "user_facing",
  "background",
  "system",
]);

export const ModelUsageStatusSchema = z.enum([
  "started",
  "completed",
  "failed",
  "interrupted",
]);

export const UsageCommandSourceSchema = z.enum([
  "composer_selection",
  "prompt_parse",
  "server_parser",
  "model_tool",
  "api",
]);

export const UsageSurfaceSchema = z.enum([
  "chat",
  "settings",
  "insights",
  "goal",
  "create_pipeline",
  "compaction",
  "system",
]);

export const UsageWorkflowKindSchema = z.enum([
  "direct_chat",
  "tool_loop",
  "slash_command",
  "planner",
  "summary",
  "scan",
  "goal_control",
  "other",
]);

export const ModelUsageAttributionSchema = z.object({
  surface: UsageSurfaceSchema,
  workflowKind: UsageWorkflowKindSchema,
  sessionId: z.string().trim().min(1).nullable(),
  turnId: z.string().trim().min(1).nullable(),
  insightRunId: z.string().trim().min(1).nullable(),
  goalId: z.string().trim().min(1).nullable(),
  createPipelineRequestId: z.string().trim().min(1).nullable(),
  createPipelineId: z.string().trim().min(1).nullable(),
  commandName: z.string().trim().min(1).max(160).nullable(),
  commandSource: UsageCommandSourceSchema.nullable(),
  appId: z.string().trim().min(1).nullable(),
  workspaceKind: WorkspaceKindSchema.nullable(),
  workspaceId: z.string().trim().min(1).nullable(),
  localProjectId: z.string().trim().min(1).nullable(),
  cloudProjectId: z.string().trim().min(1).nullable(),
  sourceEventSequence: z.number().int().nonnegative().nullable(),
});

export const UsageRequestAttributionSchema = z.object({
  surface: UsageSurfaceSchema.optional(),
  workflowKind: UsageWorkflowKindSchema.optional(),
  insightRunId: z.string().trim().min(1).nullable().optional(),
  goalId: z.string().trim().min(1).nullable().optional(),
  createPipelineRequestId: z.string().trim().min(1).nullable().optional(),
  createPipelineId: z.string().trim().min(1).nullable().optional(),
  commandName: z.string().trim().min(1).max(160).nullable().optional(),
  commandSource: UsageCommandSourceSchema.nullable().optional(),
}).strict();

export const UsageProviderSchema = z.union([ChatProviderSchema, z.literal("unknown")]);

export const ModelUsageRecordSchema = z.object({
  id: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
  requestOrdinal: z.number().int().nonnegative(),
  sessionId: z.string().trim().min(1).nullable(),
  turnId: z.string().trim().min(1).nullable(),
  provider: UsageProviderSchema,
  model: z.string().trim().min(1),
  route: ModelUsageRouteSchema,
  source: ModelUsageSourceSchema,
  requestKind: ModelUsageRequestKindSchema,
  visibility: ModelUsageVisibilitySchema,
  status: ModelUsageStatusSchema,
  startedAt: z.string().trim().min(1),
  completedAt: z.string().trim().min(1).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  firstTokenMs: z.number().int().nonnegative().nullable(),
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  errorType: z.string().trim().min(1).max(160).nullable(),
  errorMessage: z.string().trim().min(1).max(2000).nullable(),
  attribution: ModelUsageAttributionSchema,
});

export const UsageRangeSchema = z.object({
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
  bucket: z.enum(["day", "all_time"]),
});

export const UsageVisibilityFilterSchema = z.union([
  z.literal("all"),
  ModelUsageVisibilitySchema,
]);

export const UsageStatusFilterSchema = z.enum([
  "all",
  "started",
  "completed",
  "failed",
  "interrupted",
  "missing",
]);

export const UsageSummaryQuerySchema = z.object({
  range: z.enum(["7d", "30d", "90d", "all"]).default("30d"),
  visibility: UsageVisibilityFilterSchema.default("all"),
  status: UsageStatusFilterSchema.default("all"),
});

export const UsageRecordsQuerySchema = UsageSummaryQuerySchema.extend({
  sessionId: z.string().trim().min(1).optional(),
  turnId: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(500).default(100),
});

const UsageBreakdownBaseSchema = z.object({
  requests: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  averageLatencyMs: z.number().nonnegative().nullable(),
  p95LatencyMs: z.number().nonnegative().nullable(),
  averageFirstTokenMs: z.number().nonnegative().nullable(),
  p95FirstTokenMs: z.number().nonnegative().nullable(),
  failures: z.number().int().nonnegative(),
  failureRate: z.number().nonnegative(),
  firstSeenAt: z.string().trim().min(1),
  lastSeenAt: z.string().trim().min(1),
});

export const UsageModelBreakdownSchema = UsageBreakdownBaseSchema.extend({
  provider: UsageProviderSchema,
  model: z.string().trim().min(1),
  route: ModelUsageRouteSchema,
});

export const UsageThreadBreakdownSchema = UsageBreakdownBaseSchema.extend({
  sessionId: z.string().trim().min(1),
  title: z.string().trim().min(1).nullable(),
  workspaceKind: WorkspaceKindSchema.nullable(),
  workspaceId: z.string().trim().min(1).nullable(),
});

export const UsageCommandBreakdownSchema = UsageBreakdownBaseSchema.extend({
  commandName: z.string().trim().min(1),
  commandSource: UsageCommandSourceSchema.nullable(),
});

export const UsageInsightRunBreakdownSchema = UsageBreakdownBaseSchema.extend({
  insightRunId: z.string().trim().min(1),
  status: z.string().trim().min(1).nullable(),
  trigger: z.string().trim().min(1).nullable(),
  findingCount: z.number().int().nonnegative().nullable(),
  sessionId: z.string().trim().min(1).nullable(),
  turnId: z.string().trim().min(1).nullable(),
});

export const UsageRouteBreakdownSchema = UsageBreakdownBaseSchema.extend({
  route: ModelUsageRouteSchema,
});

export const UsageStatusBreakdownSchema = UsageBreakdownBaseSchema.extend({
  status: ModelUsageStatusSchema,
});

export const UsageSourceBreakdownSchema = UsageBreakdownBaseSchema.extend({
  source: ModelUsageSourceSchema,
});

export const UsageDailyBucketSchema = z.object({
  date: z.string().trim().min(1),
  totalTokens: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  models: z.array(z.object({
    provider: UsageProviderSchema,
    model: z.string().trim().min(1),
    totalTokens: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
  })),
});

export const UsageTotalsSchema = z.object({
  requests: z.number().int().nonnegative(),
  completedRequests: z.number().int().nonnegative(),
  failedRequests: z.number().int().nonnegative(),
  missingUsageRequests: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  averageLatencyMs: z.number().nonnegative().nullable(),
  p95LatencyMs: z.number().nonnegative().nullable(),
  averageFirstTokenMs: z.number().nonnegative().nullable(),
  p95FirstTokenMs: z.number().nonnegative().nullable(),
  failureRate: z.number().nonnegative(),
  activeModelCount: z.number().int().nonnegative(),
});

export const UsageSummaryResponseSchema = z.object({
  generatedAt: z.string().trim().min(1),
  range: UsageRangeSchema,
  filters: z.object({
    visibility: UsageVisibilityFilterSchema,
    status: UsageStatusFilterSchema,
  }),
  totals: UsageTotalsSchema,
  daily: z.array(UsageDailyBucketSchema),
  models: z.array(UsageModelBreakdownSchema),
  threads: z.array(UsageThreadBreakdownSchema),
  commands: z.array(UsageCommandBreakdownSchema),
  insightRuns: z.array(UsageInsightRunBreakdownSchema),
  routes: z.array(UsageRouteBreakdownSchema),
  statuses: z.array(UsageStatusBreakdownSchema),
  sources: z.array(UsageSourceBreakdownSchema),
});

export const UsageRecordsResponseSchema = z.object({
  generatedAt: z.string().trim().min(1),
  range: UsageRangeSchema,
  filters: z.object({
    visibility: UsageVisibilityFilterSchema,
    status: UsageStatusFilterSchema,
    sessionId: z.string().trim().min(1).nullable(),
    turnId: z.string().trim().min(1).nullable(),
  }),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
  records: z.array(ModelUsageRecordSchema),
});

export const UsageSignalTypeSchema = z.enum([
  "usage_spike",
  "model_usage_spike",
  "latency_regression",
  "failure_cluster",
  "missing_usage_frames",
]);

export const UsageSignalSchema = z.object({
  type: UsageSignalTypeSchema,
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  severity: z.enum(["nit", "concern", "blocker"]),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type ModelUsageRoute = z.infer<typeof ModelUsageRouteSchema>;
export type ModelUsageSource = z.infer<typeof ModelUsageSourceSchema>;
export type ModelUsageRequestKind = z.infer<typeof ModelUsageRequestKindSchema>;
export type ModelUsageVisibility = z.infer<typeof ModelUsageVisibilitySchema>;
export type ModelUsageStatus = z.infer<typeof ModelUsageStatusSchema>;
export type UsageCommandSource = z.infer<typeof UsageCommandSourceSchema>;
export type UsageSurface = z.infer<typeof UsageSurfaceSchema>;
export type UsageWorkflowKind = z.infer<typeof UsageWorkflowKindSchema>;
export type ModelUsageAttribution = z.infer<typeof ModelUsageAttributionSchema>;
export type UsageRequestAttribution = z.infer<typeof UsageRequestAttributionSchema>;
export type UsageProvider = z.infer<typeof UsageProviderSchema>;
export type ModelUsageRecord = z.infer<typeof ModelUsageRecordSchema>;
export type UsageRange = z.infer<typeof UsageRangeSchema>;
export type UsageVisibilityFilter = z.infer<typeof UsageVisibilityFilterSchema>;
export type UsageStatusFilter = z.infer<typeof UsageStatusFilterSchema>;
export type UsageSummaryQuery = z.infer<typeof UsageSummaryQuerySchema>;
export type UsageRecordsQuery = z.infer<typeof UsageRecordsQuerySchema>;
export type UsageModelBreakdown = z.infer<typeof UsageModelBreakdownSchema>;
export type UsageThreadBreakdown = z.infer<typeof UsageThreadBreakdownSchema>;
export type UsageCommandBreakdown = z.infer<typeof UsageCommandBreakdownSchema>;
export type UsageInsightRunBreakdown = z.infer<typeof UsageInsightRunBreakdownSchema>;
export type UsageRouteBreakdown = z.infer<typeof UsageRouteBreakdownSchema>;
export type UsageStatusBreakdown = z.infer<typeof UsageStatusBreakdownSchema>;
export type UsageSourceBreakdown = z.infer<typeof UsageSourceBreakdownSchema>;
export type UsageDailyBucket = z.infer<typeof UsageDailyBucketSchema>;
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;
export type UsageSummaryResponse = z.infer<typeof UsageSummaryResponseSchema>;
export type UsageRecordsResponse = z.infer<typeof UsageRecordsResponseSchema>;
export type UsageSignalType = z.infer<typeof UsageSignalTypeSchema>;
export type UsageSignal = z.infer<typeof UsageSignalSchema>;
