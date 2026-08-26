import { z } from "zod";

import { ReleaseHashSchema, ReleaseIdSchema, ReleaseTimestampSchema, contentHash } from "@openpond/harness";

import { getCoreMetricDefinition, validateCoreMetricObservation } from "./telemetry-catalog.js";
import {
  MetricObservationSchema,
  RunTelemetryEventSchema,
  TelemetryVisibilitySchema,
  type MetricObservation,
  type RunTelemetryEvent,
  type RunTelemetryLineage,
  type TelemetryEventType,
  type TelemetrySource,
  type TelemetryVisibility,
} from "./telemetry.js";

export const TelemetryCohortSchema = z.object({
  checkpointIds: z.array(ReleaseIdSchema).max(1_000),
  steps: z.array(z.number().int().nonnegative()).max(10_000),
  scenarioIds: z.array(ReleaseIdSchema).max(100_000),
  rolloutGroupIds: z.array(ReleaseIdSchema).max(100_000),
  attemptIds: z.array(ReleaseIdSchema).max(1_000_000),
  splits: z.array(z.string().trim().min(1).max(100)).max(32),
  failureOwners: z.array(z.string().trim().min(1).max(100)).max(32),
  graders: z.array(z.string().trim().min(1).max(200)).max(1_000),
  rewardEligible: z.boolean().nullable(),
}).strict();
export type TelemetryCohort = z.infer<typeof TelemetryCohortSchema>;

export const EvidenceReferenceSchema = z.object({
  id: ReleaseIdSchema,
  contentHash: ReleaseHashSchema,
  kind: z.enum(["rollout", "attempt", "trace", "grader", "checkpoint", "artifact"]),
  visibility: TelemetryVisibilitySchema,
}).strict();

export const EvidenceCompletenessSchema = z.object({
  schemaVersion: z.literal("openpond.telemetryEvidenceCompleteness.v1"),
  runId: ReleaseIdSchema,
  status: z.enum(["complete", "partial", "missing"]),
  expectedEventTypes: z.array(z.string().trim().min(1).max(100)).max(100),
  observedEventTypes: z.array(z.string().trim().min(1).max(100)).max(100),
  missingEventTypes: z.array(z.string().trim().min(1).max(100)).max(100),
  lastSequence: z.number().int().nonnegative().nullable(),
  sequenceGaps: z.array(z.number().int().nonnegative()).max(10_000),
}).strict();

export const MetricSeriesPointSchema = z.object({
  step: z.number().int().nonnegative().nullable(),
  observedAt: ReleaseTimestampSchema,
  value: z.number().finite(),
  sampleCount: z.number().int().positive(),
}).strict();

export const RunMetricSummarySchema = z.object({
  schemaVersion: z.literal("openpond.runMetricSummary.v1"),
  runId: ReleaseIdSchema,
  metricId: ReleaseIdSchema,
  aggregation: z.enum(["last", "sum", "mean", "min", "max", "p50", "p95"]),
  value: z.number().finite().nullable(),
  sampleCount: z.number().int().nonnegative(),
  series: z.array(MetricSeriesPointSchema).max(100_000),
}).strict();

export function createRunTelemetryEvent(input: {
  sequence: number;
  occurredAt: string;
  source: TelemetrySource;
  type: TelemetryEventType;
  visibility: TelemetryVisibility;
  lineage: RunTelemetryLineage;
  attributes?: Record<string, string | number | boolean | null>;
}): RunTelemetryEvent {
  const idHash = contentHash({ runId: input.lineage.runId, sequence: input.sequence, type: input.type, source: input.source });
  return RunTelemetryEventSchema.parse({
    schemaVersion: "openpond.runTelemetryEvent.v1",
    eventId: `telemetry-${idHash.slice(0, 32)}`,
    ...input,
    attributes: input.attributes ?? {},
  });
}

