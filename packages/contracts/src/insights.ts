import { z } from "zod";
import { ChatModelRefSchema } from "./providers.js";
import { SessionSchema } from "./sessions.js";
import { ContextUsageSnapshotSchema } from "./settings.js";

export const InsightSeveritySchema = z.enum(["nit", "concern", "blocker"]);
export const InsightStatusSchema = z.enum(["active", "resolved", "dismissed"]);
export const InsightScopeTypeSchema = z.enum(["global", "session", "workspace"]);
export const InsightRunTriggerSchema = z.enum(["startup", "interval", "manual", "slash_command"]);
export const InsightRunStatusSchema = z.enum(["running", "completed", "failed", "skipped"]);
export const InsightEvidenceSourceSchema = z.enum([
  "create_edit",
  "stuck_turn",
  "tool_failure",
  "abandoned_goal",
  "user_correction",
  "unresolved_conversation",
  "usage_anomaly",
]);

export const InsightPayloadSchema = z.record(z.string(), z.unknown()).default({});

export const UsageAnomalyInsightKindSchema = z.enum([
  "usage_spike",
  "model_usage_spike",
  "latency_regression",
  "failure_cluster",
  "missing_usage_frames",
]);

export const UsageAnomalyMetricSchema = z.enum([
  "requests",
  "total_tokens",
  "p95_latency_ms",
  "failed_requests",
  "missing_usage_requests",
]);

export const UsageAnomalyInsightPayloadSchema = z.object({
  detector: z.literal("usage-anomaly"),
  evidenceSource: z.literal("usage_anomaly"),
  evidenceKey: z.string().trim().min(1),
  anomalyKind: UsageAnomalyInsightKindSchema,
  metric: UsageAnomalyMetricSchema,
  provider: z.string().trim().min(1).nullable(),
  model: z.string().trim().min(1).nullable(),
  visibility: z.string().trim().min(1),
  current: z.object({
    from: z.string().trim().min(1),
    to: z.string().trim().min(1),
    requests: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    failedRequests: z.number().int().nonnegative(),
    missingUsageRequests: z.number().int().nonnegative(),
    p95LatencyMs: z.number().nonnegative().nullable(),
  }),
  baseline: z.object({
    from: z.string().trim().min(1),
    to: z.string().trim().min(1),
    activeDays: z.number().int().nonnegative(),
    medianRequests: z.number().nonnegative(),
    medianTotalTokens: z.number().nonnegative(),
    medianFailedRequests: z.number().nonnegative(),
    medianMissingUsageRequests: z.number().nonnegative(),
    medianP95LatencyMs: z.number().nonnegative().nullable(),
  }),
  ratio: z.number().nonnegative().nullable(),
  absoluteFloor: z.number().nonnegative(),
  drilldown: z.object({
    startedAtFrom: z.string().trim().min(1),
    startedAtTo: z.string().trim().min(1),
    visibility: z.string().trim().min(1),
    status: z.string().trim().min(1),
    provider: z.string().trim().min(1).nullable(),
    model: z.string().trim().min(1).nullable(),
  }),
  linkedSessionIds: z.array(z.string().trim().min(1)).default([]),
  linkedCommandNames: z.array(z.string().trim().min(1)).default([]),
});

export const InsightItemSchema = z.object({
  id: z.string().trim().min(1),
  scopeType: InsightScopeTypeSchema,
  scopeId: z.string().trim().min(1),
  severity: InsightSeveritySchema,
  type: z.string().trim().min(1),
  status: InsightStatusSchema,
  fingerprint: z.string().trim().min(1),
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  payload: InsightPayloadSchema,
  lastRunId: z.string().trim().min(1).nullable().optional(),
  lastRunSessionId: z.string().trim().min(1).nullable().optional(),
  lastRunTurnId: z.string().trim().min(1).nullable().optional(),
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
  resolvedAt: z.string().trim().min(1).nullable(),
  dismissedAt: z.string().trim().min(1).nullable(),
});

