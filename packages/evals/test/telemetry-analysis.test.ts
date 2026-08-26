import { describe, expect, it } from "vitest";

import { CORE_METRIC_CATALOG, validateCoreMetricObservation } from "../src/telemetry-catalog.js";
import {
  createMetricObservation,
  createRunTelemetryEvent,
  deriveEvidenceCompleteness,
  filterTelemetryCohort,
  mergeTelemetryItems,
  summarizeMetric,
  telemetryIdempotencyKey,
} from "../src/telemetry-analysis.js";
import { createTelemetryExportBundle, redactTelemetryExportBundle, verifyTelemetryExportBundle } from "../src/telemetry-bundle.js";

const hash = "a".repeat(64);
const lineage = {
  modelProjectId: "project-1",
  runId: "run-1",
  modelVersionId: "version-1",
  harnessReleaseHash: hash,
  tasksetReleaseHash: hash,
  environmentReleaseHash: null,
  checkpointId: "checkpoint-1",
  step: 1,
  rolloutGroupId: "group-1",
  attemptId: null,
  scenarioId: "scenario-1",
};

describe("telemetry analysis", () => {
  it("builds stable ids and rejects unknown metrics or dimensions", () => {
    const event = createRunTelemetryEvent({ sequence: 0, occurredAt: "2026-08-25T20:00:00.000Z", source: "optimizer", type: "optimizer_step_completed", visibility: "team_visible", lineage });
    const repeated = createRunTelemetryEvent({ sequence: 0, occurredAt: "2026-08-25T20:01:00.000Z", source: "optimizer", type: "optimizer_step_completed", visibility: "team_visible", lineage });
    expect(event.eventId).toBe(repeated.eventId);
    expect(telemetryIdempotencyKey(event)).toContain("run-1:0:");
    expect(() => createMetricObservation({ metricId: "unknown", eventId: event.eventId, sequence: 1, observedAt: event.occurredAt, value: 1, lineage })).toThrow("Unknown metric");
    const observation = createMetricObservation({ metricId: "optimizer.loss", eventId: event.eventId, sequence: 1, observedAt: event.occurredAt, value: 0.5, lineage, dimensions: { split: "train" } });
    expect(() => validateCoreMetricObservation({ ...observation, dimensions: { arbitrary: "value" } })).toThrow("unsupported dimensions");
  });

  it("derives completeness and chart-ready summaries", () => {
    const event = createRunTelemetryEvent({ sequence: 0, occurredAt: "2026-08-25T20:00:00.000Z", source: "optimizer", type: "optimizer_step_completed", visibility: "team_visible", lineage });
    const observations = [0.5, 0.7].map((value, index) => createMetricObservation({ metricId: "optimizer.loss", eventId: event.eventId, sequence: index + 1, observedAt: event.occurredAt, value, lineage, dimensions: { split: "train" } }));
    expect(summarizeMetric("run-1", "optimizer.loss", observations)).toMatchObject({ value: 0.6, sampleCount: 2 });
    expect(deriveEvidenceCompleteness({ runId: "run-1", events: [event], expectedEventTypes: ["run_started", "optimizer_step_completed"] })).toMatchObject({ status: "partial", missingEventTypes: ["run_started"] });
  });

  it("deduplicates retries and sorts late delivery without hiding conflicts", () => {
    const late = createRunTelemetryEvent({ sequence: 2, occurredAt: "2026-08-25T20:02:00.000Z", source: "control_plane", type: "run_state_changed", visibility: "team_visible", lineage });
    const early = createRunTelemetryEvent({ sequence: 0, occurredAt: "2026-08-25T20:00:00.000Z", source: "control_plane", type: "run_started", visibility: "team_visible", lineage });
    expect(mergeTelemetryItems({ events: [late, early, late], observations: [] }).events.map((event) => event.sequence)).toEqual([0, 2]);
    expect(() => mergeTelemetryItems({ events: [late, { ...late, attributes: { changed: true } }], observations: [] })).toThrow("idempotency conflict");
  });

  it("filters portable cohorts without hosted query semantics", () => {
    const event = createRunTelemetryEvent({ sequence: 0, occurredAt: "2026-08-25T20:00:00.000Z", source: "grader", type: "grader_completed", visibility: "team_visible", lineage, attributes: { split: "train", grader: "visual" } });
    const cohort = { checkpointIds: [], steps: [1], scenarioIds: [], rolloutGroupIds: [], attemptIds: [], splits: ["train"], failureOwners: [], graders: ["visual"], rewardEligible: null };
    expect(filterTelemetryCohort({ events: [event], observations: [], cohort }).events).toHaveLength(1);
    expect(filterTelemetryCohort({ events: [event], observations: [], cohort: { ...cohort, splits: ["eval"] } }).events).toHaveLength(0);
  });

  it("creates a hash-verifiable portable export bundle", () => {
    const event = createRunTelemetryEvent({ sequence: 0, occurredAt: "2026-08-25T20:00:00.000Z", source: "control_plane", type: "run_started", visibility: "team_visible", lineage, attributes: { safe: true, secret: "no" } });
    const completeness = deriveEvidenceCompleteness({ runId: "run-1", events: [event], expectedEventTypes: ["run_started"] });
    const bundle = createTelemetryExportBundle({ schemaVersion: "openpond.telemetryExportBundle.v1", id: "bundle-1", runId: "run-1", exportedAt: "2026-08-25T20:01:00.000Z", definitions: [...CORE_METRIC_CATALOG], events: [event], observations: [], evidenceRefs: [], completeness });
    expect(verifyTelemetryExportBundle(bundle)).toBe(true);
    expect(verifyTelemetryExportBundle({ ...bundle, runId: "run-2" })).toBe(false);
    const redacted = redactTelemetryExportBundle({ bundle, maximumVisibility: "team_visible", deniedAttributeKeys: ["secret"], id: "bundle-redacted", exportedAt: "2026-08-25T20:02:00.000Z" });
    expect(redacted.events[0]?.attributes).toEqual({ safe: true });
  });
});
