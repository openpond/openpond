import { z } from "zod";
import { ReleaseHashSchema, ReleaseIdSchema, ReleaseTimestampSchema } from "@openpond/harness";

import { LearningAcceptedParentSchema, LearningRevisionRefSchema } from "./contracts.js";

export const LearningIterationTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual"), identity: ReleaseIdSchema }).strict(),
  z.object({ kind: z.literal("schedule"), scheduledAt: ReleaseTimestampSchema }).strict(),
  z.object({ kind: z.literal("approved_count"), checkedAt: ReleaseTimestampSchema }).strict(),
]);

/** Stable across policy edits: a Model owns one learning chain in its scope. */
export const LearningChainSchema = z.object({
  schemaVersion: z.literal("openpond.learningChain.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  modelProjectId: ReleaseIdSchema,
  activeIterationId: ReleaseIdSchema.nullable(),
  acceptedParent: LearningAcceptedParentSchema.nullable().optional(),
  latestIterationId: ReleaseIdSchema,
  lastReservedAt: ReleaseTimestampSchema.nullable(),
  updatedAt: ReleaseTimestampSchema,
}).strict();

export const LearningEligibilityCountsSchema = z.object({
  eligible: z.number().int().nonnegative(),
  awaitingReview: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  consumed: z.number().int().nonnegative(),
}).strict();

/** Immutable evidence consumption survives rejection and policy revision changes.
 * A corrected evidence revision is new data; reapproving the same revision isn't. */
export const LearningConsumptionSchema = z.object({
  schemaVersion: z.literal("openpond.learningConsumption.v1"),
  id: ReleaseIdSchema,
  revision: z.literal(1),
  chainId: ReleaseIdSchema,
  iterationId: ReleaseIdSchema,
  evidence: LearningRevisionRefSchema,
  decision: LearningRevisionRefSchema,
  reservedAt: ReleaseTimestampSchema,
}).strict();

/** Dispatch must reconcile this reservation, never reserve a second batch on retry. */
export const LearningIterationReservationSchema = z.object({
  schemaVersion: z.literal("openpond.learningIterationReservation.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  chainId: ReleaseIdSchema,
  iterationId: ReleaseIdSchema,
  policy: LearningRevisionRefSchema,
  trigger: LearningIterationTriggerSchema,
  requestHash: ReleaseHashSchema,
  outcome: z.enum(["reserved", "waiting_for_data", "waiting_for_review"]),
  counts: LearningEligibilityCountsSchema,
  budget: z.object({
    maximumSpendUsd: z.number().nonnegative(),
    reservedSpendUsd: z.number().nonnegative(),
    settledSpendUsd: z.number().nonnegative(),
    settledAt: ReleaseTimestampSchema.nullable(),
  }).strict(),
  createdAt: ReleaseTimestampSchema,
  updatedAt: ReleaseTimestampSchema,
}).strict();

export type LearningChain = z.infer<typeof LearningChainSchema>;
export type LearningConsumption = z.infer<typeof LearningConsumptionSchema>;
export type LearningIterationReservation = z.infer<typeof LearningIterationReservationSchema>;
export type LearningIterationTrigger = z.infer<typeof LearningIterationTriggerSchema>;
