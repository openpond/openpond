import { z } from "zod";

import { canonicalJson, contentHash } from "./hash.js";
import { ContinualBenchEfficiencyMetricSchema, ContinualBenchOutcomeSchema, ContinualBenchTaskMetricSchema } from "./metrics.js";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);

export const ContinualBenchReportPointSchema = z.object({
  id: Id,
  label: z.string().trim().min(1).max(500),
  kind: z.enum(["candidate", "accepted_head", "base", "master", "external_reference"]),
  ordinal: z.number().int().nonnegative().nullable(),
  meanScore: z.number().finite().nullable(),
  confidenceInterval: z.tuple([z.number().finite(), z.number().finite()]).nullable(),
  taskMetrics: z.array(ContinualBenchTaskMetricSchema).max(1_000_000),
  efficiency: ContinualBenchEfficiencyMetricSchema.nullable(),
  evidenceUrl: z.string().url().nullable(),
}).strict();

export const ContinualBenchPortableReportSchema = z.object({
  schemaVersion: z.literal("openpond.continualBenchReport.v1"),
  seriesId: Id,
  protocol: z.object({ id: Id, revision: z.number().int().positive(), contentHash: Hash }).strict(),
  generatedAt: z.string().datetime({ offset: true }),
  status: z.enum(["partial", "terminal"]),
  points: z.array(ContinualBenchReportPointSchema).min(1).max(10_000),
  outcomes: z.array(ContinualBenchOutcomeSchema).max(7),
  audit: z.array(z.object({ requirement: Id, status: z.enum(["passed", "failed", "unavailable"]), evidenceRefs: z.array(Id).max(100_000) }).strict()).max(10_000),
  chart: z.object({
    x: z.literal("ordinal"),
    y: z.literal("meanScore"),
    series: z.array(z.object({ pointId: Id, label: z.string(), ordinal: z.number().nullable(), value: z.number().nullable(), lower: z.number().nullable(), upper: z.number().nullable(), kind: z.string() }).strict()),
  }).strict(),
  contentHash: Hash,
}).strict();

export type ContinualBenchReportPoint = z.infer<typeof ContinualBenchReportPointSchema>;
export type ContinualBenchPortableReport = z.infer<typeof ContinualBenchPortableReportSchema>;

export function createContinualBenchReport(input: Omit<ContinualBenchPortableReport, "contentHash" | "chart">): ContinualBenchPortableReport {
  const chart = {
    x: "ordinal" as const,
    y: "meanScore" as const,
    series: input.points.map((point) => ({
      pointId: point.id,
      label: point.label,
      ordinal: point.ordinal,
      value: point.meanScore,
      lower: point.confidenceInterval?.[0] ?? null,
      upper: point.confidenceInterval?.[1] ?? null,
      kind: point.kind,
    })),
  };
  const unsealed = { ...input, chart };
  return ContinualBenchPortableReportSchema.parse({ ...unsealed, contentHash: contentHash(unsealed) });
}

export function exportContinualBenchReport(report: ContinualBenchPortableReport): string {
  const parsed = ContinualBenchPortableReportSchema.parse(report);
  const { contentHash: declared, ...unsealed } = parsed;
  if (declared !== contentHash(unsealed)) throw new Error("Continual Bench report content hash does not match its payload.");
  return canonicalJson(parsed);
}
