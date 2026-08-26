import { z } from "zod";

import { ReleaseHashSchema, ReleaseIdSchema, ReleaseTimestampSchema, contentHash } from "@openpond/harness";

import { MetricCatalogSchema } from "./telemetry-catalog.js";
import { deriveEvidenceCompleteness, EvidenceCompletenessSchema, EvidenceReferenceSchema, redactTelemetryAttributes, redactTelemetryEvent } from "./telemetry-analysis.js";
import { MetricObservationSchema, RunTelemetryEventSchema, type TelemetryVisibility } from "./telemetry.js";

export const TelemetryExportBundleContentSchema = z.object({
  schemaVersion: z.literal("openpond.telemetryExportBundle.v1"),
  id: ReleaseIdSchema,
  runId: ReleaseIdSchema,
  exportedAt: ReleaseTimestampSchema,
  definitions: MetricCatalogSchema,
  events: z.array(RunTelemetryEventSchema).max(1_000_000),
  observations: z.array(MetricObservationSchema).max(10_000_000),
  evidenceRefs: z.array(EvidenceReferenceSchema).max(1_000_000),
  completeness: EvidenceCompletenessSchema,
}).strict();

export const TelemetryExportBundleSchema = TelemetryExportBundleContentSchema.extend({
  contentHash: ReleaseHashSchema,
}).strict();

export function createTelemetryExportBundle(input: z.input<typeof TelemetryExportBundleContentSchema>): z.infer<typeof TelemetryExportBundleSchema> {
  const content = TelemetryExportBundleContentSchema.parse(input);
  if (content.completeness.runId !== content.runId) {
    throw new Error("Telemetry export completeness belongs to another Run.");
  }
  if (content.events.some((event) => event.lineage.runId !== content.runId) || content.observations.some((observation) => observation.lineage.runId !== content.runId)) {
    throw new Error("Telemetry export bundle contains evidence from another Run.");
  }
  return TelemetryExportBundleSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function verifyTelemetryExportBundle(input: unknown): boolean {
  const parsed = TelemetryExportBundleSchema.safeParse(input);
  if (!parsed.success) return false;
  const { contentHash: actual, ...content } = parsed.data;
  return contentHash(TelemetryExportBundleContentSchema.parse(content)) === actual;
}

export function redactTelemetryExportBundle(input: {
  bundle: z.infer<typeof TelemetryExportBundleSchema>;
  maximumVisibility: TelemetryVisibility;
  deniedAttributeKeys?: string[];
  id: string;
  exportedAt: string;
}): z.infer<typeof TelemetryExportBundleSchema> {
  const bundle = TelemetryExportBundleSchema.parse(input.bundle);
  if (!verifyTelemetryExportBundle(bundle)) throw new Error("Telemetry export bundle has an invalid content hash.");
  const rank: Record<TelemetryVisibility, number> = { policy_visible: 0, team_visible: 1, host_private: 2 };
  const definitions = bundle.definitions.filter((definition) => rank[definition.visibility] <= rank[input.maximumVisibility]);
  const metricIds = new Set(definitions.map((definition) => definition.id));
  const events = bundle.events.flatMap((event) => {
    const visible = redactTelemetryEvent(event, input.maximumVisibility);
    return visible ? [redactTelemetryAttributes(visible, input.deniedAttributeKeys ?? [])] : [];
  });
  const expectedEventTypes = bundle.completeness.expectedEventTypes.filter((type) => events.some((event) => event.type === type));
  return createTelemetryExportBundle({
    schemaVersion: "openpond.telemetryExportBundle.v1",
    id: input.id,
    runId: bundle.runId,
    exportedAt: input.exportedAt,
    definitions,
    events,
    observations: bundle.observations.filter((observation) => metricIds.has(observation.metricId)),
    evidenceRefs: bundle.evidenceRefs.filter((reference) => rank[reference.visibility] <= rank[input.maximumVisibility]),
    completeness: deriveEvidenceCompleteness({ runId: bundle.runId, events, expectedEventTypes: expectedEventTypes as z.infer<typeof RunTelemetryEventSchema>["type"][] }),
  });
}
