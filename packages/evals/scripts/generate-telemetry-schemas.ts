#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  MetricDefinitionSchema,
  MetricObservationSchema,
  RunTelemetryBatchSchema,
  RunTelemetryEventSchema,
} from "../src/telemetry.js";
import {
  EvidenceCompletenessSchema,
  EvidenceReferenceSchema,
  RunMetricSummarySchema,
  TelemetryCohortSchema,
} from "../src/telemetry-analysis.js";
import { TelemetryExportBundleSchema } from "../src/telemetry-bundle.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "schemas", "telemetry", "v1");
await mkdir(target, { recursive: true });

for (const [name, schema] of Object.entries({
  "run-telemetry-event": RunTelemetryEventSchema,
  "metric-definition": MetricDefinitionSchema,
  "metric-observation": MetricObservationSchema,
  "run-telemetry-batch": RunTelemetryBatchSchema,
  "telemetry-cohort": TelemetryCohortSchema,
  "evidence-reference": EvidenceReferenceSchema,
  "evidence-completeness": EvidenceCompletenessSchema,
  "run-metric-summary": RunMetricSummarySchema,
  "telemetry-export-bundle": TelemetryExportBundleSchema,
})) {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-7",
    unrepresentable: "any",
  });
  await writeFile(
    path.join(target, `${name}.schema.json`),
    `${JSON.stringify(jsonSchema, null, 2)}\n`,
    "utf8",
  );
}
