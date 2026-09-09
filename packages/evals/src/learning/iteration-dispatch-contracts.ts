import { z } from "zod";
import { contentHash, ImmutableReleaseRefSchema, ReleaseIdSchema, ReleaseTimestampSchema } from "@openpond/harness";
import { LearningJsonObjectSchema, LearningRevisionRefSchema } from "./contracts.js";

/** The executor validates its protocol payload before returning this snapshot.
 * Credentials and expiring transport URLs belong to the executor, not payload. */
export const LearningIterationSubmissionSchema = z.object({
  provider: ReleaseIdSchema,
  protocol: ReleaseIdSchema,
  payload: LearningJsonObjectSchema,
}).strict();

export const LearningIterationDispatchSchema = z.object({
  schemaVersion: z.literal("openpond.learningIterationDispatch.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  iterationId: ReleaseIdSchema,
  chainId: ReleaseIdSchema,
  policy: LearningRevisionRefSchema,
  batch: LearningRevisionRefSchema,
  state: z.enum(["preparing", "prepared", "submitted", "settled", "blocked"]),
  submission: LearningIterationSubmissionSchema.nullable(),
  submissionHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  submissionStartedAt: ReleaseTimestampSchema.nullable(),
  execution: ImmutableReleaseRefSchema.nullable(),
  terminalReceipt: ImmutableReleaseRefSchema.nullable(),
  cancelRequestedAt: ReleaseTimestampSchema.nullable(),
  leaseOwner: ReleaseIdSchema.nullable(),
  leaseGeneration: z.number().int().nonnegative(),
  leaseExpiresAt: ReleaseTimestampSchema.nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  nextAttemptAt: ReleaseTimestampSchema.nullable(),
  lastError: z.string().max(20_000).nullable(),
  createdAt: ReleaseTimestampSchema,
  updatedAt: ReleaseTimestampSchema,
}).strict().superRefine((value, context) => {
  if (Boolean(value.submission) !== Boolean(value.submissionHash) || (value.submission && contentHash(value.submission) !== value.submissionHash)) {
    context.addIssue({ code: "custom", path: ["submissionHash"], message: "Dispatch submission identity changed." });
  }
  if (value.submissionStartedAt && !value.submission) context.addIssue({ code: "custom", path: ["submission"], message: "A started dispatch requires its persisted submission." });
  if (value.execution && !value.submissionStartedAt) context.addIssue({ code: "custom", path: ["execution"], message: "An execution requires a started dispatch." });
  if (["prepared", "submitted"].includes(value.state) && !value.submission) context.addIssue({ code: "custom", path: ["state"], message: "A prepared dispatch requires its immutable submission." });
  if (value.state === "submitted" && !value.execution) context.addIssue({ code: "custom", path: ["execution"], message: "A submitted dispatch requires an observed execution." });
  if (value.state === "settled" && value.submissionStartedAt && !value.terminalReceipt) context.addIssue({ code: "custom", path: ["terminalReceipt"], message: "A started dispatch requires terminal receipt evidence before settlement." });
  if (Boolean(value.leaseOwner) !== Boolean(value.leaseExpiresAt)) context.addIssue({ code: "custom", path: ["leaseOwner"], message: "Dispatch lease owner and expiration must be recorded together." });
});

/** Terminal cleanup includes fencing future submission under this dispatch ID.
 * The execution adapter verifies its authoritative provider receipt. */
export const LearningIterationObservationSchema = z.object({
  scope: ReleaseIdSchema,
  dispatchId: ReleaseIdSchema,
  submissionHash: z.string().regex(/^[a-f0-9]{64}$/),
  execution: ImmutableReleaseRefSchema.nullable(),
  status: z.enum(["running", "evaluating", "succeeded", "failed", "cancelled"]),
  spendUsd: z.number().nonnegative(),
  cleanupComplete: z.boolean(),
  receipt: ImmutableReleaseRefSchema.nullable(),
  evaluation: ImmutableReleaseRefSchema.nullable(),
  candidate: ImmutableReleaseRefSchema.nullable(),
  failure: z.string().max(20_000).nullable(),
}).strict().superRefine((value, context) => {
  if (["succeeded", "failed", "cancelled"].includes(value.status) && (!value.cleanupComplete || !value.receipt)) {
    context.addIssue({ code: "custom", path: ["receipt"], message: "Terminal execution requires an authoritative cleanup receipt." });
  }
  if (value.status !== "cancelled" && !value.execution) context.addIssue({ code: "custom", path: ["execution"], message: "The execution identity is required." });
  if (value.candidate && (value.status !== "succeeded" || !value.evaluation)) context.addIssue({ code: "custom", path: ["candidate"], message: "A candidate requires successful retained evaluation." });
});

export type LearningIterationSubmission = z.infer<typeof LearningIterationSubmissionSchema>;
export type LearningIterationDispatch = z.infer<typeof LearningIterationDispatchSchema>;
export type LearningIterationObservation = z.infer<typeof LearningIterationObservationSchema>;