export function createMetricObservation(input: {
  metricId: string;
  eventId: string;
  sequence: number;
  observedAt: string;
  value: number;
  lineage: RunTelemetryLineage;
  dimensions?: Record<string, string>;
}): MetricObservation {
  const idHash = contentHash({ runId: input.lineage.runId, metricId: input.metricId, sequence: input.sequence });
  return validateCoreMetricObservation(MetricObservationSchema.parse({
    schemaVersion: "openpond.metricObservation.v1",
    observationId: `metric-${idHash.slice(0, 32)}`,
    ...input,
    dimensions: input.dimensions ?? {},
  }));
}

export function telemetryIdempotencyKey(item: RunTelemetryEvent | MetricObservation): string {
  const id = item.schemaVersion === "openpond.metricObservation.v1" ? item.observationId : item.eventId;
  return `${item.lineage.runId}:${item.sequence}:${id}`;
}

export function mergeTelemetryItems(input: {
  events: RunTelemetryEvent[];
  observations: MetricObservation[];
}): { events: RunTelemetryEvent[]; observations: MetricObservation[] } {
  const accepted = new Map<string, RunTelemetryEvent | MetricObservation>();
  const sequences = new Map<string, string>();
  for (const item of [...input.events, ...input.observations]) {
    const key = telemetryIdempotencyKey(item);
    const existing = accepted.get(key);
    if (existing) {
      if (contentHash(existing) !== contentHash(item)) throw new Error(`Telemetry idempotency conflict: ${key}`);
      continue;
    }
    const sequenceKey = `${item.lineage.runId}:${item.sequence}`;
    const priorKey = sequences.get(sequenceKey);
    if (priorKey && priorKey !== key) throw new Error(`Telemetry sequence conflict: ${sequenceKey}`);
    sequences.set(sequenceKey, key);
    accepted.set(key, item);
  }
  const sorted = [...accepted.values()].sort((left, right) => left.sequence - right.sequence);
  return {
    events: sorted.filter((item): item is RunTelemetryEvent => item.schemaVersion === "openpond.runTelemetryEvent.v1"),
    observations: sorted.filter((item): item is MetricObservation => item.schemaVersion === "openpond.metricObservation.v1"),
  };
}

function matchesOptionalSet<T>(values: readonly T[], candidate: T | null): boolean {
  return values.length === 0 || (candidate !== null && values.includes(candidate));
}

export function filterTelemetryCohort(input: {
  events: RunTelemetryEvent[];
  observations: MetricObservation[];
  cohort: TelemetryCohort;
}): { events: RunTelemetryEvent[]; observations: MetricObservation[] } {
  const cohort = TelemetryCohortSchema.parse(input.cohort);
  const lineageMatches = (lineage: RunTelemetryLineage): boolean =>
    matchesOptionalSet(cohort.checkpointIds, lineage.checkpointId)
    && matchesOptionalSet(cohort.steps, lineage.step)
    && matchesOptionalSet(cohort.scenarioIds, lineage.scenarioId)
    && matchesOptionalSet(cohort.rolloutGroupIds, lineage.rolloutGroupId)
    && matchesOptionalSet(cohort.attemptIds, lineage.attemptId);
  const attributeMatches = (values: Record<string, unknown>): boolean =>
    matchesOptionalSet(cohort.splits, typeof values.split === "string" ? values.split : null)
    && matchesOptionalSet(cohort.failureOwners, typeof values.failureOwner === "string" ? values.failureOwner : null)
    && matchesOptionalSet(cohort.graders, typeof values.grader === "string" ? values.grader : null)
    && (cohort.rewardEligible === null || values.rewardEligible === cohort.rewardEligible);
  return {
    events: input.events.filter((event) => lineageMatches(event.lineage) && attributeMatches(event.attributes)),
    observations: input.observations.filter((observation) => lineageMatches(observation.lineage) && attributeMatches(observation.dimensions)),
  };
}

