import { z } from "zod";

import {
  MetadataSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
} from "@openpond/harness";

export const RUN_TELEMETRY_SCHEMA_VERSION = "openpond.runTelemetryEvent.v1" as const;
export const METRIC_DEFINITION_SCHEMA_VERSION = "openpond.metricDefinition.v1" as const;
export const METRIC_OBSERVATION_SCHEMA_VERSION = "openpond.metricObservation.v1" as const;

export const TelemetryVisibilitySchema = z.enum([
  "policy_visible",
  "team_visible",
  "host_private",
]);

export const TelemetrySourceSchema = z.enum([
  "runtime",
  "environment",
  "grader",
  "optimizer",
  "control_plane",
  "evaluation",
]);

export const TelemetryEventTypeSchema = z.enum([
  "run_started",
  "run_state_changed",
  "rollout_group_started",
  "attempt_completed",
  "grader_completed",
  "reward_composed",
  "optimizer_step_completed",
  "checkpoint_committed",
  "evaluation_completed",
  "run_completed",
  "run_failed",
  "cleanup_completed",
]);

export const RunTelemetryLineageSchema = z.object({
  modelProjectId: ReleaseIdSchema,
  runId: ReleaseIdSchema,
  modelVersionId: ReleaseIdSchema.nullable(),
  harnessReleaseHash: ReleaseHashSchema,
  tasksetReleaseHash: ReleaseHashSchema,
  environmentReleaseHash: ReleaseHashSchema.nullable(),
  checkpointId: ReleaseIdSchema.nullable(),
  step: z.number().int().nonnegative().nullable(),
  rolloutGroupId: ReleaseIdSchema.nullable(),
  attemptId: ReleaseIdSchema.nullable(),
  scenarioId: ReleaseIdSchema.nullable(),
}).strict();

export const RunTelemetryEventSchema = z.object({
  schemaVersion: z.literal(RUN_TELEMETRY_SCHEMA_VERSION),
  eventId: ReleaseIdSchema,
  sequence: z.number().int().nonnegative(),
  occurredAt: ReleaseTimestampSchema,
  source: TelemetrySourceSchema,
  type: TelemetryEventTypeSchema,
  visibility: TelemetryVisibilitySchema,
  lineage: RunTelemetryLineageSchema,
  attributes: MetadataSchema,
}).strict();

export const MetricValueTypeSchema = z.enum(["gauge", "counter", "distribution"]);
export const MetricUnitSchema = z.enum([
  "ratio",
  "count",
  "seconds",
  "milliseconds",
  "tokens",
  "bytes",
  "usd",
  "scalar",
]);
export const MetricDirectionSchema = z.enum(["higher", "lower", "neutral"]);
export const MetricAggregationSchema = z.enum(["last", "sum", "mean", "min", "max", "p50", "p95"]);

export const MetricDefinitionSchema = z.object({
  schemaVersion: z.literal(METRIC_DEFINITION_SCHEMA_VERSION),
  id: ReleaseIdSchema,
  displayName: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2_000),
  valueType: MetricValueTypeSchema,
  unit: MetricUnitSchema,
  direction: MetricDirectionSchema,
  aggregation: MetricAggregationSchema,
  visibility: TelemetryVisibilitySchema,
  boundedDimensions: z.array(z.string().trim().min(1).max(100)).max(32),
}).strict();

export const MetricObservationSchema = z.object({
  schemaVersion: z.literal(METRIC_OBSERVATION_SCHEMA_VERSION),
  observationId: ReleaseIdSchema,
  metricId: ReleaseIdSchema,
  eventId: ReleaseIdSchema,
  sequence: z.number().int().nonnegative(),
  observedAt: ReleaseTimestampSchema,
  value: z.number().finite(),
  lineage: RunTelemetryLineageSchema,
  dimensions: z.record(z.string().trim().min(1).max(100), z.string().max(500)),
}).strict();

export const RunTelemetryBatchSchema = z.object({
  schemaVersion: z.literal("openpond.runTelemetryBatch.v1"),
  events: z.array(RunTelemetryEventSchema).max(1_000),
  observations: z.array(MetricObservationSchema).max(10_000),
}).strict().superRefine((batch, context) => {
  if (batch.events.length + batch.observations.length === 0) {
    context.addIssue({ code: "custom", message: "Telemetry batch cannot be empty." });
  }
  const keys = new Set<string>();
  for (const item of [...batch.events, ...batch.observations]) {
    const id = item.schemaVersion === METRIC_OBSERVATION_SCHEMA_VERSION
      ? item.observationId
      : item.eventId;
    const key = `${item.lineage.runId}:${item.sequence}:${id}`;
    if (keys.has(key)) {
      context.addIssue({ code: "custom", message: "Telemetry batch contains a duplicate idempotency key." });
    }
    keys.add(key);
  }
});

export type TelemetryVisibility = z.infer<typeof TelemetryVisibilitySchema>;
export type TelemetrySource = z.infer<typeof TelemetrySourceSchema>;
export type TelemetryEventType = z.infer<typeof TelemetryEventTypeSchema>;
export type RunTelemetryLineage = z.infer<typeof RunTelemetryLineageSchema>;
export type RunTelemetryEvent = z.infer<typeof RunTelemetryEventSchema>;
export type MetricDefinition = z.infer<typeof MetricDefinitionSchema>;
export type MetricObservation = z.infer<typeof MetricObservationSchema>;
export type RunTelemetryBatch = z.infer<typeof RunTelemetryBatchSchema>;