export const InsightRunSchema = z.object({
  id: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  turnId: z.string().trim().min(1),
  trigger: InsightRunTriggerSchema,
  status: InsightRunStatusSchema,
  startedAt: z.string().trim().min(1),
  completedAt: z.string().trim().min(1).nullable(),
  elapsedMs: z.number().int().nonnegative().nullable().optional().default(null),
  modelRef: ChatModelRefSchema.nullable().optional(),
  usage: ContextUsageSnapshotSchema.nullable().optional().default(null),
  evidenceSources: z.array(InsightEvidenceSourceSchema).optional().default([]),
  evidenceHash: z.string().trim().min(1).nullable(),
  sourceEventSequence: z.number().int().nonnegative().nullable(),
  findingCount: z.number().int().nonnegative(),
  createdCount: z.number().int().nonnegative().optional().default(0),
  updatedCount: z.number().int().nonnegative().optional().default(0),
  resolvedCount: z.number().int().nonnegative().optional().default(0),
  summary: z.string().trim().min(1).nullable(),
  error: z.string().trim().min(1).nullable(),
});

export const InsightSummarySchema = z.object({
  totalCount: z.number().int().nonnegative(),
  activeCount: z.number().int().nonnegative(),
  resolvedCount: z.number().int().nonnegative(),
  dismissedCount: z.number().int().nonnegative(),
  highestActiveSeverity: InsightSeveritySchema.nullable(),
});

export const InsightsListResponseSchema = z.object({
  items: z.array(InsightItemSchema),
  runs: z.array(InsightRunSchema).optional().default([]),
  systemSessionId: z.string().trim().min(1).nullable().optional().default(null),
  systemSession: SessionSchema.nullable().optional().default(null),
  summary: InsightSummarySchema,
  generatedAt: z.string().trim().min(1),
  nextScanAt: z.string().trim().min(1).nullable(),
  scanRunning: z.boolean(),
  scanStartedAt: z.string().trim().min(1).nullable(),
});

export const InsightsScanResponseSchema = InsightsListResponseSchema.extend({
  scannedAt: z.string().trim().min(1),
  scanned: z.boolean(),
});

export const InsightsAskRequestSchema = z.object({
  question: z.string().trim().min(1).max(20_000),
});

export const InsightsAskResponseSchema = InsightsListResponseSchema.extend({
  turnId: z.string().trim().min(1),
});

export const PatchInsightRequestSchema = z.object({
  status: InsightStatusSchema,
});

export type InsightSeverity = z.infer<typeof InsightSeveritySchema>;
export type InsightStatus = z.infer<typeof InsightStatusSchema>;
export type InsightScopeType = z.infer<typeof InsightScopeTypeSchema>;
export type InsightRunTrigger = z.infer<typeof InsightRunTriggerSchema>;
export type InsightRunStatus = z.infer<typeof InsightRunStatusSchema>;
export type InsightEvidenceSource = z.infer<typeof InsightEvidenceSourceSchema>;
export type InsightPayload = z.infer<typeof InsightPayloadSchema>;
export type UsageAnomalyInsightKind = z.infer<typeof UsageAnomalyInsightKindSchema>;
export type UsageAnomalyMetric = z.infer<typeof UsageAnomalyMetricSchema>;
export type UsageAnomalyInsightPayload = z.infer<typeof UsageAnomalyInsightPayloadSchema>;
export type InsightItem = z.infer<typeof InsightItemSchema>;
export type InsightRun = z.infer<typeof InsightRunSchema>;
export type InsightSummary = z.infer<typeof InsightSummarySchema>;
export type InsightsListResponse = z.infer<typeof InsightsListResponseSchema>;
export type InsightsScanResponse = z.infer<typeof InsightsScanResponseSchema>;
export type InsightsAskRequest = z.infer<typeof InsightsAskRequestSchema>;
export type InsightsAskResponse = z.infer<typeof InsightsAskResponseSchema>;
export type PatchInsightRequest = z.infer<typeof PatchInsightRequestSchema>;
