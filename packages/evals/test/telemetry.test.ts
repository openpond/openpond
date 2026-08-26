import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  MetricDefinitionSchema,
  MetricObservationSchema,
  RunTelemetryBatchSchema,
  RunTelemetryEventSchema,
} from "../src/telemetry.js";

const hash = "a".repeat(64);
const lineage = {
  modelProjectId: "project-1",
  runId: "run-1",
  modelVersionId: "version-1",
  harnessReleaseHash: hash,
  tasksetReleaseHash: hash,
  environmentReleaseHash: null,
  checkpointId: null,
  step: 1,
  rolloutGroupId: "group-1",
  attemptId: null,
  scenarioId: "scenario-1",
};

describe("portable telemetry", () => {
  it("shares positive and negative conformance fixtures", () => {
    const fixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(
      new URL(`../conformance/telemetry/v1/${name}`, import.meta.url),
    ), "utf8"));
    expect(RunTelemetryBatchSchema.safeParse(fixture("valid-batch.json")).success).toBe(true);
    expect(RunTelemetryBatchSchema.safeParse(fixture("invalid-batch.json")).success).toBe(false);
  });

  it("validates an event, definition, observation, and batch", () => {
    const event = RunTelemetryEventSchema.parse({
      schemaVersion: "openpond.runTelemetryEvent.v1",
      eventId: "event-1",
      sequence: 1,
      occurredAt: "2026-08-25T20:00:00.000Z",
      source: "optimizer",
      type: "optimizer_step_completed",
      visibility: "team_visible",
      lineage,
      attributes: { learningRate: 0.00001 },
    });
    MetricDefinitionSchema.parse({
      schemaVersion: "openpond.metricDefinition.v1",
      id: "optimizer.learning_rate",
      displayName: "Learning rate",
      description: "Optimizer learning rate after the step.",
      valueType: "gauge",
      unit: "scalar",
      direction: "neutral",
      aggregation: "last",
      visibility: "team_visible",
      boundedDimensions: ["split"],
    });
    const observation = MetricObservationSchema.parse({
      schemaVersion: "openpond.metricObservation.v1",
      observationId: "observation-1",
      metricId: "optimizer.learning_rate",
      eventId: event.eventId,
      sequence: 2,
      observedAt: event.occurredAt,
      value: 0.00001,
      lineage,
      dimensions: { split: "train" },
    });
    expect(RunTelemetryBatchSchema.parse({
      schemaVersion: "openpond.runTelemetryBatch.v1",
      events: [event],
      observations: [observation],
    }).observations).toHaveLength(1);
  });

  it("rejects unbounded attributes and duplicate batch keys", () => {
    expect(RunTelemetryEventSchema.safeParse({
      schemaVersion: "openpond.runTelemetryEvent.v1",
      eventId: "event-1",
      sequence: 1,
      occurredAt: "not-a-time",
      source: "optimizer",
      type: "optimizer_step_completed",
      visibility: "team_visible",
      lineage,
      attributes: { nested: { unsupported: true } },
    }).success).toBe(false);
  });
});