export function deriveEvidenceCompleteness(input: {
  runId: string;
  events: RunTelemetryEvent[];
  expectedEventTypes: TelemetryEventType[];
}): z.infer<typeof EvidenceCompletenessSchema> {
  const events = input.events.filter((event) => event.lineage.runId === input.runId).sort((left, right) => left.sequence - right.sequence);
  const observed = [...new Set(events.map((event) => event.type))].sort();
  const missing = [...new Set(input.expectedEventTypes)].filter((type) => !observed.includes(type)).sort();
  const sequenceValues = [...new Set(events.map((event) => event.sequence))].sort((left, right) => left - right);
  const lastSequence = events.at(-1)?.sequence ?? null;
  const sequenceGaps: number[] = [];
  let expected = 0;
  for (const sequence of sequenceValues) {
    while (expected < sequence && sequenceGaps.length < 10_000) sequenceGaps.push(expected++);
    expected = sequence + 1;
  }
  return EvidenceCompletenessSchema.parse({
    schemaVersion: "openpond.telemetryEvidenceCompleteness.v1",
    runId: input.runId,
    status: events.length === 0 ? "missing" : missing.length || sequenceGaps.length ? "partial" : "complete",
    expectedEventTypes: [...new Set(input.expectedEventTypes)].sort(),
    observedEventTypes: observed,
    missingEventTypes: missing,
    lastSequence,
    sequenceGaps,
  });
}

function aggregate(values: number[], method: "last" | "sum" | "mean" | "min" | "max" | "p50" | "p95"): number | null {
  if (!values.length) return null;
  if (method === "last") return values.at(-1) ?? null;
  if (method === "sum") return values.reduce((total, value) => total + value, 0);
  if (method === "mean") return values.reduce((total, value) => total + value, 0) / values.length;
  if (method === "min") return Math.min(...values);
  if (method === "max") return Math.max(...values);
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = method === "p50" ? 0.5 : 0.95;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)] ?? null;
}

export function summarizeMetric(runId: string, metricId: string, observations: MetricObservation[]): z.infer<typeof RunMetricSummarySchema> {
  const definition = getCoreMetricDefinition(metricId);
  if (!definition) throw new Error(`Unknown core metric: ${metricId}`);
  const selected = observations.filter((item) => item.lineage.runId === runId && item.metricId === metricId).sort((left, right) => left.sequence - right.sequence);
  const buckets = new Map<string, MetricObservation[]>();
  for (const item of selected) {
    const key = item.lineage.step === null ? `time:${item.observedAt}` : `step:${item.lineage.step}`;
    buckets.set(key, [...(buckets.get(key) ?? []), item]);
  }
  const series = [...buckets.values()].map((items) => ({
    step: items[0]?.lineage.step ?? null,
    observedAt: items[0]?.observedAt,
    value: aggregate(items.map((item) => item.value), definition.aggregation),
    sampleCount: items.length,
  })).filter((point): point is { step: number | null; observedAt: string; value: number; sampleCount: number } => point.value !== null && point.observedAt !== undefined);
  return RunMetricSummarySchema.parse({ schemaVersion: "openpond.runMetricSummary.v1", runId, metricId, aggregation: definition.aggregation, value: aggregate(selected.map((item) => item.value), definition.aggregation), sampleCount: selected.length, series });
}

export function redactTelemetryEvent(event: RunTelemetryEvent, maximumVisibility: TelemetryVisibility): RunTelemetryEvent | null {
  const rank: Record<TelemetryVisibility, number> = { policy_visible: 0, team_visible: 1, host_private: 2 };
  if (rank[event.visibility] > rank[maximumVisibility]) return null;
  return RunTelemetryEventSchema.parse(event);
}

export function redactTelemetryAttributes(event: RunTelemetryEvent, deniedKeys: readonly string[]): RunTelemetryEvent {
  const denied = new Set(deniedKeys);
  return RunTelemetryEventSchema.parse({
    ...event,
    attributes: Object.fromEntries(Object.entries(event.attributes).filter(([key]) => !denied.has(key))),
  });
}
