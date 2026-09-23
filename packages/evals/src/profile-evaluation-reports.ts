import { z } from "zod";

import {
  ImmutableReleaseRefSchema, ReleaseHashSchema, ReleaseIdSchema,
  ReleaseTimestampSchema, contentHash,
} from "@openpond/harness";

const TestedSourceSchema = z.object({
  profileId: ReleaseIdSchema,
  sourceRevision: z.string().trim().min(1).max(240),
  harnessRelease: ImmutableReleaseRefSchema,
}).strict();

const EvidenceSchema = z.object({
  kind: z.enum(["run", "suite", "comparison"]),
  id: ReleaseIdSchema,
  contentHash: ReleaseHashSchema,
}).strict();

/** Portable summary only. Private cases, outputs, traces, and credentials stay
 * with the installation's retained evidence, outside Profile source. */
export const ProfileEvaluationReportContentSchema = z.object({
  schemaVersion: z.literal("openpond.profileEvaluationReport.v1"),
  id: ReleaseIdSchema,
  createdAt: ReleaseTimestampSchema,
  testedSources: z.array(TestedSourceSchema).min(1).max(100),
  tasksetReleases: z.array(ImmutableReleaseRefSchema).min(1).max(100),
  metricPolicyHashes: z.array(ReleaseHashSchema).min(1).max(100),
  modelConfigurationHashes: z.array(ReleaseHashSchema).min(1).max(100),
  evidence: z.array(EvidenceSchema).min(1).max(100),
  summary: z.object({
    totalChecks: z.number().int().nonnegative(),
    passedChecks: z.number().int().nonnegative(),
    failedChecks: z.number().int().nonnegative(),
    unscoredChecks: z.number().int().nonnegative(),
    meanScore: z.number().min(0).max(1).nullable(),
  }).strict(),
}).strict().superRefine((report, context) => {
  const { summary } = report;
  if (summary.passedChecks + summary.failedChecks + summary.unscoredChecks !== summary.totalChecks) {
    context.addIssue({ code: "custom", path: ["summary"], message: "Report check counts must add up." });
  }
  if (new Set(report.evidence.map(({ kind, id }) => `${kind}:${id}`)).size !== report.evidence.length) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Report evidence must be unique." });
  }
});

export const ProfileEvaluationReportSchema = ProfileEvaluationReportContentSchema.safeExtend({
  contentHash: ReleaseHashSchema,
});
export type ProfileEvaluationReport = z.infer<typeof ProfileEvaluationReportSchema>;

export function createProfileEvaluationReport(input: z.input<typeof ProfileEvaluationReportContentSchema>): ProfileEvaluationReport {
  const content = ProfileEvaluationReportContentSchema.parse(input);
  return ProfileEvaluationReportSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function assertProfileEvaluationReport(value: unknown): ProfileEvaluationReport {
  const report = ProfileEvaluationReportSchema.parse(value);
  const { contentHash: expected, ...content } = report;
  if (contentHash(content) !== expected) throw new Error("Profile evaluation report content hash differs from its source bytes.");
  return report;
}
