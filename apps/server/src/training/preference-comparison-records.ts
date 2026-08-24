import { z } from "zod";

import {
  ComparisonAssignmentSchema,
  PreferenceCalibrationReportSchema,
  PreferenceComparisonReleaseSchema,
  PreferenceReceiptSchema,
} from "@openpond/evals/preferences";

const IdSchema = z.string().trim().min(1).max(500);
const TimestampSchema = z.iso.datetime({ offset: true });

export const PreferenceComparisonReleaseRecordSchema = z.object({
  schemaVersion: z.literal("openpond.preferenceComparisonReleaseRecord.v1"),
  id: IdSchema,
  tasksetId: IdSchema,
  release: PreferenceComparisonReleaseSchema,
  publishedBy: IdSchema,
  sourceConsent: z.enum(["authorized", "revoked"]),
  retentionUntil: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
}).strict();

export const PreferenceComparisonAssignmentRecordSchema = z.object({
  schemaVersion: z.literal("openpond.preferenceComparisonAssignmentRecord.v1"),
  id: IdSchema,
  tasksetId: IdSchema,
  assignment: ComparisonAssignmentSchema,
  state: z.enum(["queued", "in_review", "submitted", "unreviewable", "revoked"]),
  reviewerKey: IdSchema.nullable(),
  unreviewableReason: z.string().trim().min(1).max(2_000).nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((record, context) => {
  if (record.state === "unreviewable" && !record.unreviewableReason) {
    context.addIssue({ code: "custom", path: ["unreviewableReason"], message: "Unreviewable assignments require a reason." });
  }
  if (record.state !== "unreviewable" && record.unreviewableReason) {
    context.addIssue({ code: "custom", path: ["unreviewableReason"], message: "Only unreviewable assignments may retain a reason." });
  }
});

export const PreferenceComparisonSubmissionRecordSchema = z.object({
  schemaVersion: z.literal("openpond.preferenceComparisonSubmissionRecord.v1"),
  id: IdSchema,
  tasksetId: IdSchema,
  assignmentId: IdSchema,
  reviewerKey: IdSchema,
  receipt: PreferenceReceiptSchema,
  submittedAt: TimestampSchema,
}).strict();

export const PreferenceComparisonCalibrationRecordSchema = z.object({
  schemaVersion: z.literal("openpond.preferenceComparisonCalibrationRecord.v1"),
  id: IdSchema,
  tasksetId: IdSchema,
  report: PreferenceCalibrationReportSchema,
  createdAt: TimestampSchema,
}).strict();

export type PreferenceComparisonReleaseRecord = z.infer<typeof PreferenceComparisonReleaseRecordSchema>;
export type PreferenceComparisonAssignmentRecord = z.infer<typeof PreferenceComparisonAssignmentRecordSchema>;
export type PreferenceComparisonSubmissionRecord = z.infer<typeof PreferenceComparisonSubmissionRecordSchema>;
export type PreferenceComparisonCalibrationRecord = z.infer<typeof PreferenceComparisonCalibrationRecordSchema>;
